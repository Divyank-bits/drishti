/**
 * @file bear-flag.equity-strategy.js
 * @description Bear Flag pattern: strong down move on 15m, consolidation (lower volume,
 *              tight BB) on 5m, 1m starting to break consolidation low.
 *              VWAP above price. Volume on breakdown > 1.5× avg.
 */

'use strict';

const BaseEquityStrategy = require('./base.equity-strategy');

class BearFlagStrategy extends BaseEquityStrategy {
  get name()      { return 'Bear Flag'; }
  get direction() { return 'BEARISH'; }
  get description() {
    return 'Strong down move followed by tight consolidation with drying volume, then breakdown below consolidation low below VWAP.';
  }

  checkPattern({ candles, indicators, context, timeframe }) {
    const signals          = [];
    const failedConditions = [];

    if (!candles || candles.length < 5) {
      return { patternName: this.name, direction: this.direction, state: 'NONE', confidence: 0, signals, failedConditions: ['insufficient candles'] };
    }

    const { rsi, ema9, ema21, bb, avgVolume } = indicators;
    const last  = candles[candles.length - 1];
    const price = last.close;

    // ── VWAP check ────────────────────────────────────────────────────────────
    if (context?.vwap && price < context.vwap) {
      signals.push(`Price (${price}) below VWAP (${context.vwap?.toFixed(2)})`);
    } else {
      failedConditions.push('price above VWAP');
    }

    // ── EMA trend: EMA9 < EMA21 ───────────────────────────────────────────────
    if (ema9 && ema21 && ema9 < ema21) {
      signals.push('EMA9 < EMA21 (downtrend)');
    } else {
      failedConditions.push('EMA9 not below EMA21');
    }

    // ── RSI bearish range (25–50) ─────────────────────────────────────────────
    if (rsi >= 25 && rsi <= 50) {
      signals.push(`RSI ${rsi.toFixed(1)} in bearish range`);
    } else {
      failedConditions.push(`RSI ${rsi?.toFixed(1)} outside 25–50`);
    }

    // ── Timeframe-specific checks ─────────────────────────────────────────────
    if (timeframe === 15) {
      const recent   = candles.slice(-5);
      const strongDown = recent.some(c => (c.open - c.close) / c.open > 0.005);
      if (strongDown) {
        signals.push('15m: strong down candle present');
      } else {
        failedConditions.push('15m: no strong down candle in last 5');
      }
    }

    if (timeframe === 5) {
      const bbWidth = bb?.upper && bb?.lower ? (bb.upper - bb.lower) / bb.middle * 100 : null;
      if (bbWidth !== null && bbWidth < 2.5) {
        signals.push(`5m: BB width ${bbWidth.toFixed(2)}% (tight — consolidation)`);
      } else {
        failedConditions.push(`5m: BB width ${bbWidth?.toFixed(2)}% not tight enough`);
      }

      if (avgVolume && last.volume < avgVolume) {
        signals.push('5m: volume drying up during consolidation');
      } else {
        failedConditions.push('5m: volume not drying up');
      }
    }

    if (timeframe === 1) {
      if (avgVolume && last.volume > avgVolume * 1.5) {
        signals.push(`1m: breakdown volume ${last.volume} > 1.5× avg ${avgVolume}`);
      } else {
        failedConditions.push('1m: breakdown volume not confirmed');
      }

      const recentLow = Math.min(...candles.slice(-6, -1).map(c => c.low));
      if (price <= recentLow * 1.001) {
        signals.push('1m: price breaking consolidation low');
      } else {
        failedConditions.push('1m: price not yet at consolidation low');
      }
    }

    // ── Scoring ───────────────────────────────────────────────────────────────
    const total = signals.length + failedConditions.length;
    const score = total > 0 ? Math.round((signals.length / total) * 100) : 0;
    const passing = failedConditions.length === 0;

    let state = 'NONE';
    if (score >= 80 && passing) state = 'CONFIRMED';
    else if (score >= 50)       state = 'FORMING';

    return { patternName: this.name, direction: this.direction, state, confidence: score, signals, failedConditions };
  }
}

module.exports = new BearFlagStrategy();
