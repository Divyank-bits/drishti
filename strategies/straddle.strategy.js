/**
 * @file straddle.strategy.js
 * @description Short Straddle strategy — sells ATM CE and ATM PE at the same strike.
 *              Profits from rapid time decay when the market stays near the strike.
 *              Suited for high-IV, mean-reverting regimes (IV Percentile > 70%,
 *              VIX 18–25, RSI 45–55).
 *              Extends BaseStrategy. Auto-registered by registry.js.
 */
'use strict';

const BaseStrategy     = require('./base.strategy');
const eventBus         = require('../core/event-bus');
const EVENTS           = require('../core/events');
const CircuitBreaker   = require('../core/circuit-breaker');
const StateMachine     = require('../core/state-machine');
const SessionContext   = require('../core/session-context');
const config           = require('../config');
const holidays         = require('../holidays.json');
const strategySelector = require('../intelligence/strategy-selector');

const circuitBreaker = new CircuitBreaker();
const stateMachine   = new StateMachine();
const sessionContext = new SessionContext();

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [Straddle] [${level}] ${msg}`);
}

function toIST(tsMs) {
  const istMs  = tsMs + 5.5 * 3600 * 1000;
  const hour   = Math.floor((istMs % (24 * 3600000)) / 3600000);
  const minute = Math.floor((istMs % 3600000) / 60000);
  return { hour, minute };
}

/**
 * Finds the ATM strike — nearest 50-point interval to current spot.
 * @param {number} spot
 * @returns {number}
 */
function nearestAtmStrike(spot) {
  return Math.round(spot / 50) * 50;
}

class StraddleStrategy extends BaseStrategy {
  constructor() {
    super();
    this._cachedIndicators = null;
    this._cachedOptions    = null;
    this._bbWidthHistory   = [];
    this._candles15m       = [];
    this._paused           = false;
    this._evaluating       = false;

    eventBus.on(EVENTS.CANDLE_CLOSE_15M, (candle) => {
      this._candles15m.push(candle);
      if (this._candles15m.length > 20) this._candles15m.shift();
    });

    eventBus.on(EVENTS.INDICATORS_UPDATED, (payload) => {
      if (payload.timeframe !== 15) return;
      this._cachedIndicators = payload.indicators;
      if (payload.indicators.bb?.width != null) {
        this._bbWidthHistory.push(payload.indicators.bb.width);
        if (this._bbWidthHistory.length > 20) this._bbWidthHistory.shift();
      }
      this._tryEvaluate(Date.now());
    });

    eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED, (payload) => {
      this._cachedOptions = payload;
      this._tryEvaluate(Date.now());
    });

    eventBus.on(EVENTS.PAUSE_REQUESTED,  () => { this._paused = true;  });
    eventBus.on(EVENTS.RESUME_REQUESTED, () => { this._paused = false; });
  }

  // ── Identity ────────────────────────────────────────────────────────────────

  get name() { return 'Straddle'; }

  get regime() { return ['B']; }

  get claudeDescription() {
    return 'Neutral high-IV strategy. Sells ATM call and ATM put at the same strike. ' +
           'Profits from rapid time decay when the underlying stays near the sold strike. ' +
           'Best after event-driven IV spikes when the market is expected to mean-revert. ' +
           'High risk if the underlying makes a large directional move.';
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _tryEvaluate(timestamp) {
    if (!this._cachedIndicators || !this._cachedOptions) return;
    if (this._paused) return;
    if (circuitBreaker.isTripped()) return;
    if (stateMachine.getCurrentState() !== 'IDLE') return;
    if (this._evaluating) return;

    const snap = {
      indicators:     this._cachedIndicators,
      bbWidthHistory: [...this._bbWidthHistory],
      optionsChain:   this._cachedOptions,
      sessionContext:  sessionContext.snapshot(),
      timestamp,
    };

    const conditionsResult = this.checkConditions(snap);

    const mode = (config.INTELLIGENCE_MODE || 'HYBRID').toUpperCase();
    if (mode === 'RULES' && !conditionsResult.eligible) {
      log('DEBUG', `Entry conditions not met: ${conditionsResult.failedConditions.join(', ')}`);
      return;
    }

    const trade = this.buildTrade(snap);

    const signalPayload = {
      strategy:          this.name,
      strikes:           trade.strikes,
      legs:              trade.legs,
      indicatorSnapshot: snap.indicators,
      optionsSnapshot:   {
        vix:       snap.optionsChain.vix,
        pcr:       snap.optionsChain.pcr,
        atmStrike: snap.optionsChain.atmStrike,
      },
      expectedPremium:   trade.expectedPremium,
      timestamp:         new Date().toISOString(),
    };

    this._evaluating = true;
    strategySelector.select(conditionsResult, signalPayload, snap.sessionContext, [...this._candles15m])
      .then((decision) => {
        this._evaluating = false;

        if (!decision.approved) {
          log('INFO', `Signal discarded [${decision.mode}]: ${decision.reasoning}`);
          eventBus.emit(EVENTS.SIGNAL_DISCARDED, {
            strategy: this.name,
            strikes:  trade.strikes,
            reason:   decision.reasoning,
            mode:     decision.mode,
          });
          return;
        }

        stateMachine.transition('SIGNAL_DETECTED');
        eventBus.emit(EVENTS.SIGNAL_GENERATED, {
          ...signalPayload,
          intelligenceMode: decision.mode,
          confidence:       decision.confidence,
          reasoning:        decision.reasoning,
        });
        log('INFO', `Signal generated [${decision.mode}] confidence=${decision.confidence.toFixed(2)}: Straddle ATM=${trade.strikes.atm}`);
      })
      .catch((err) => {
        this._evaluating = false;
        log('ERROR', `Strategy selector error: ${err.message}`);
      });
  }

  // ── Core Interface ──────────────────────────────────────────────────────────

  /**
   * Evaluates Straddle entry conditions (8 checks).
   * Pure function — no side effects.
   *
   * @param {object} marketData
   * @returns {{ eligible: boolean, score: number, failedConditions: string[] }}
   */
  checkConditions(marketData) {
    const {
      indicators,
      bbWidthHistory,
      optionsChain,
      sessionContext: ctx,
      timestamp,
      _isHolidayOverride,
    } = marketData;

    const failed = [];
    const TOTAL  = 8;

    // ── 1. VIX 18–25 (elevated but not panic) ────────────────────────────────
    const vix = optionsChain.vix ?? ctx.vixCurrent;
    if (vix == null || vix < 18 || vix > config.VIX_DANGER) failed.push('vix');

    // ── 2. IV Percentile proxy > 70% (high IV rank — premium is rich) ─────────
    const bbWidth = indicators.bb?.width;
    if (bbWidthHistory.length >= 5 && bbWidth != null) {
      const histMax  = Math.max(...bbWidthHistory);
      const histMin  = Math.min(...bbWidthHistory);
      const hasSpread = (histMax - histMin) >= 0.5;
      if (hasSpread) {
        const countBelow = bbWidthHistory.filter(w => w < bbWidth).length;
        const percentile = (countBelow / bbWidthHistory.length) * 100;
        if (percentile < 70) failed.push('ivPercentile');
      }
    } else {
      // Not enough history to confirm — skip this candle
      failed.push('ivPercentile');
    }

    // ── 3. RSI 45–55 (market neutral — no strong trend) ───────────────────────
    const { rsi } = indicators;
    if (rsi == null || rsi < 45 || rsi > 55) failed.push('rsi');

    // ── 4. EMA9 and EMA21 within 0.3% (no strong trend) ──────────────────────
    const { ema9, ema21 } = indicators;
    if (ema9 == null || ema21 == null) {
      failed.push('emaSpread');
    } else {
      const spread = Math.abs(ema9 - ema21) / ema21;
      if (spread > 0.003) failed.push('emaSpread');
    }

    // ── 5. MACD near zero (no momentum in either direction) ───────────────────
    const macdVal = indicators.macd?.macd;
    if (macdVal == null || Math.abs(macdVal) >= config.MACD_ZERO_THRESHOLD) {
      failed.push('macd');
    }

    // ── 6. PCR 0.8–1.2 (reasonably balanced OI — not extreme directional bet) ─
    const { pcr } = optionsChain;
    if (pcr == null || pcr < 0.8 || pcr > 1.2) failed.push('pcr');

    // ── 7. Time 09:30–13:00 IST (tighter window — theta works best mid-session) ─
    const { hour, minute } = toIST(timestamp);
    const afterOpen = hour > 9 || (hour === 9 && minute >= 30);
    const beforeCut = hour < 13;
    if (!afterOpen || !beforeCut) failed.push('timeWindow');

    // ── 8. Not a holiday / major event day ───────────────────────────────────
    if (_isHolidayOverride) {
      failed.push('eventDay');
    } else {
      const today     = new Date(timestamp).toISOString().slice(0, 10);
      const isHoliday = Array.isArray(holidays) && holidays.some(h => h.date === today);
      if (isHoliday) failed.push('eventDay');
    }

    return {
      eligible:         failed.length === 0,
      score:            Math.round(((TOTAL - failed.length) / TOTAL) * 100),
      failedConditions: failed,
    };
  }

  /**
   * Constructs the 2 Straddle legs at ATM strike.
   * Both CE and PE sold at the nearest 50-point interval to spot.
   *
   * @param {object} marketData
   * @returns {{ strikes, legs, expectedPremium, maxLoss, maxProfit, riskRewardRatio }}
   */
  buildTrade(marketData) {
    const { optionsChain } = marketData;
    const atm = nearestAtmStrike(optionsChain.underlyingValue);

    return {
      strikes: { atm },
      legs: [
        { type: 'CE', strike: atm, action: 'SELL' },
        { type: 'PE', strike: atm, action: 'SELL' },
      ],
      expectedPremium: null,
      maxLoss:         null,  // theoretically unlimited — managed by delta exit
      maxProfit:       null,  // total premium collected (calculated by executor)
      riskRewardRatio: null,
    };
  }

  /**
   * @param {object} marketData
   * @returns {string}
   */
  buildClaudePrompt(marketData) {
    return '';
  }

  /**
   * Returns exit conditions for an active Straddle.
   * Exit if either leg delta breaches ±0.45 or net premium erodes 60%.
   *
   * @param {object} trade
   * @returns {object}
   */
  getExitConditions(trade) {
    return {
      deltaCeThreshold:  0.45,
      deltaPeThreshold: -0.45,
      premiumErosionPct: 0.60,   // exit if net premium collected drops by 60%
      absolutePnlStop:   config.ABSOLUTE_PNL_STOP_RUPEES,
      squareOffTime:     config.SQUARE_OFF_TIME,
      exitTimeframe:     '15m',
    };
  }

  /**
   * Straddle requires both legs to fill — partial fill triggers rollback.
   * @returns {boolean} Always false
   */
  validatePartialFill(filledLegs) {
    return false;
  }
}

module.exports = new StraddleStrategy();
