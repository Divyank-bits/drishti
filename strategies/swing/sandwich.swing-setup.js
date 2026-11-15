/**
 * @file sandwich.swing-setup.js
 * @description Phase 7: Sandwich (range breakout) setup.
 *              Source: PAPA #7.
 */

'use strict';

const config = require('../../config');
const { BaseSwingSetup, targetFor, riskReward, naRow } = require('./base.swing-setup');
const { levelsAt } = require('../../analysis/swings');

class SandwichSetup extends BaseSwingSetup {
  get id()        { return 'sandwich'; }
  get name()      { return 'Sandwich Breakout'; }
  get sourceRef() { return 'PAPA #7'; }

  evaluate({ daily, features, i, direction }) {
    if (i < 5) return this._result(direction, { state: 'NONE' });

    const rows = [];
    const wantBull = direction === 'LONG';
    const atr = features.atr14[i];

    if (atr === null) {
      return this._result(direction, { state: 'NONE' });
    }

    // ── Observation: find at least 4 consecutive alternating red/green candles ─
    // whose combined high-low range is <= 2 × ATR14 [assumption for "ranging"]
    // Look back enough bars to find the pattern
    const minInside = 4;
    let rangeStart = -1;
    let rangeHigh  = -Infinity;
    let rangeLow   = Infinity;

    // Scan backward to find the most recent qualifying sandwich range
    for (let start = i - 1; start >= Math.max(0, i - config.SWING_SETUP_VALID_BARS); start--) {
      // Collect consecutive alternating candles ending at start + count - 1
      let count = 0;
      let rHigh  = -Infinity;
      let rLow   =  Infinity;

      for (let j = start; j <= i - 1; j++) {
        const c = daily[j];
        // Check alternating: each candle must be opposite color to previous
        if (count > 0) {
          const prevBull = daily[j - 1].close > daily[j - 1].open;
          const thisBull = c.close > c.open;
          if (prevBull === thisBull) break; // not alternating
        }
        rHigh  = Math.max(rHigh, c.high);
        rLow   = Math.min(rLow, c.low);
        count++;
      }

      if (count >= minInside && (rHigh - rLow) <= 2 * atr) {
        rangeStart = start;
        rangeHigh  = rHigh;
        rangeLow   = rLow;
        break;
      }
    }

    if (rangeStart === -1) {
      rows.push({ id: 'range', label: `≥${minInside} alternating candles in range`,
        status: 'FAIL', detail: 'no sandwich range found' });
      return this._result(direction, { state: 'NONE', rows });
    }

    rows.push({ id: 'range', label: `≥${minInside} alternating candles in range`,
      status: 'PASS', detail: `start=${rangeStart} range=${rangeLow.toFixed(2)}-${rangeHigh.toFixed(2)} (${(rangeHigh-rangeLow).toFixed(2)} vs 2×ATR=${(2*atr).toFixed(2)})` });

    // ── Trigger ────────────────────────────────────────────────────────────────
    // LONG:  bar i closes above the previous candle's high
    // SHORT: bar i closes below the previous candle's low
    const bar  = daily[i];
    const prev = daily[i - 1];

    let triggered = false;
    if (wantBull) {
      triggered = bar.close > prev.high;
    } else {
      triggered = bar.close < prev.low;
    }

    rows.push({ id: 'trigger', label: wantBull ? 'Close above prev high' : 'Close below prev low',
      status: triggered ? 'PASS' : 'FAIL',
      detail: wantBull
        ? `close=${bar.close.toFixed(2)} prevHigh=${prev.high.toFixed(2)}`
        : `close=${bar.close.toFixed(2)} prevLow=${prev.low.toFixed(2)}` });

    if (!triggered) {
      return this._result(direction, { state: 'WATCH', rows });
    }

    // ── Stop loss: low of the breakout candle (LONG) / high of breakdown (SHORT) ─
    const stopLoss = wantBull ? bar.low : bar.high;
    const entry    = bar.close;

    // ── Target ─────────────────────────────────────────────────────────────────
    const levels = levelsAt(daily, features.pivots, i);
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

module.exports = SandwichSetup;
