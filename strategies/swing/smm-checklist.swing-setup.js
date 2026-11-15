/**
 * @file smm-checklist.swing-setup.js
 * @description Phase 7: SMM Decision Check List swing setup.
 *              Source: SMM Decision Check List course material.
 */

'use strict';

const config = require('../../config');
const { BaseSwingSetup, hatAt, targetFor, riskReward, naRow } = require('./base.swing-setup');
const { detectAll } = require('../../analysis/candles');
const { trendAt, levelsAt } = require('../../analysis/swings');
const { retracementAt } = require('../../analysis/fibonacci');
const { detectDivergence } = require('../../analysis/divergence');
const { crossedAbove, crossedBelow } = require('../../analysis/swing-indicators');

class SmmChecklistSetup extends BaseSwingSetup {
  get id()        { return 'smm-checklist'; }
  get name()      { return 'SMM Decision Check List'; }
  get sourceRef() { return 'SMM Decision Check List'; }

  evaluate({ daily, features, i, direction }) {
    if (i < 1) return this._result(direction, { state: 'NONE' });

    // ── Hat (Tide × Wave) ──────────────────────────────────────────────────────
    const hat = hatAt(daily, features, i);
    const wantBull = direction === 'LONG';
    const hatMatch = (wantBull && hat === 'BULL') || (!wantBull && hat === 'BEAR');
    if (!hatMatch) return this._result(direction, { state: 'NONE' });

    const rows = [];

    // ── Row 1: Candlestick pattern ─────────────────────────────────────────────
    const trendFiveBarsAgo = i >= 5 ? trendAt(features, i - 5) : null;
    const patterns = detectAll(daily, i, trendFiveBarsAgo);
    const candleList = wantBull ? patterns.bullish : patterns.bearish;

    // Strongest-first priority: star > engulf > piercing > hammer > plain candle
    const PRIORITY = ['morning-star', 'evening-star', 'bullish-engulfing', 'bearish-engulfing',
      'bullish-piercing', 'bearish-piercing', 'hammer', 'shooting-star',
      'hanging-man', 'plain-bullish', 'plain-bearish'];
    let bestPattern = null;
    for (const p of PRIORITY) {
      if (candleList.includes(p)) { bestPattern = p; break; }
    }

    const row1Status = bestPattern ? 'PASS' : 'FAIL';
    rows.push({ id: 'candlestick', label: 'Row 1 — Candlestick pattern',
      status: row1Status, detail: bestPattern || 'none' });

    if (row1Status !== 'PASS') {
      return this._result(direction, { state: 'NONE', rows });
    }

    // ── Row 2: Volume ──────────────────────────────────────────────────────────
    // Most significant candle for multi-bar patterns is the last (bar i).
    const vol = features.volRatio[i];
    const candleOk = wantBull ? daily[i].close > daily[i].open : daily[i].close < daily[i].open;
    const row2Status = (vol !== null && vol >= config.SWING_HEAVY_VOLUME_MULT && candleOk)
      ? 'PASS' : 'FAIL';
    rows.push({ id: 'volume', label: 'Row 2 — Volume',
      status: row2Status, detail: vol !== null ? `ratio=${vol.toFixed(2)}` : 'no data' });

    // ── Row 3: EMA crossover ───────────────────────────────────────────────────
    // NA when Row 1 is a morning/evening star (multi-bar pattern — EMA check is noise).
    const isStarPattern = bestPattern === 'morning-star' || bestPattern === 'evening-star';
    let row3Status;
    if (isStarPattern) {
      row3Status = 'NA';
    } else {
      const lb = config.SWING_CROSSOVER_LOOKBACK;
      const ema5  = features.ema5;
      const ema13 = features.ema13;
      const ema26 = features.ema26;
      const crossedAbove5_13 = crossedAbove(ema5, ema13, i, lb);
      const crossedAbove5_26 = crossedAbove(ema5, ema26, i, lb);
      const crossedBelow5_13 = crossedBelow(ema5, ema13, i, lb);
      const crossedBelow5_26 = crossedBelow(ema5, ema26, i, lb);
      if (wantBull) {
        row3Status = (crossedAbove5_13 || crossedAbove5_26) ? 'PASS' : 'FAIL';
      } else {
        row3Status = (crossedBelow5_13 || crossedBelow5_26) ? 'PASS' : 'FAIL';
      }
    }
    rows.push({ id: 'ema', label: 'Row 3 — EMA crossover', status: row3Status,
      detail: isStarPattern ? 'skipped (star pattern)' : '' });

    // ── Row 4: Chart pattern (JUDGMENT) ───────────────────────────────────────
    rows.push({ id: 'chartPattern', label: 'Row 4 — Chart pattern',
      status: 'JUDGMENT', detail: 'requires human review' });

    // ── Row 5: Fibonacci retracement (informational) ──────────────────────────
    const fib = retracementAt(daily, features.pivots, i);
    rows.push({ id: 'fib', label: 'Row 5 — Fibonacci retracement',
      status: 'NA', detail: fib ? `${fib.pct.toFixed(1)}% — ${fib.classification}` : 'no swing' });

    // ── Row 6: Divergence ──────────────────────────────────────────────────────
    const oscLabel = config.SWING_WAVE_OSCILLATOR === 'STOCH' ? 'stochK' : 'rsi14';
    const oscSeries = features[oscLabel];
    const div = detectDivergence(features.pivots, oscSeries, i, oscLabel);
    let row6Status;
    if (wantBull) {
      row6Status = div.bullish ? 'PASS' : (div.bearish ? 'FAIL' : 'NA');
    } else {
      row6Status = div.bearish ? 'PASS' : (div.bullish ? 'FAIL' : 'NA');
    }
    rows.push({ id: 'divergence', label: 'Row 6 — Divergence',
      status: row6Status, detail: `bullish=${div.bullish} bearish=${div.bearish}` });

    // ── Blockers ───────────────────────────────────────────────────────────────
    if (row1Status !== 'PASS' || row2Status !== 'PASS') {
      return this._result(direction, { state: 'NONE', rows });
    }
    if (row3Status === 'FAIL') {
      return this._result(direction, { state: 'NONE', rows });
    }
    if (row6Status === 'FAIL') {
      return this._result(direction, { state: 'NONE', rows });
    }

    // ── Stop loss ──────────────────────────────────────────────────────────────
    // Find the cross candle for the wave oscillator
    let crossIndex = i;
    const lb2 = config.SWING_CROSSOVER_LOOKBACK;
    if (config.SWING_WAVE_OSCILLATOR === 'STOCH') {
      for (let j = i; j >= Math.max(0, i - lb2); j--) {
        if (crossedAbove(features.stochK, features.stochD, j, 1) && wantBull) { crossIndex = j; break; }
        if (crossedBelow(features.stochK, features.stochD, j, 1) && !wantBull) { crossIndex = j; break; }
      }
    } else {
      const forty = new Array(features.rsi14.length).fill(40);
      const sixty = new Array(features.rsi14.length).fill(60);
      for (let j = i; j >= Math.max(0, i - lb2); j--) {
        if (crossedAbove(features.rsi14, forty, j, 1) && wantBull) { crossIndex = j; break; }
        if (crossedBelow(features.rsi14, sixty, j, 1) && !wantBull) { crossIndex = j; break; }
      }
    }

    let stopLoss;
    if (config.SWING_SMM_SL_MODE === 'SIG_CANDLE_MEDIAN') {
      const sigBar = daily[crossIndex];
      stopLoss = (sigBar.open + sigBar.close) / 2;
    } else {
      // OSC_PCO_CANDLE — low of the oscillator-cross candle for LONG, high for SHORT
      stopLoss = wantBull ? daily[crossIndex].low : daily[crossIndex].high;
    }

    // ── Target ─────────────────────────────────────────────────────────────────
    const levels = levelsAt(daily, features.pivots, i);
    const entry  = daily[i].close;
    const tgt    = targetFor(levels, entry, direction);

    if (tgt === null) {
      return this._result(direction, {
        state: 'WATCH', subtype: bestPattern, rows, stopLoss,
        target: null, blockedBy: 'NO_TARGET',
      });
    }

    // ── RR gate ────────────────────────────────────────────────────────────────
    const rr = riskReward(entry, stopLoss, tgt, direction);
    if (rr === null || rr <= config.SWING_MIN_RR) {
      return this._result(direction, {
        state: 'WATCH', subtype: bestPattern, rows, stopLoss,
        target: tgt, blockedBy: 'RR_GATE',
      });
    }

    return this._result(direction, {
      state: 'TRIGGERED', subtype: bestPattern, rows,
      stopLoss, target: tgt,
    });
  }
}

module.exports = SmmChecklistSetup;
