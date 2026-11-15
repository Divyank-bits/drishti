/**
 * @file divergence.js
 * @description Phase 7: regular bullish/bearish divergence detection.
 *              Uses known pivot lows/highs only (no lookahead).
 *              Pure function — no I/O.
 */

'use strict';

const { pivotsKnownAt } = require('./swings');

/**
 * Detects regular divergence at bar i using known pivots and an oscillator series.
 *
 * Bullish: price makes an equal or lower pivot low while the oscillator makes
 *          a higher low at the same pivots.
 * Bearish: price makes an equal or higher pivot high while the oscillator makes
 *          a lower high at the same pivots.
 *
 * We look at the two most recent known pivot lows (for bullish) and highs (for
 * bearish) and compare price vs oscillator direction.
 *
 * @param {{ highs: Array, lows: Array }} pivots — from findPivots
 * @param {(number|null)[]} oscillator — index-aligned series (RSI or Stochastic %K)
 * @param {number} i
 * @param {'RSI'|'STOCH'} label — for the returned `on` field
 * @returns {{ bullish: boolean, bearish: boolean, on: string }}
 */
function detectDivergence(pivots, oscillator, i, label) {
  const knownLows  = pivotsKnownAt(pivots.lows,  i);
  const knownHighs = pivotsKnownAt(pivots.highs, i);

  let bullish = false;
  let bearish = false;

  // Bullish divergence: price lower (or equal) low, oscillator higher low
  if (knownLows.length >= 2) {
    const p2 = knownLows[knownLows.length - 1];  // most recent known low
    const p1 = knownLows[knownLows.length - 2];  // the one before
    const osc2 = oscillator[p2.index];
    const osc1 = oscillator[p1.index];
    if (osc1 !== null && osc2 !== null) {
      const priceDown = p2.price <= p1.price;
      const oscUp     = osc2 > osc1;
      if (priceDown && oscUp) bullish = true;
    }
  }

  // Bearish divergence: price higher (or equal) high, oscillator lower high
  if (knownHighs.length >= 2) {
    const p2 = knownHighs[knownHighs.length - 1];
    const p1 = knownHighs[knownHighs.length - 2];
    const osc2 = oscillator[p2.index];
    const osc1 = oscillator[p1.index];
    if (osc1 !== null && osc2 !== null) {
      const priceUp  = p2.price >= p1.price;
      const oscDown  = osc2 < osc1;
      if (priceUp && oscDown) bearish = true;
    }
  }

  return { bullish, bearish, on: label };
}

module.exports = { detectDivergence };
