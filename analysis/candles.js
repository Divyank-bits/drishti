/**
 * @file candles.js
 * @description Phase 7: pure candle anatomy helpers and candlestick pattern detectors.
 *              All functions are pure (no I/O, no side-effects).
 *              Pattern detectors follow the SMM Part 1 / PAPA Part 1 definitions exactly.
 */

'use strict';

const config = require('../config');

// ── Anatomy ───────────────────────────────────────────────────────────────────

/**
 * Returns the absolute body size (|close - open|).
 */
function body(c) {
  return Math.abs(c.close - c.open);
}

/**
 * Returns the full high-to-low range.
 */
function range(c) {
  return c.high - c.low;
}

/**
 * Upper wick: from the top of the body to the high.
 */
function upperWick(c) {
  return c.high - Math.max(c.open, c.close);
}

/**
 * Lower wick: from the bottom of the body to the low.
 */
function lowerWick(c) {
  return Math.min(c.open, c.close) - c.low;
}

/**
 * Midpoint of the body: (open + close) / 2.
 */
function median(c) {
  return (c.open + c.close) / 2;
}

function isBullish(c) {
  return c.close > c.open;
}

function isBearish(c) {
  return c.close < c.open;
}

/**
 * Returns true when both wicks exist (non-zero), regardless of size.
 */
function hasUpperWick(c) { return upperWick(c) > 0; }
function hasLowerWick(c) { return lowerWick(c) > 0; }

// ── "At bottom" / "at top" context ───────────────────────────────────────────
// At bottom: the pattern's lowest low is the lowest low of the last 10 bars,
// and trendAt was not UP five bars earlier.
// At top: the pattern's highest high is the highest high of the last 10 bars,
// and trendAt was not DOWN five bars earlier.
// Because trendAt requires features (computed later), we accept an optional
// trendFiveBarsAgo argument ('UP'|'DOWN'|'SIDEWAYS'|null).

function _atBottom(candles, i, trendFiveBarsAgo) {
  const lookback = 10;
  const start = Math.max(0, i - lookback + 1);
  let minLow = candles[i].low;
  for (let j = start; j <= i; j++) {
    if (candles[j].low < minLow) minLow = candles[j].low;
  }
  if (candles[i].low > minLow) return false;        // not the lowest low
  if (trendFiveBarsAgo === 'UP') return false;       // already in uptrend
  return true;
}

function _atTop(candles, i, trendFiveBarsAgo) {
  const lookback = 10;
  const start = Math.max(0, i - lookback + 1);
  let maxHigh = candles[i].high;
  for (let j = start; j <= i; j++) {
    if (candles[j].high > maxHigh) maxHigh = candles[j].high;
  }
  if (candles[i].high < maxHigh) return false;      // not the highest high
  if (trendFiveBarsAgo === 'DOWN') return false;     // already in downtrend
  return true;
}

// ── Individual pattern detectors ─────────────────────────────────────────────
// Each function signature: (candles, i [, trendFiveBarsAgo]) → boolean
// candles is the full slice up to and including i; patterns may look back at
// c1 = candles[i-2], c2 = candles[i-1], c3 = candles[i].

function isHammer(candles, i, trendFiveBarsAgo) {
  if (i < 0) return false;
  const c = candles[i];
  const b = body(c);
  const r = range(c);
  if (r === 0) return false;
  const pct = config.SWING_SMALL_BODY_PCT / 100;
  if (b > r * pct) return false;                            // body must be small
  if (b === 0) return false;                               // doji — not a hammer
  if (lowerWick(c) < b * config.SWING_WICK_BODY_MULT) return false;  // lower wick >= mult × body
  if (upperWick(c) > b) return false;                      // upper wick <= body
  return _atBottom(candles, i, trendFiveBarsAgo);
}

function isInvertedHammerOrShootingStar(candles, i, trendFiveBarsAgo) {
  if (i < 0) return false;
  const c = candles[i];
  const b = body(c);
  const r = range(c);
  if (r === 0) return false;
  const pct = config.SWING_SMALL_BODY_PCT / 100;
  if (b > r * pct) return false;
  if (b === 0) return false;
  if (upperWick(c) < b * config.SWING_WICK_BODY_MULT) return false;
  if (lowerWick(c) > b) return false;
  return _atTop(candles, i, trendFiveBarsAgo);
}

function isBullishPiercing(candles, i) {
  if (i < 1) return false;
  const c1 = candles[i - 1];
  const c2 = candles[i];
  if (!isBearish(c1) || !isBullish(c2)) return false;
  if (c2.open > c1.close) return false;        // c2 must open at or below c1 close
  if (c2.close <= median(c1)) return false;    // must close above midpoint of c1
  if (c2.close >= c1.open) return false;       // but not fully engulf
  return true;
}

