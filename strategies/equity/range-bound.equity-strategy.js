/**
 * @file range-bound.equity-strategy.js
 * @description Range Bound pattern: price between prev day high/low for 3+ consecutive
 *              15m candles. BB width contracting. RSI 40–60. Volume below avg. MACD near zero.
 */

'use strict';

const BaseEquityStrategy = require('./base.equity-strategy');

class RangeBoundStrategy extends BaseEquityStrategy {
  get name()      { return 'Range Bound'; }
  get direction() { return 'NEUTRAL'; }
  get description() {
    return 'Price contained within previous day high/low for 3+ candles with contracting BB width, neutral RSI, below-average volume, and MACD near zero.';
  }

  checkPattern({ candles, indicators, context, timeframe }) {
    const signals          = [];
    const failedConditions = [];

    if (!candles || candles.length < 5) {
      return { patternName: this.name, direction: this.direction, state: 'NONE', confidence: 0, signals, failedConditions: ['insufficient candles'] };
    }

    const { rsi, macd, bb, avgVolume } = indicators;
    const last  = candles[candles.length - 1];
    const price = last.close;

    // ── Price within prev day range ───────────────────────────────────────────
    if (context?.prevDayHigh && context?.prevDayLow) {
      if (price < context.prevDayHigh && price > context.prevDayLow) {
        signals.push(`Price ${price} within PDH ${context.prevDayHigh} – PDL ${context.prevDayLow}`);
      } else {
        failedConditions.push('Price outside prev day high/low range');
      }

      // 3+ consecutive candles within range
      const recent = candles.slice(-4);
      const allInRange = recent.every(c => c.close < context.prevDayHigh && c.close > context.prevDayLow);
      if (allInRange) {
        signals.push('3+ consecutive candles within prev day range');
      } else {
        failedConditions.push('Not all recent candles within prev day range');
      }
    } else {
      failedConditions.push('Prev day high/low unavailable');
    }

    // ── BB width contracting ──────────────────────────────────────────────────
    const bbWidth = bb?.upper && bb?.lower ? (bb.upper - bb.lower) / bb.middle * 100 : null;
    if (bbWidth !== null && bbWidth < 2.5) {
      signals.push(`BB width ${bbWidth.toFixed(2)}% (contracting)`);
    } else {
      failedConditions.push(`BB width ${bbWidth?.toFixed(2)}% not contracting`);
    }

    // ── RSI neutral 40–60 ─────────────────────────────────────────────────────
    if (rsi >= 40 && rsi <= 60) {
      signals.push(`RSI ${rsi.toFixed(1)} neutral (40–60)`);
    } else {
      failedConditions.push(`RSI ${rsi?.toFixed(1)} outside 40–60`);
    }

    // ── Volume below average ──────────────────────────────────────────────────
    if (avgVolume && last.volume < avgVolume) {
      signals.push(`Volume ${last.volume} below avg ${avgVolume}`);
    } else {
      failedConditions.push('Volume not below average');
    }

    // ── MACD near zero ────────────────────────────────────────────────────────
    const macdVal = macd?.MACD ?? macd?.macd ?? null;
    if (macdVal !== null && Math.abs(macdVal) < 5) {
      signals.push(`MACD ${macdVal.toFixed(2)} near zero`);
    } else {
      failedConditions.push(`MACD ${macdVal?.toFixed(2)} not near zero`);
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

module.exports = new RangeBoundStrategy();
