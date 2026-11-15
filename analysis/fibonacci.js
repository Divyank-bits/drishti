/**
 * @file fibonacci.js
 * @description Phase 7: Fibonacci retracement of the last completed swing leg.
 *              Pure function — no I/O.
 */

'use strict';

const { pivotsKnownAt } = require('./swings');

/**
 * Computes the retracement of the most recent completed swing leg as of bar i.
 *
 * Uses the two most recent known pivots (one high, one low) to identify the
 * last swing leg. Classifies the current close's retracement per SMM row 5:
 *   <= 50%  → 'HEALTHY'
 *   >= 61.8% → 'WATCHFUL'
 *   otherwise → 'NEUTRAL'
 *
 * Returns null when there are fewer than two known pivots of either type.
 *
 * @param {Array}  candles
 * @param {{ highs: Array, lows: Array }} pivots
 * @param {number} i
 * @returns {{ pct: number, classification: 'HEALTHY'|'NEUTRAL'|'WATCHFUL' } | null}
 */
function retracementAt(candles, pivots, i) {
  const knownHighs = pivotsKnownAt(pivots.highs, i);
  const knownLows  = pivotsKnownAt(pivots.lows,  i);

  if (knownHighs.length === 0 || knownLows.length === 0) return null;

  const lastHigh = knownHighs[knownHighs.length - 1];
  const lastLow  = knownLows[knownLows.length - 1];

  // Determine swing direction: which pivot is more recent?
  const swingLen = Math.abs(lastHigh.price - lastLow.price);
  if (swingLen === 0) return null;

  let swingStart, swingEnd, currentPrice;
  currentPrice = candles[i].close;

  if (lastHigh.index > lastLow.index) {
    // Most recent swing was upward (low → high); measure retracement from the high
    swingStart = lastLow.price;
    swingEnd   = lastHigh.price;
  } else {
    // Most recent swing was downward (high → low); measure retracement from the low
    swingStart = lastHigh.price;
    swingEnd   = lastLow.price;
  }

  const totalMove   = Math.abs(swingEnd - swingStart);
  const retracement = Math.abs(currentPrice - swingEnd) / totalMove * 100;

  let classification;
  if (retracement <= 50)       classification = 'HEALTHY';
  else if (retracement >= 61.8) classification = 'WATCHFUL';
  else                          classification = 'NEUTRAL';

  return { pct: retracement, classification };
}

module.exports = { retracementAt };
