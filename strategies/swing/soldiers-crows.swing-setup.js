/**
 * @file soldiers-crows.swing-setup.js
 * @description Phase 7: Three White Soldiers / Three Black Crows retest setup.
 *              Source: PAPA #3 / #4.
 */

'use strict';

const config = require('../../config');
const { BaseSwingSetup, targetFor, riskReward, naRow } = require('./base.swing-setup');
const { detectAll } = require('../../analysis/candles');
const { trendAt, levelsAt } = require('../../analysis/swings');

class SoldiersCrowsSetup extends BaseSwingSetup {
  get id()        { return 'soldiers-crows'; }
  get name()      { return 'Soldiers / Crows Retest'; }
  get sourceRef() { return 'PAPA #3/#4'; }

  evaluate({ daily, features, i, direction }) {
    if (i < 5) return this._result(direction, { state: 'NONE' });

    const rows = [];
    const wantBull = direction === 'LONG';
    const validBars = config.SWING_SETUP_VALID_BARS;

    // ── Find the Three White Soldiers / Three Black Crows pattern ──────────────
    // Scan backward within SWING_SETUP_VALID_BARS bars
    let soldierStart = -1;
    let soldierLow1  = null;
    let soldierHigh1 = null;
    let range2Low    = null;
    let range2High   = null;

    for (let s = i - 2; s >= Math.max(0, i - validBars - 2); s--) {
      const c1 = daily[s];
      const c2 = daily[s + 1];
      const c3 = daily[s + 2];
      if (!c1 || !c2 || !c3) continue;

      if (wantBull) {
        // Three White Soldiers: 3 consecutive bullish candles, each close > prev close,
        // each body >= 50% of range
        const b1 = c1.close > c1.open && (c1.close - c1.open) >= 0.5 * (c1.high - c1.low);
        const b2 = c2.close > c2.open && (c2.close - c2.open) >= 0.5 * (c2.high - c2.low)
                   && c2.close > c1.close;
        const b3 = c3.close > c3.open && (c3.close - c3.open) >= 0.5 * (c3.high - c3.low)
                   && c3.close > c2.close;
        if (b1 && b2 && b3) {
          soldierStart = s;
          soldierLow1  = c1.low;
          soldierHigh1 = c1.high;
          range2Low    = c2.low;
          range2High   = c2.high;
          break;
        }
      } else {
        // Three Black Crows: 3 consecutive bearish candles, each close < prev close,
        // each body >= 50% of range
        const b1 = c1.close < c1.open && (c1.open - c1.close) >= 0.5 * (c1.high - c1.low);
        const b2 = c2.close < c2.open && (c2.open - c2.close) >= 0.5 * (c2.high - c2.low)
                   && c2.close < c1.close;
        const b3 = c3.close < c3.open && (c3.open - c3.close) >= 0.5 * (c3.high - c3.low)
                   && c3.close < c2.close;
        if (b1 && b2 && b3) {
          soldierStart = s;
          soldierLow1  = c1.low;
          soldierHigh1 = c1.high;
          range2Low    = c2.low;
          range2High   = c2.high;
          break;
        }
      }
    }

    if (soldierStart === -1) {
      rows.push({ id: 'pattern', label: wantBull ? 'Three White Soldiers' : 'Three Black Crows',
        status: 'FAIL', detail: `none in last ${validBars} bars` });
      return this._result(direction, { state: 'NONE', rows });
    }

    rows.push({ id: 'pattern', label: wantBull ? 'Three White Soldiers' : 'Three Black Crows',
      status: 'PASS', detail: `found at bar ${soldierStart}` });

    // ── Check that price has pulled back into the 2nd soldier/crow's range ─────
    const bar = daily[i];
    if (wantBull) {
      // Current low must be inside or below the 2nd soldier's high–low range
      const inRange = bar.low <= range2High && bar.low >= range2Low - (range2High - range2Low);
      // But the close must be above the 1st soldier's low
      const aboveSl = bar.close > soldierLow1;
      if (!inRange || !aboveSl) {
        rows.push({ id: 'retest', label: 'Retest of 2nd soldier range',
          status: 'FAIL', detail: `low=${bar.low.toFixed(2)} range=${range2Low.toFixed(2)}-${range2High.toFixed(2)}` });
        return this._result(direction, { state: 'WATCH', rows, stopLoss: soldierLow1 });
      }
    } else {
      // For crows: current high must be inside or above the 2nd crow's high–low range
      const inRange = bar.high >= range2Low && bar.high <= range2High + (range2High - range2Low);
      const belowSl = bar.close < soldierHigh1;
      if (!inRange || !belowSl) {
        rows.push({ id: 'retest', label: 'Retest of 2nd crow range',
          status: 'FAIL', detail: `high=${bar.high.toFixed(2)} range=${range2Low.toFixed(2)}-${range2High.toFixed(2)}` });
        return this._result(direction, { state: 'WATCH', rows, stopLoss: soldierHigh1 });
      }
    }

    rows.push({ id: 'retest', label: wantBull ? 'Retest of 2nd soldier range' : 'Retest of 2nd crow range',
      status: 'PASS', detail: 'price pulled back into range' });

    // ── Trigger: bullish candle pattern at the retest ──────────────────────────
    const trendFiveBarsAgo = i >= 5 ? trendAt(features, i - 5) : null;
    const patterns = detectAll(daily, i, trendFiveBarsAgo);
    const candleList = wantBull ? patterns.bullish : patterns.bearish;
    const hasTrigger = candleList.length > 0;

    rows.push({ id: 'trigger', label: wantBull ? 'Bullish trigger candle' : 'Bearish trigger candle',
      status: hasTrigger ? 'PASS' : 'FAIL',
      detail: hasTrigger ? candleList[0] : 'no pattern' });

    if (!hasTrigger) {
      return this._result(direction, {
        state: 'WATCH', rows,
        stopLoss: wantBull ? soldierLow1 : soldierHigh1,
      });
    }

    // ── Stop loss ──────────────────────────────────────────────────────────────
    const stopLoss = wantBull ? soldierLow1 : soldierHigh1;

    // ── Target ─────────────────────────────────────────────────────────────────
    const levels = levelsAt(daily, features.pivots, i);
    const entry  = daily[i].close;
    const tgt    = targetFor(levels, entry, direction);

    if (tgt === null) {
      return this._result(direction, {
        state: 'WATCH', rows, stopLoss, target: null, blockedBy: 'NO_TARGET',
      });
    }

    const rr = riskReward(entry, stopLoss, tgt, direction);
    if (rr === null || rr <= config.SWING_MIN_RR) {
      return this._result(direction, {
        state: 'WATCH', rows, stopLoss, target: tgt, blockedBy: 'RR_GATE',
      });
    }

    return this._result(direction, { state: 'TRIGGERED', rows, stopLoss, target: tgt });
  }
}

module.exports = SoldiersCrowsSetup;
