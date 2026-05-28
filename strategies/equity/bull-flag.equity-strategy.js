/**
 * @file bull-flag.equity-strategy.js
 * @description Bull Flag pattern: strong up move on 15m, consolidation (lower volume,
 *              tight BB) on 5m, 1m starting to break consolidation high.
 *              VWAP below price. Volume on breakout > 1.5× avg.
 */

'use strict';

const BaseEquityStrategy = require('./base.equity-strategy');

class BullFlagStrategy extends BaseEquityStrategy {
  get name()      { return 'Bull Flag'; }
  get direction() { return 'BULLISH'; }
  get description() {
    return 'Strong up move followed by tight consolidation with drying volume, then breakout above consolidation high above VWAP.';
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
    if (context?.vwap && price > context.vwap) {
      signals.push(`Price (${price}) above VWAP (${context.vwap?.toFixed(2)})`);
    } else {
      failedConditions.push('price below VWAP');
    }

    // ── EMA trend: EMA9 > EMA21 ───────────────────────────────────────────────
    if (ema9 && ema21 && ema9 > ema21) {
      signals.push('EMA9 > EMA21 (uptrend)');
    } else {
      failedConditions.push('EMA9 not above EMA21');
    }

    // ── RSI bullish range (50–75) ─────────────────────────────────────────────
    if (rsi >= 50 && rsi <= 75) {
      signals.push(`RSI ${rsi.toFixed(1)} in bullish range`);
    } else {
      failedConditions.push(`RSI ${rsi?.toFixed(1)} outside 50–75`);
    }

    // ── Timeframe-specific checks ─────────────────────────────────────────────
    if (timeframe === 15) {
      // 15m: look for a strong up candle in the last 5 candles
      const recent = candles.slice(-5);
      const strongUp = recent.some(c => (c.close - c.open) / c.open > 0.005);
      if (strongUp) {
        signals.push('15m: strong up candle present');
      } else {
        failedConditions.push('15m: no strong up candle in last 5');
      }
    }

    if (timeframe === 5) {
      // 5m: consolidation — BB width should be tight, volume drying up
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
      // 1m: breaking consolidation high — last candle volume > 1.5× avg
      if (avgVolume && last.volume > avgVolume * 1.5) {
        signals.push(`1m: breakout volume ${last.volume} > 1.5× avg ${avgVolume}`);
      } else {
        failedConditions.push('1m: breakout volume not confirmed');
      }

      // Price at or above recent 5-candle high
      const recentHigh = Math.max(...candles.slice(-6, -1).map(c => c.high));
      if (price >= recentHigh * 0.999) {
        signals.push('1m: price breaking consolidation high');
      } else {
        failedConditions.push('1m: price not yet at consolidation high');
      }
    }

    // ── Scoring ───────────────────────────────────────────────────────────────
    const total   = signals.length + failedConditions.length;
    const score   = total > 0 ? Math.round((signals.length / total) * 100) : 0;
    const passing = failedConditions.length === 0;

    let state = 'NONE';
    if (score >= 80 && passing) state = 'CONFIRMED';
    else if (score >= 50)       state = 'FORMING';

    return { patternName: this.name, direction: this.direction, state, confidence: score, signals, failedConditions };
  }
}

module.exports = new BullFlagStrategy();
