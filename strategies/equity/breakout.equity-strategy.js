/**
 * @file breakout.equity-strategy.js
 * @description Breakout pattern: 15m close above prev day high with volume > 2× avg.
 *              EMA9 > EMA21. RSI > 60. Price > VWAP.
 */

'use strict';

const BaseEquityStrategy = require('./base.equity-strategy');

class BreakoutStrategy extends BaseEquityStrategy {
  get name()      { return 'Breakout'; }
  get direction() { return 'BULLISH'; }
  get description() {
    return '15m close above previous day high with 2× average volume, EMA9 > EMA21, RSI > 60, price above VWAP.';
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

    // ── Prev day high breakout ────────────────────────────────────────────────
    if (context?.prevDayHigh && price > context.prevDayHigh) {
      signals.push(`Price ${price} above prev day high ${context.prevDayHigh}`);
    } else {
      failedConditions.push(`Price ${price} not above prev day high ${context?.prevDayHigh}`);
    }

    // ── Volume confirmation ───────────────────────────────────────────────────
    if (avgVolume && last.volume > avgVolume * 2) {
      signals.push(`Volume ${last.volume} > 2× avg ${avgVolume}`);
    } else {
      failedConditions.push(`Volume ${last.volume} not > 2× avg ${avgVolume}`);
    }

    // ── EMA9 > EMA21 ──────────────────────────────────────────────────────────
    if (ema9 && ema21 && ema9 > ema21) {
      signals.push('EMA9 > EMA21');
    } else {
      failedConditions.push('EMA9 not above EMA21');
    }

    // ── RSI > 60 ──────────────────────────────────────────────────────────────
    if (rsi > 60) {
      signals.push(`RSI ${rsi.toFixed(1)} > 60`);
    } else {
      failedConditions.push(`RSI ${rsi?.toFixed(1)} not > 60`);
    }

    // ── Price > VWAP ──────────────────────────────────────────────────────────
    if (context?.vwap && price > context.vwap) {
      signals.push(`Price above VWAP (${context.vwap.toFixed(2)})`);
    } else {
      failedConditions.push('Price not above VWAP');
    }

    // ── Scoring ───────────────────────────────────────────────────────────────
    const total   = signals.length + failedConditions.length;
    const score   = total > 0 ? Math.round((signals.length / total) * 100) : 0;
    const passing = failedConditions.length === 0;

    // Breakout is timeframe-agnostic but strongest signal on 15m
    let state = 'NONE';
    if (score >= 80 && passing) state = 'CONFIRMED';
    else if (score >= 50)       state = 'FORMING';

    return { patternName: this.name, direction: this.direction, state, confidence: score, signals, failedConditions };
  }
}

module.exports = new BreakoutStrategy();
