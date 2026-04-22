/**
 * @file bear-call-spread.strategy.js
 * @description Bear Call Spread strategy — sells an OTM CE and buys a higher CE.
 *              Profits when NIFTY stays below the short call strike.
 *              Suited for mildly bearish, low-volatility regimes (VIX < 20,
 *              RSI < 50, NIFTY below EMA21, PCR < 1.0).
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
  console.log(`[${ts}] [BearCallSpread] [${level}] ${msg}`);
}

function toIST(tsMs) {
  const istMs  = tsMs + 5.5 * 3600 * 1000;
  const hour   = Math.floor((istMs % (24 * 3600000)) / 3600000);
  const minute = Math.floor((istMs % 3600000) / 60000);
  return { hour, minute };
}

class BearCallSpreadStrategy extends BaseStrategy {
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

  get name() { return 'Bear Call Spread'; }

  get regime() { return ['B', 'C']; }

  get claudeDescription() {
    return 'Mildly bearish strategy. Sells an OTM call and buys a higher call for protection. ' +
           'Profits when NIFTY stays below the short call strike through expiry. ' +
           'Best in low-VIX, trending-down markets with PCR < 1.0.';
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
        log('INFO', `Signal generated [${decision.mode}] confidence=${decision.confidence.toFixed(2)}: BCS ${JSON.stringify(trade.strikes)}`);
      })
      .catch((err) => {
        this._evaluating = false;
        log('ERROR', `Strategy selector error: ${err.message}`);
      });
  }

  // ── Core Interface ──────────────────────────────────────────────────────────

  /**
   * Evaluates Bear Call Spread entry conditions (8 checks).
   * Pure function — no side effects.
   *
   * @param {object} marketData
   * @returns {{ eligible: boolean, score: number, failedConditions: string[] }}
   */
  checkConditions(marketData) {
    const {
      indicators,
      optionsChain,
      sessionContext: ctx,
      timestamp,
      _isHolidayOverride,
    } = marketData;

    const failed = [];
    const TOTAL  = 8;

    // ── 1. VIX < 20 ───────────────────────────────────────────────────────────
    const vix = optionsChain.vix ?? ctx.vixCurrent;
    if (vix == null || vix >= 20) failed.push('vix');

    // ── 2. RSI < 50 (bearish momentum) ───────────────────────────────────────
    const { rsi } = indicators;
    if (rsi == null || rsi >= 50) failed.push('rsi');

    // ── 3. NIFTY below EMA21 ─────────────────────────────────────────────────
    const nifty  = optionsChain.underlyingValue;
    const { ema21 } = indicators;
    if (ema21 == null || nifty >= ema21) failed.push('niftyBelowEma21');

    // ── 4. PCR < 1.0 (call-heavy OI — market expects resistance above) ────────
    const { pcr } = optionsChain;
    if (pcr == null || pcr >= 1.0) failed.push('pcr');

    // ── 5. EMA9 crossing below EMA21 (ema9 <= ema21) ─────────────────────────
    const { ema9 } = indicators;
    if (ema9 == null || ema9 > ema21) failed.push('emaTrend');

    // ── 6. MACD negative or near-zero (not bullish) ───────────────────────────
    const macdVal = indicators.macd?.macd;
    if (macdVal == null || macdVal > config.MACD_ZERO_THRESHOLD) failed.push('macd');

    // ── 7. Time 09:30–14:00 IST ───────────────────────────────────────────────
    const { hour, minute } = toIST(timestamp);
    const afterOpen = hour > 9 || (hour === 9 && minute >= 30);
    const beforeCut = hour < 14;
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
   * Constructs the 2 Bear Call Spread legs.
   * Short CE at maxCeOiStrike - 100, long CE 200 points above.
   * Applies +50 shift if short strike lands on a round 500/1000 level.
   *
   * @param {object} marketData
   * @returns {{ strikes, legs, expectedPremium, maxLoss, maxProfit, riskRewardRatio }}
   */
  buildTrade(marketData) {
    const { optionsChain } = marketData;

    let shortCe = optionsChain.maxCeOiStrike - 100;
    if (shortCe % 500 === 0) shortCe += 50;

    const longCe = shortCe + 200;

    return {
      strikes: { shortCe, longCe },
      legs: [
        { type: 'CE', strike: shortCe, action: 'SELL' },
        { type: 'CE', strike: longCe,  action: 'BUY'  },
      ],
      expectedPremium: null,
      maxLoss:         null,
      maxProfit:       null,
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
   * Returns exit conditions for an active Bear Call Spread.
   * Exit if short CE delta breaches 0.40 or 15m candle closes above short strike buffer.
   *
   * @param {object} trade
   * @returns {object}
   */
  getExitConditions(trade) {
    const buffer = 75;
    return {
      exitIfNiftyClosesAbove: trade.strikes.shortCe + buffer,
      deltaCeThreshold:       0.40,
      absolutePnlStop:        config.ABSOLUTE_PNL_STOP_RUPEES,
      squareOffTime:          config.SQUARE_OFF_TIME,
      exitTimeframe:          '15m',
    };
  }

  /**
   * Bear Call Spread requires both legs to fill — partial fill triggers rollback.
   * @returns {boolean} Always false
   */
  validatePartialFill(filledLegs) {
    return false;
  }
}

module.exports = new BearCallSpreadStrategy();
