/**
 * @file features.js
 * @description Phase 7: builds all indicator series for a daily candle array in one pass.
 *              Also provides tideAt() for the weekly Tide indicator.
 *              Pure functions — no I/O.
 */

'use strict';

const config = require('../config');
const {
  emaSeries, macdSeries, stochSeries, rsiSeries,
  bollingerSeries, adxSeries, atrSeries, volumeRatioSeries,
  heikinAshiSeries,
} = require('./swing-indicators');
const { findPivots } = require('./swings');
const { toWeekly }  = require('../data/daily-candles');

// ── buildFeatures ─────────────────────────────────────────────────────────────

/**
 * Computes every indicator series once and returns them as one object.
 * All arrays are index-aligned with `daily` (length === daily.length).
 * Values are null where not yet computable.
 *
 * Setups must only read features.x[i] for the current bar or earlier.
 *
 * @param {Array<{date, open, high, low, close, volume}>} daily
 * @returns {object}
 */
function buildFeatures(daily) {
  if (!daily || daily.length === 0) return {};

  const closes = daily.map(c => c.close);

  // EMA series
  const ema5  = emaSeries(closes, 5);
  const ema13 = emaSeries(closes, 13);
  const ema26 = emaSeries(closes, 26);
  const ema50 = emaSeries(closes, 50);

  // MACD(12,26,9)
  const { macdLine, signalLine, histogram: macdHist } = macdSeries(closes, 12, 26, 9);

  // Stochastic
  const { k: stochK, d: stochD } = stochSeries(daily);

  // RSI(14)
  const rsi14 = rsiSeries(closes, 14);

  // Bollinger Bands (20, 2) and (20, 3)
  const bb2 = bollingerSeries(closes, 20, 2);
  const bb3 = bollingerSeries(closes, 20, 3);

  // ADX(14)
  const { adx, plusDI, minusDI } = adxSeries(daily, 14);

  // ATR(14)
  const atr14 = atrSeries(daily, 14);

  // Volume ratio
  const volRatio = volumeRatioSeries(daily);

  // Heikin Ashi
  const ha = heikinAshiSeries(daily);

  // Pivots (using full array — setups must call pivotsKnownAt to avoid lookahead)
  const pivots = findPivots(daily);

  return {
    // EMA
    ema5, ema13, ema26, ema50,
    // MACD
    macdLine, signalLine, macdHist,
    // Stochastic
    stochK, stochD,
    // RSI
    rsi14,
    // Bollinger Bands
    bb2Upper: bb2.upper, bb2Middle: bb2.middle, bb2Lower: bb2.lower,
    bb3Upper: bb3.upper, bb3Middle: bb3.middle, bb3Lower: bb3.lower,
    // ADX
    adx, plusDI, minusDI,
    // ATR
    atr14,
    // Volume ratio
    volRatio,
    // Heikin Ashi (array of objects)
    ha,
    // Pivots (full set — use pivotsKnownAt(features.pivots.highs, i) in setups)
    pivots,
  };
}

// ── tideAt ────────────────────────────────────────────────────────────────────

/**
 * Computes the Tide indicator at bar i.
 *
 * Tide is based on SWING_TIDE_INDICATOR applied to weekly candles built from
 * daily bars 0..i (completed weeks plus the in-progress week).
 *
 * Returns 'UP' | 'DOWN' | 'FLAT_AFTER_DOWN' | 'FLAT_AFTER_UP'.
 *
 * "Flat" = change smaller than 5% of the indicator's 10-bar average absolute
 * change.  [assumption]
 *
 * Performance note: the weekly candles up to bar i are rebuilt from daily
 * candles each call. For backtest use, callers should consider calling tideAt
 * incrementally or caching; for setup evaluation at a single bar the cost is
 * acceptable.
 *
 * @param {Array<{date, open, high, low, close, volume}>} daily — full daily array
 * @param {number} i — bar index (0-based)
 * @returns {'UP'|'DOWN'|'FLAT_AFTER_DOWN'|'FLAT_AFTER_UP'}
 */
function tideAt(daily, i) {
  if (i < 0 || !daily || daily.length === 0) return 'UP';

  // Build weekly candles from days 0..i only (no lookahead)
  const slice  = daily.slice(0, i + 1);
  const weekly = toWeekly(slice);

  if (weekly.length < 2) return 'UP';

  const closes = weekly.map(w => w.close);

  // Compute the tide series based on config
  let tideSeries;
  if (config.SWING_TIDE_INDICATOR === 'MACD_HIST') {
    const { histogram } = macdSeries(closes, 12, 26, 9);
    tideSeries = histogram;
  } else {
    const { macdLine } = macdSeries(closes, 12, 26, 9);
    tideSeries = macdLine;
  }

  const n = tideSeries.length;
  const last  = tideSeries[n - 1];
  const prev  = tideSeries[n - 2];

  if (last === null || prev === null) return 'UP';

  // Compute "flatness" threshold = 5% of 10-bar average absolute change
  const lookback = Math.min(10, n);
  let sumAbsChange = 0;
  let countChanges = 0;
  for (let k = n - lookback; k < n - 1; k++) {
    if (tideSeries[k] !== null && tideSeries[k + 1] !== null) {
      sumAbsChange += Math.abs(tideSeries[k + 1] - tideSeries[k]);
      countChanges++;
    }
  }
  const avgAbsChange = countChanges > 0 ? sumAbsChange / countChanges : 0;
  const flatThreshold = avgAbsChange * 0.05;

  const change = last - prev;
  const isFlat = Math.abs(change) <= flatThreshold;

  if (!isFlat) {
    return change > 0 ? 'UP' : 'DOWN';
  }

  // Flat — look at the direction that led into the flat
  // Find the most recent non-flat change before `prev`
  for (let k = n - 3; k >= 0; k--) {
    if (tideSeries[k] === null) continue;
    const prior = tideSeries[k + 1] - tideSeries[k];
    if (Math.abs(prior) > flatThreshold) {
      return prior > 0 ? 'FLAT_AFTER_UP' : 'FLAT_AFTER_DOWN';
    }
  }

  return 'FLAT_AFTER_UP';  // default when entire history is flat
}

module.exports = { buildFeatures, tideAt };