function isBullishEngulfing(candles, i) {
  if (i < 1) return false;
  const c1 = candles[i - 1];
  const c2 = candles[i];
  if (!isBearish(c1) || !isBullish(c2)) return false;
  if (c2.open > c1.close) return false;
  if (c2.close <= c1.open) return false;       // must close above c1 open
  return true;
}

function isMorningStar(candles, i) {
  if (i < 2) return false;
  const c1 = candles[i - 2];
  const c2 = candles[i - 1];
  const c3 = candles[i];
  if (!isBearish(c1)) return false;
  // c2: small body (neutral)
  const r2 = range(c2);
  if (r2 > 0 && body(c2) > r2 * (config.SWING_SMALL_BODY_PCT / 100)) return false;
  if (c2.open >= c1.close) return false;       // c2 opens below c1 close
  if (c2.low >= c1.low) return false;          // c2 makes a new low
  if (!isBullish(c3)) return false;
  if (c3.open <= c2.close) return false;       // c3 opens above c2 close
  if (c3.close <= median(c1)) return false;    // c3 closes above midpoint of c1
  return true;
}

function isBearishPiercing(candles, i) {
  if (i < 1) return false;
  const c1 = candles[i - 1];
  const c2 = candles[i];
  if (!isBullish(c1) || !isBearish(c2)) return false;
  if (c2.open < c1.close) return false;        // c2 opens at or above c1 close
  if (c2.close >= median(c1)) return false;    // closes below midpoint
  if (c2.close <= c1.open) return false;       // but not fully engulf
  return true;
}

function isBearishEngulfing(candles, i) {
  if (i < 1) return false;
  const c1 = candles[i - 1];
  const c2 = candles[i];
  if (!isBullish(c1) || !isBearish(c2)) return false;
  if (c2.open < c1.close) return false;
  if (c2.close >= c1.open) return false;       // close must be below c1 open
  return true;
}

function isEveningStar(candles, i) {
  if (i < 2) return false;
  const c1 = candles[i - 2];
  const c2 = candles[i - 1];
  const c3 = candles[i];
  if (!isBullish(c1)) return false;
  const r2 = range(c2);
  if (r2 > 0 && body(c2) > r2 * (config.SWING_SMALL_BODY_PCT / 100)) return false;
  if (c2.open <= c1.close) return false;
  if (c2.high <= c1.high) return false;
  if (!isBearish(c3)) return false;
  if (c3.open >= c2.close) return false;
  if (c3.close >= median(c1)) return false;
  return true;
}

// Hanging man: hammer shape at the top, confirmed by next bearish candle.
// So it triggers at bar i+1 (the confirming bar), and the hammer is at i.
function isHangingMan(candles, i, trendFiveBarsAgo) {
  if (i < 1) return false;
  const prev = candles[i - 1];
  const conf = candles[i];
  // prev must have hammer shape at top
  const b  = body(prev);
  const r  = range(prev);
  if (r === 0 || b === 0) return false;
  const pct = config.SWING_SMALL_BODY_PCT / 100;
  if (b > r * pct) return false;
  if (lowerWick(prev) < b * config.SWING_WICK_BODY_MULT) return false;
  if (upperWick(prev) > b) return false;
  if (!_atTop(candles, i - 1, trendFiveBarsAgo)) return false;
  // confirming candle is bearish
  return isBearish(conf);
}

function isThreeWhiteSoldiers(candles, i) {
  if (i < 2) return false;
  const c1 = candles[i - 2];
  const c2 = candles[i - 1];
  const c3 = candles[i];
  for (const c of [c1, c2, c3]) {
    if (!isBullish(c)) return false;
    const r = range(c);
    if (r > 0 && body(c) < r * 0.5) return false;  // body >= 50% of range [assumption]
  }
  if (c2.close <= c1.close) return false;
  if (c3.close <= c2.close) return false;
  return true;
}

function isThreeBlackCrows(candles, i) {
  if (i < 2) return false;
  const c1 = candles[i - 2];
  const c2 = candles[i - 1];
  const c3 = candles[i];
  for (const c of [c1, c2, c3]) {
    if (!isBearish(c)) return false;
    const r = range(c);
    if (r > 0 && body(c) < r * 0.5) return false;
  }
  if (c2.close >= c1.close) return false;
  if (c3.close >= c2.close) return false;
  return true;
}

function isPlainBullish(candles, i) {
  if (i < 0) return false;
  const c = candles[i];
  const r = range(c);
  if (r === 0) return false;
  return isBullish(c) && body(c) >= r * (config.SWING_STRONG_BODY_PCT / 100);
}

