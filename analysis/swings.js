/**
 * @file swings.js
 * @description Phase 7: swing pivot detection, support/resistance level clustering,
 *              and trend classification. Pure functions — no I/O.
 */

'use strict';

const config = require('../config');

// ── Pivot detection ───────────────────────────────────────────────────────────

/**
 * Finds all pivot highs and lows in a candle array.
 *
 * A pivot high at bar t: candles[t].high is the highest high of bars [t-k .. t+k].
 * A pivot low  at bar t: candles[t].low  is the lowest  low  of bars [t-k .. t+k].
 *
 * Each pivot carries confirmedAt = t + k (the bar at which lookahead is complete).
 *
 * @param {Array}  candles
 * @param {number} k — bars on each side (default: SWING_PIVOT_K)
 * @returns {{ highs: Array, lows: Array }}
 *   Each element: { index: number, price: number, confirmedAt: number }
 */
function findPivots(candles, k = config.SWING_PIVOT_K) {
  const highs = [];
  const lows  = [];

  for (let t = k; t < candles.length - k; t++) {
    let isHigh = true;
    let isLow  = true;

    for (let j = t - k; j <= t + k; j++) {
      if (j === t) continue;
      if (candles[j].high >= candles[t].high) isHigh = false;
      if (candles[j].low  <= candles[t].low)  isLow  = false;
    }

    if (isHigh) highs.push({ index: t, price: candles[t].high, confirmedAt: t + k });
    if (isLow)  lows.push ({ index: t, price: candles[t].low,  confirmedAt: t + k });
  }

  return { highs, lows };
}

/**
 * Filters a pivot list to only those confirmed by bar i (confirmedAt <= i).
 * @param {Array}  pivots — either highs or lows from findPivots
 * @param {number} i
 * @returns {Array}
 */
function pivotsKnownAt(pivots, i) {
  return pivots.filter(p => p.confirmedAt <= i);
}

// ── Support / Resistance levels ───────────────────────────────────────────────

/**
 * Clusters known pivot prices and returns support/resistance levels as of bar i.
 *
 * A level is **major** when:
 *   - it has 2+ pivot touches, OR
 *   - its price is the highest high or lowest low of the lookback window.
 *
 * Returns levels sorted by distance from candles[i].close (closest first).
 *
 * @param {Array}  candles
 * @param {{ highs: Array, lows: Array }} pivots — full pivot list from findPivots
 * @param {number} i
 * @returns {{ supports: Array, resistances: Array }}
 *   Each element: { price: number, touches: number, major: boolean }
 */
function levelsAt(candles, pivots, i) {
  const lookback   = config.SWING_LEVEL_LOOKBACK;
  const clusterPct = config.SWING_LEVEL_CLUSTER_PCT / 100;
  const currentClose = candles[i].close;

  // Collect all known pivots within the lookback window
  const windowStart = Math.max(0, i - lookback + 1);
  const knownHighs  = pivotsKnownAt(pivots.highs, i).filter(p => p.index >= windowStart);
  const knownLows   = pivotsKnownAt(pivots.lows,  i).filter(p => p.index >= windowStart);

  // Highest high / lowest low in the lookback (for major tagging)
  let maxHigh = -Infinity;
  let minLow  = +Infinity;
  for (let j = windowStart; j <= i; j++) {
    if (candles[j].high > maxHigh) maxHigh = candles[j].high;
    if (candles[j].low  < minLow)  minLow  = candles[j].low;
  }

  function cluster(prices, majorExtremes) {
    const levels = [];
    for (const price of prices) {
      let merged = false;
      for (const lv of levels) {
        const ref = lv.price;
        if (Math.abs(price - ref) / ref <= clusterPct) {
          lv.price   = (lv.price * lv.touches + price) / (lv.touches + 1); // weighted avg
          lv.touches++;
          merged = true;
          break;
        }
      }
      if (!merged) levels.push({ price, touches: 1, major: false });
    }

    // Tag major levels
    for (const lv of levels) {
      lv.major = lv.touches >= 2 ||
        majorExtremes.some(e => Math.abs(lv.price - e) / e <= clusterPct);
    }

    // Sort by distance from current close
    levels.sort((a, b) => Math.abs(a.price - currentClose) - Math.abs(b.price - currentClose));
    return levels;
  }

  const resistances = cluster(
    knownHighs.map(p => p.price),
    [maxHigh]
  ).filter(lv => lv.price > currentClose);

  const supports = cluster(
    knownLows.map(p => p.price),
    [minLow]
  ).filter(lv => lv.price < currentClose);

  return { supports, resistances };
}

// ── Trend classification ──────────────────────────────────────────────────────

/**
 * Returns 'UP' | 'DOWN' | 'SIDEWAYS' based on the EMA alignment at bar i.
 * UP: EMA5 > EMA13 > EMA26 > EMA50
 * DOWN: EMA5 < EMA13 < EMA26 < EMA50
 * SIDEWAYS: otherwise
 *
 * @param {{ ema5: (number|null)[], ema13: (number|null)[], ema26: (number|null)[], ema50: (number|null)[] }} features
 * @param {number} i
 * @returns {'UP'|'DOWN'|'SIDEWAYS'}
 */
function trendAt(features, i) {
  const e5  = features.ema5[i];
  const e13 = features.ema13[i];
  const e26 = features.ema26[i];
  const e50 = features.ema50[i];

  if (e5 === null || e13 === null || e26 === null || e50 === null) return 'SIDEWAYS';

  if (e5 > e13 && e13 > e26 && e26 > e50) return 'UP';
  if (e5 < e13 && e13 < e26 && e26 < e50) return 'DOWN';
  return 'SIDEWAYS';
}

module.exports = { findPivots, pivotsKnownAt, levelsAt, trendAt };
