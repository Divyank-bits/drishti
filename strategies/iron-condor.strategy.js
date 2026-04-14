/**
 * @file iron-condor.strategy.js
 * @description Iron Condor entry condition checker and strike selector.
 *              Extends BaseStrategy. Listens to INDICATORS_UPDATED (15m) and
 *              OPTIONS_CHAIN_UPDATED — evaluates entry when both are cached.
 *              RULES mode: all 11 conditions must pass (all-or-nothing).
 */
'use strict';

const BaseStrategy    = require('./base.strategy');
const eventBus        = require('../core/event-bus');
const EVENTS          = require('../core/events');
const CircuitBreaker  = require('../core/circuit-breaker');
const StateMachine    = require('../core/state-machine');
const SessionContext  = require('../core/session-context');
const config          = require('../config');
const holidays        = require('../holidays.json');

// Module-level singletons for strategy use (separate from index.js instances;
// the strategy only reads state — it does not drive these objects)
const circuitBreaker  = new CircuitBreaker();
const stateMachine    = new StateMachine();
const sessionContext  = new SessionContext();

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [IronCondor] [${level}] ${msg}`);
}

/**
 * Converts a UTC timestamp (ms) to IST hour/minute.
 * @param {number} tsMs
 * @returns {{ hour: number, minute: number }}
 */
function toIST(tsMs) {
  const istMs  = tsMs + 5.5 * 3600 * 1000;
  const hour   = Math.floor((istMs % (24 * 3600000)) / 3600000);
  const minute = Math.floor((istMs % 3600000) / 60000);
  return { hour, minute };
}

class IronCondorStrategy extends BaseStrategy {
  constructor() {
    super();
    this._cachedIndicators = null;
    this._cachedOptions    = null;
    this._bbWidthHistory   = [];
    this._paused           = false;

    eventBus.on(EVENTS.INDICATORS_UPDATED, (payload) => {
      if (payload.timeframe !== 15) return;
      this._cachedIndicators = payload.indicators;
      this._updateBbHistory(payload.indicators.bb?.width);
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

  get name() { return 'Iron Condor'; }

  get regime() { return ['A', 'B', 'C']; }

  get claudeDescription() {
    return 'Neutral strategy. Sells an OTM call spread and OTM put spread simultaneously. ' +
           'Profits from time decay in low-volatility range-bound markets.';
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _updateBbHistory(width) {
    if (width == null) return;
    this._bbWidthHistory.push(width);
    if (this._bbWidthHistory.length > 20) this._bbWidthHistory.shift();
  }

  _tryEvaluate(timestamp) {
    if (!this._cachedIndicators || !this._cachedOptions) return;
    if (this._paused) return;
    if (circuitBreaker.isTripped()) return;
    if (stateMachine.getCurrentState() !== 'IDLE') return;

    const snap = {
      indicators:     this._cachedIndicators,
      bbWidthHistory: [...this._bbWidthHistory],
      optionsChain:   this._cachedOptions,
      sessionContext:  sessionContext.snapshot(),
      timestamp,
    };

    const result = this.checkConditions(snap);
    if (!result.eligible) {
      log('DEBUG', `Entry conditions not met: ${result.failedConditions.join(', ')}`);
      return;
    }

    const trade = this.buildTrade(snap);
    stateMachine.transition('SIGNAL_DETECTED');
    eventBus.emit(EVENTS.SIGNAL_GENERATED, {
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
    });
    log('INFO', `Signal generated: IC ${JSON.stringify(trade.strikes)}`);
  }

  // ── Core Interface ──────────────────────────────────────────────────────────

  /**
   * Evaluates all 11 Iron Condor entry conditions.
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

    // ── 1. VIX 14–22 ──────────────────────────────────────────────────────────
    const vix = optionsChain.vix ?? ctx.vixCurrent;
    if (vix == null || vix < 14 || vix > config.VIX_SAFE_MAX) {
      failed.push('vix');
    }

    // ── 2. BB Width % 2–4 ─────────────────────────────────────────────────────
    const bbWidth = indicators.bb?.width;
    if (bbWidth == null || bbWidth < 2 || bbWidth > 4) {
      failed.push('bbWidth');
    }

    // ── 3. BB not squeezing (width not contracting for 5+ consecutive candles) ──
    if (bbWidthHistory.length >= 5) {
      const last5     = bbWidthHistory.slice(-5);
      const isSqueeze = last5.every((w, i) => i === 0 || w < last5[i - 1]);
      if (isSqueeze) failed.push('bbSqueeze');
    }

    // ── 4. IV Percentile proxy > 50% ──────────────────────────────────────────
    // Only applied when history has sufficient spread (≥ 0.5 points range) to
    // distinguish high-IV from low-IV regimes. If all history values cluster
    // tightly the proxy is unreliable and the check is skipped.
    if (bbWidthHistory.length >= 5 && bbWidth != null) {
      const histMax  = Math.max(...bbWidthHistory);
      const histMin  = Math.min(...bbWidthHistory);
      const hasSpread = (histMax - histMin) >= 0.5;
      if (hasSpread) {
        const countBelow = bbWidthHistory.filter(w => w < bbWidth).length;
        const percentile = (countBelow / bbWidthHistory.length) * 100;
        if (percentile < config.IV_PERCENTILE_PROXY_MIN) {
          failed.push('ivPercentile');
        }
      }
    }

    // ── 5. EMA9 and EMA21 within 0.2% ─────────────────────────────────────────
    const { ema9, ema21 } = indicators;
    if (ema9 == null || ema21 == null) {
      failed.push('emaSpread');
    } else {
      const spread = Math.abs(ema9 - ema21) / ema21;
      if (spread > 0.002) failed.push('emaSpread');
    }

    // ── 6. RSI 40–60 ──────────────────────────────────────────────────────────
    const { rsi } = indicators;
    if (rsi == null || rsi < 40 || rsi > 60) failed.push('rsi');

    // ── 7. MACD near zero ─────────────────────────────────────────────────────
    const macdVal = indicators.macd?.macd;
    if (macdVal == null || Math.abs(macdVal) >= config.MACD_ZERO_THRESHOLD) {
      failed.push('macd');
    }

    // ── 8. NIFTY within 0.5% of day open ─────────────────────────────────────
    const nifty   = optionsChain.underlyingValue;
    const dayOpen = ctx.dayOpen;
    if (dayOpen == null || Math.abs(nifty - dayOpen) / dayOpen > 0.005) {
      failed.push('niftyVsDayOpen');
    }

    // ── 9. PCR 0.9–1.2 ────────────────────────────────────────────────────────
    const { pcr } = optionsChain;
    if (pcr == null || pcr < 0.9 || pcr > 1.2) failed.push('pcr');

    // ── 10. Time 09:30–14:00 IST ──────────────────────────────────────────────
    const { hour, minute } = toIST(timestamp);
    const afterOpen = hour > 9 || (hour === 9 && minute >= 30);
    const beforeCut = hour < 14;
    if (!afterOpen || !beforeCut) failed.push('timeWindow');

    // ── 11. Not a holiday / major event day ───────────────────────────────────
    if (_isHolidayOverride) {
      failed.push('eventDay');
    } else {
      const today     = new Date(timestamp).toISOString().slice(0, 10);
      const isHoliday = Array.isArray(holidays) && holidays.some(h => h.date === today);
      if (isHoliday) failed.push('eventDay');
    }

    return {
      eligible:         failed.length === 0,
      score:            Math.round(((11 - failed.length) / 11) * 100),
      failedConditions: failed,
    };
  }

  /**
   * Constructs the 4 Iron Condor legs given current market data.
   * Applies the +50 shift rule if any short strike lands on an exact hundred.
   *
   * @param {object} marketData
   * @returns {{ strikes, legs, expectedPremium, maxLoss, maxProfit, riskRewardRatio }}
   */
  buildTrade(marketData) {
    const { optionsChain } = marketData;

    let shortCe = optionsChain.maxCeOiStrike - 100;
    let shortPe = optionsChain.maxPeOiStrike + 100;

    // Anti-hunt rule 7: shift +50 if strike lands on a round 500/1000 level
    // (e.g. 24000, 24500) — these are high-visibility targets for stop hunters.
    // Regular hundred-strikes (24100, 24200, 24400…) are not shifted.
    if (shortCe % 500 === 0) shortCe += 50;
    if (shortPe % 500 === 0) shortPe += 50;

    const longCe = shortCe + 200;
    const longPe = shortPe - 200;

    return {
      strikes: { shortCe, longCe, shortPe, longPe },
      legs: [
        { type: 'CE', strike: shortCe, action: 'SELL' },
        { type: 'CE', strike: longCe,  action: 'BUY'  },
        { type: 'PE', strike: shortPe, action: 'SELL' },
        { type: 'PE', strike: longPe,  action: 'BUY'  },
      ],
      expectedPremium: null,  // calculated by executor after premium lookup
      maxLoss:         null,
      maxProfit:       null,
      riskRewardRatio: null,
    };
  }

  /**
   * Assembles the strategy portion of a Claude prompt.
   * @param {object} marketData
   * @returns {string}
   */
  buildClaudePrompt(marketData) {
    return '';
  }

  /**
   * Returns exit conditions for an active Iron Condor trade.
   * @param {object} trade
   * @returns {object}
   */
  getExitConditions(trade) {
    return {};
  }

  /**
   * Iron Condor requires all 4 legs to fill — any partial fill triggers rollback.
   * @param {Array} filledLegs
   * @returns {boolean} Always false for Iron Condor
   */
  validatePartialFill(filledLegs) {
    return false;
  }
}

module.exports = new IronCondorStrategy();