function isPlainBearish(candles, i) {
  if (i < 0) return false;
  const c = candles[i];
  const r = range(c);
  if (r === 0) return false;
  return isBearish(c) && body(c) >= r * (config.SWING_STRONG_BODY_PCT / 100);
}

function isDoji(candles, i) {
  if (i < 0) return false;
  const c = candles[i];
  const r = range(c);
  if (r === 0) return true;   // open == high == low == close
  return body(c) <= r * 0.10;  // body <= 10% of range [assumption]
}

function isSpinningTop(candles, i) {
  if (i < 0) return false;
  const c = candles[i];
  const r = range(c);
  if (r === 0) return false;
  return body(c) <= r * (config.SWING_SMALL_BODY_PCT / 100) &&
    hasUpperWick(c) && hasLowerWick(c);
}

function isHighWave(candles, i) {
  if (i < 0) return false;
  const c = candles[i];
  const b = body(c);
  if (b === 0) return false;
  return upperWick(c) >= b * 2 && lowerWick(c) >= b * 2;
}

// Tweezers: two consecutive candles with highs (top) or lows (bottom) within 0.2%
function isTweezersTop(candles, i) {
  if (i < 1) return false;
  const c1 = candles[i - 1];
  const c2 = candles[i];
  const ref = c1.high;
  if (ref === 0) return false;
  return Math.abs(c2.high - ref) / ref <= 0.002;
}

function isTweezersBottom(candles, i) {
  if (i < 1) return false;
  const c1 = candles[i - 1];
  const c2 = candles[i];
  const ref = c1.low;
  if (ref === 0) return false;
  return Math.abs(c2.low - ref) / ref <= 0.002;
}

// ── detectAll ─────────────────────────────────────────────────────────────────

/**
 * Runs all pattern detectors at bar i and returns categorised pattern names.
 * trendFiveBarsAgo is optional ('UP'|'DOWN'|'SIDEWAYS'|null).
 *
 * @param {Array} candles
 * @param {number} i
 * @param {string|null} [trendFiveBarsAgo]
 * @returns {{ bullish: string[], bearish: string[], neutral: string[] }}
 */
function detectAll(candles, i, trendFiveBarsAgo = null) {
  const bullish = [];
  const bearish = [];
  const neutral = [];

  if (isMorningStar(candles, i))                      bullish.push('morning-star');
  if (isBullishEngulfing(candles, i))                 bullish.push('bullish-engulfing');
  if (isBullishPiercing(candles, i))                  bullish.push('bullish-piercing');
  if (isHammer(candles, i, trendFiveBarsAgo))         bullish.push('hammer');
  if (isThreeWhiteSoldiers(candles, i))               bullish.push('three-white-soldiers');
  if (isPlainBullish(candles, i))                     bullish.push('plain-bullish');

  if (isEveningStar(candles, i))                      bearish.push('evening-star');
  if (isBearishEngulfing(candles, i))                 bearish.push('bearish-engulfing');
  if (isBearishPiercing(candles, i))                  bearish.push('bearish-piercing');
  if (isInvertedHammerOrShootingStar(candles, i, trendFiveBarsAgo)) bearish.push('shooting-star');
  if (isHangingMan(candles, i, trendFiveBarsAgo))     bearish.push('hanging-man');
  if (isThreeBlackCrows(candles, i))                  bearish.push('three-black-crows');
  if (isPlainBearish(candles, i))                     bearish.push('plain-bearish');

  if (isDoji(candles, i))                             neutral.push('doji');
  if (isSpinningTop(candles, i))                      neutral.push('spinning-top');
  if (isHighWave(candles, i))                         neutral.push('high-wave');
  if (isTweezersTop(candles, i))                      neutral.push('tweezers-top');
  if (isTweezersBottom(candles, i))                   neutral.push('tweezers-bottom');

  return { bullish, bearish, neutral };
}

module.exports = {
  body, range, upperWick, lowerWick, median, isBullish, isBearish,
  isHammer,
  isInvertedHammerOrShootingStar,
  isBullishPiercing,
  isBullishEngulfing,
  isMorningStar,
  isBearishPiercing,
  isBearishEngulfing,
  isEveningStar,
  isHangingMan,
  isThreeWhiteSoldiers,
  isThreeBlackCrows,
  isPlainBullish,
  isPlainBearish,
  isDoji,
  isSpinningTop,
  isHighWave,
  isTweezersTop,
  isTweezersBottom,
  detectAll,
  _atBottom,
  _atTop,
};
