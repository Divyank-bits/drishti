/**
 * @file bull-put-spread.strategy.js
 * @description Bull Put Spread strategy — sells an OTM PE and buys a lower PE.
 *              Profits when NIFTY stays above the short put strike.
 *              Suited for mildly bullish, low-volatility regimes (VIX < 20,
 *              RSI > 50, NIFTY above EMA21, PCR > 1.0).
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
  console.log(`[${ts}] [BullPutSpread] [${level}] ${msg}`);
}

function toIST(tsMs) {
  const istMs  = tsMs + 5.5 * 3600 * 1000;
  const hour   = Math.floor((istMs % (24 * 3600000)) / 3600000);
  const minute = Math.floor((istMs % 3600000) / 60000);
  return { hour, minute };
}

class BullPutSpreadStrategy extends BaseStrategy {
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

  get name() { return 'Bull Put Spread'; }

  get regime() { return ['A', 'B']; }

  get claudeDescription() {
    return 'Mildly bullish strategy. Sells an OTM put and buys a lower put for protection. ' +
           'Profits when NIFTY stays above the short put strike through expiry. ' +
           'Best in low-VIX, trending-up markets with PCR > 1.0.';
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
        log('INFO', `Signal generated [${decision.mode}] confidence=${decision.confidence.toFixed(2)}: BPS ${JSON.stringify(trade.strikes)}`);
      })
      .catch((err) => {
        this._evaluating = false;
        log('ERROR', `Strategy selector error: ${err.message}`);
      });
  }

  // ── Core Interface ──────────────────────────────────────────────────────────

  /**
   * Evaluates Bull Put Spread entry conditions (8 checks).
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

    // ── 2. RSI > 50 (bullish momentum) ───────────────────────────────────────
    const { rsi } = indicators;
    if (rsi == null || rsi <= 50) failed.push('rsi');

    // ── 3. NIFTY above EMA21 ──────────────────────────────────────────────────
    const nifty  = optionsChain.underlyingValue;
    const { ema21 } = indicators;
    if (ema21 == null || nifty <= ema21) failed.push('niftyAboveEma21');

    // ── 4. PCR > 1.0 (put-heavy OI — market expects support) ─────────────────
    const { pcr } = optionsChain;
    if (pcr == null || pcr <= 1.0) failed.push('pcr');

    // ── 5. EMA9 and EMA21 not crossing down (ema9 >= ema21) ──────────────────
    const { ema9 } = indicators;
    if (ema9 == null || ema9 < ema21) failed.push('emaTrend');

    // ── 6. MACD positive or near-zero (not bearish) ───────────────────────────
    const macdVal = indicators.macd?.macd;
    if (macdVal == null || macdVal < -config.MACD_ZERO_THRESHOLD) failed.push('macd');

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
   * Constructs the 2 Bull Put Spread legs.
   * Short PE at maxPeOiStrike + 100, long PE 200 points below.
   * Applies +50 shift if short strike lands on a round 500/1000 level.
   *
   * @param {object} marketData
   * @returns {{ strikes, legs, expectedPremium, maxLoss, maxProfit, riskRewardRatio }}
   */
  buildTrade(marketData) {
    const { optionsChain } = marketData;

    let shortPe = optionsChain.maxPeOiStrike + 100;
    if (shortPe % 500 === 0) shortPe += 50;

    const longPe = shortPe - 200;

    return {
      strikes: { shortPe, longPe },
      legs: [
        { type: 'PE', strike: shortPe, action: 'SELL' },
        { type: 'PE', strike: longPe,  action: 'BUY'  },
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
   * Returns exit conditions for an active Bull Put Spread.
   * Exit if short PE delta breaches -0.40 or 15m candle closes below short strike buffer.
   *
   * @param {object} trade
   * @returns {object}
   */
  getExitConditions(trade) {
    const buffer = 75;
    return {
      exitIfNiftyClosesBelow: trade.strikes.shortPe - buffer,
      deltaPeThreshold:       -0.40,
      absolutePnlStop:        config.ABSOLUTE_PNL_STOP_RUPEES,
      squareOffTime:          config.SQUARE_OFF_TIME,
      exitTimeframe:          '15m',
    };
  }

  /**
   * Bull Put Spread requires both legs to fill — partial fill triggers rollback.
   * @returns {boolean} Always false
   */
  validatePartialFill(filledLegs) {
    return false;
  }
}

module.exports = new BullPutSpreadStrategy();
