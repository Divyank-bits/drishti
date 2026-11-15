/**
 * @file swing-indicators.js
 * @description Phase 7: pure indicator series builders for the swing analysis engine.
 *              All series are arrays index-aligned with the input candles array.
 *              Values are null where the indicator is not yet computable.
 *              No I/O, no side effects.
 */

'use strict';

const {
  EMA, MACD, Stochastic, RSI, BollingerBands, ADX, ATR,
} = require('technicalindicators');

const config = require('../config');

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Pads a shorter result array from technicalindicators to full length by
 * prepending nulls.
 */
function _pad(arr, totalLen) {
  const nulls = new Array(Math.max(0, totalLen - arr.length)).fill(null);
  return nulls.concat(arr);
}

// ── EMA series ────────────────────────────────────────────────────────────────

/**
 * Returns an index-aligned array of EMA values for the given period.
 * @param {number[]} closes
 * @param {number}   period
 * @returns {(number|null)[]}
 */
function emaSeries(closes, period) {
  if (!closes || closes.length === 0) return [];
  const raw = EMA.calculate({ values: closes, period });
  return _pad(raw, closes.length);
}

// ── MACD series ───────────────────────────────────────────────────────────────

/**
 * Returns { macdLine, signalLine, histogram } each as an index-aligned array.
 */
function macdSeries(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!closes || closes.length === 0) return { macdLine: [], signalLine: [], histogram: [] };
  const raw = MACD.calculate({
    values: closes,
    fastPeriod,
    slowPeriod,
    signalPeriod,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  const macdLine   = _pad(raw.map(r => r.MACD   ?? null), closes.length);
  const signalLine = _pad(raw.map(r => r.signal ?? null), closes.length);
  const histogram  = _pad(raw.map(r => r.histogram ?? null), closes.length);
  return { macdLine, signalLine, histogram };
}

// ── Stochastic series ─────────────────────────────────────────────────────────

/**
 * Returns { k, d } each as an index-aligned array.
 */
function stochSeries(candles) {
  if (!candles || candles.length === 0) return { k: [], d: [] };
  const { period, signalPeriod } = config.SWING_STOCH;
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);

  const raw = Stochastic.calculate({ high: highs, low: lows, close: closes, period, signalPeriod });
  const k = _pad(raw.map(r => r.k ?? null), candles.length);
  const d = _pad(raw.map(r => r.d ?? null), candles.length);
  return { k, d };
}

// ── RSI series ────────────────────────────────────────────────────────────────

function rsiSeries(closes, period = 14) {
  if (!closes || closes.length === 0) return [];
  return _pad(RSI.calculate({ values: closes, period }), closes.length);
}

// ── Bollinger Bands ───────────────────────────────────────────────────────────

/**
 * Returns { upper, middle, lower } each as an index-aligned array.
 */
function bollingerSeries(closes, period = 20, stdDev = 2) {
  if (!closes || closes.length === 0) return { upper: [], middle: [], lower: [] };
  const raw = BollingerBands.calculate({ values: closes, period, stdDev });
  const upper  = _pad(raw.map(r => r.upper  ?? null), closes.length);
  const middle = _pad(raw.map(r => r.middle ?? null), closes.length);
  const lower  = _pad(raw.map(r => r.lower  ?? null), closes.length);
  return { upper, middle, lower };
}

// ── ADX series ────────────────────────────────────────────────────────────────

/**
 * Returns { adx, plusDI, minusDI } each as an index-aligned array.
 */
function adxSeries(candles, period = 14) {
  if (!candles || candles.length === 0) return { adx: [], plusDI: [], minusDI: [] };
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const raw = ADX.calculate({ high: highs, low: lows, close: closes, period });
  const adx    = _pad(raw.map(r => r.adx    ?? null), candles.length);
  const plusDI = _pad(raw.map(r => r.pdi    ?? null), candles.length);
  const minusDI= _pad(raw.map(r => r.mdi    ?? null), candles.length);
  return { adx, plusDI, minusDI };
}

// ── ATR series ────────────────────────────────────────────────────────────────

function atrSeries(candles, period = 14) {
  if (!candles || candles.length === 0) return [];
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  return _pad(ATR.calculate({ high: highs, low: lows, close: closes, period }), candles.length);
}

// ── Volume ratio series ───────────────────────────────────────────────────────

/**
 * volume[i] / average of the previous SWING_VOLUME_AVG_PERIOD volumes (excluding i).
 * Returns null for the first SWING_VOLUME_AVG_PERIOD bars.
 */
function volumeRatioSeries(candles) {
  const n = config.SWING_VOLUME_AVG_PERIOD;
  return candles.map((_, i) => {
    if (i < n) return null;
    let sum = 0;
    for (let j = i - n; j < i; j++) sum += candles[j].volume || 0;
    const avg = sum / n;
    if (avg === 0) return null;
    return (candles[i].volume || 0) / avg;
  });
}

// ── Heikin Ashi series ────────────────────────────────────────────────────────

/**
 * Returns an array of Heikin Ashi candles, index-aligned with input.
 * Each entry: { haOpen, haHigh, haLow, haClose, decisiveBull, decisiveBear }
 * decisiveBull = no lower wick (haLow === haOpen for bull candles)
 * decisiveBear = no upper wick (haHigh === haOpen for bear candles)
 */
function heikinAshiSeries(candles) {
  return candles.map((c, i) => {
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    let haOpen;
    if (i === 0) {
      haOpen = (c.open + c.close) / 2;
    } else {
      const prev = candles[i - 1];
      const prevHaOpen  = (prev.open + prev.close) / 2;
      const prevHaClose = (prev.open + prev.high + prev.low + prev.close) / 4;
      haOpen = (prevHaOpen + prevHaClose) / 2;
    }
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow  = Math.min(c.low,  haOpen, haClose);

    const isBull = haClose >= haOpen;
    const decisiveBull = isBull  && Math.abs(haLow  - Math.min(haOpen, haClose)) < 1e-9;
    const decisiveBear = !isBull && Math.abs(haHigh - Math.max(haOpen, haClose)) < 1e-9;

    return { haOpen, haHigh, haLow, haClose, decisiveBull, decisiveBear };
  });
}

// ── Crossover helpers ─────────────────────────────────────────────────────────

/**
 * Returns true if series `a` crossed above series `b` on any of the
 * last `lookback` bars ending at index `i`.
 */
function crossedAbove(a, b, i, lookback) {
  for (let k = 0; k < lookback; k++) {
    const cur  = i - k;
    const prev = cur - 1;
    if (cur < 1 || prev < 0) break;
    if (a[prev] !== null && b[prev] !== null && a[cur] !== null && b[cur] !== null) {
      if (a[prev] <= b[prev] && a[cur] > b[cur]) return true;
    }
  }
  return false;
}

/**
 * Returns true if series `a` crossed below series `b` on any of the
 * last `lookback` bars ending at index `i`.
 */
function crossedBelow(a, b, i, lookback) {
  for (let k = 0; k < lookback; k++) {
    const cur  = i - k;
    const prev = cur - 1;
    if (cur < 1 || prev < 0) break;
    if (a[prev] !== null && b[prev] !== null && a[cur] !== null && b[cur] !== null) {
      if (a[prev] >= b[prev] && a[cur] < b[cur]) return true;
    }
  }
  return false;
}

module.exports = {
  emaSeries,
  macdSeries,
  stochSeries,
  rsiSeries,
  bollingerSeries,
  adxSeries,
  atrSeries,
  volumeRatioSeries,
  heikinAshiSeries,
  crossedAbove,
  crossedBelow,
};
