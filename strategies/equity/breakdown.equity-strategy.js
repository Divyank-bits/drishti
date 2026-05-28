/**
 * @file breakdown.equity-strategy.js
 * @description Breakdown pattern: 15m close below prev day low with volume > 2× avg.
 *              EMA9 < EMA21. RSI < 40. Price < VWAP.
 */

'use strict';

const BaseEquityStrategy = require('./base.equity-strategy');

class BreakdownStrategy extends BaseEquityStrategy {
  get name()      { return 'Breakdown'; }
  get direction() { return 'BEARISH'; }
  get description() {
    return '15m close below previous day low with 2× average volume, EMA9 < EMA21, RSI < 40, price below VWAP.';
  }

  checkPattern({ candles, indicators, context, timeframe }) {
    const signals          = [];
    const failedConditions = [];

    if (!candles || candles.length < 3) {
      return { patternName: this.name, direction: this.direction, state: 'NONE', confidence: 0, signals, failedConditions: ['insufficient candles'] };
    }

    const { rsi, ema9, ema21, avgVolume } = indicators;
    const last  = candles[candles.length - 1];
    const price = last.close;

    // ── Prev day low breakdown ────────────────────────────────────────────────
    if (context?.prevDayLow && price < context.prevDayLow) {
      signals.push(`Price ${price} below prev day low ${context.prevDayLow}`);
    } else {
      failedConditions.push(`Price ${price} not below prev day low ${context?.prevDayLow}`);
    }

    // ── Volume confirmation ───────────────────────────────────────────────────
    if (avgVolume && last.volume > avgVolume * 2) {
      signals.push(`Volume ${last.volume} > 2× avg ${avgVolume}`);
    } else {
      failedConditions.push(`Volume ${last.volume} not > 2× avg ${avgVolume}`);
    }

    // ── EMA9 < EMA21 ──────────────────────────────────────────────────────────
    if (ema9 && ema21 && ema9 < ema21) {
      signals.push('EMA9 < EMA21');
    } else {
      failedConditions.push('EMA9 not below EMA21');
    }

    // ── RSI < 40 ──────────────────────────────────────────────────────────────
    if (rsi != null && rsi < 40) {
      signals.push(`RSI ${rsi.toFixed(1)} < 40`);
    } else {
      failedConditions.push(`RSI ${rsi != null ? rsi.toFixed(1) : 'N/A'} not < 40`);
    }

    // ── Price < VWAP ──────────────────────────────────────────────────────────
    if (context?.vwap && price < context.vwap) {
      signals.push(`Price below VWAP (${context.vwap.toFixed(2)})`);
    } else {
      failedConditions.push('Price not below VWAP');
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

module.exports = new BreakdownStrategy();
