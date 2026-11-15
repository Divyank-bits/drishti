/**
 * @file counter-attack.swing-setup.js
 * @description Phase 7: Counter Attack (Bulls/Bears counter attack) setup.
 *              Source: PAPA #5 / #6.
 */

'use strict';

const config = require('../../config');
const { BaseSwingSetup, targetFor, riskReward, naRow } = require('./base.swing-setup');
const { levelsAt } = require('../../analysis/swings');

class CounterAttackSetup extends BaseSwingSetup {
  get id()        { return 'counter-attack'; }
  get name()      { return 'Counter Attack'; }
  get sourceRef() { return 'PAPA #5/#6'; }

  evaluate({ daily, features, i, direction }) {
    if (i < 2) return this._result(direction, { state: 'NONE' });

    const rows = [];
    const wantBull = direction === 'LONG';
    const levels = levelsAt(daily, features.pivots, i);

    // Find the nearest major level to test against
    // For LONG: find major support; for SHORT: find major resistance
    const majors = wantBull
      ? levels.supports.filter(l => l.major)
      : levels.resistances.filter(l => l.major);

    if (majors.length === 0) {
      rows.push({ id: 'level', label: wantBull ? 'Major support level' : 'Major resistance level',
        status: 'FAIL', detail: 'no major level found' });
      return this._result(direction, { state: 'NONE', rows });
    }

    const level = majors[0].price;

    // ── Observation: scan backward for the breakdown/breakout candle ──────────
    // A bar that opened below the support (LONG) or above resistance (SHORT)
    // and that is within the last SWING_SETUP_VALID_BARS bars.
    const maxLookback = config.SWING_SETUP_VALID_BARS;
    let obsIndex = -1;
    let counterAttackIndex = -1;

    for (let j = Math.max(0, i - maxLookback); j <= i; j++) {
      const bar = daily[j];
      if (wantBull) {
        // Opens below support
        if (bar.open < level) {
          obsIndex = j;
        }
      } else {
        // Opens above resistance
        if (bar.open > level) {
          obsIndex = j;
        }
      }
    }

    if (obsIndex === -1) {
      rows.push({ id: 'observation', label: wantBull ? 'Open below support' : 'Open above resistance',
        status: 'FAIL', detail: `level=${level.toFixed(2)} — no bar opened beyond it` });
      return this._result(direction, { state: 'NONE', rows });
    }

    rows.push({ id: 'observation', label: wantBull ? 'Open below support' : 'Open above resistance',
      status: 'PASS', detail: `level=${level.toFixed(2)}, bar ${obsIndex}` });

    // ── Trigger: obsIndex bar itself, or one within the next 3 bars [assumption],
    //    closes back above (LONG) / below (SHORT) the breakdown level ───────────
    for (let j = obsIndex; j <= Math.min(i, obsIndex + 3); j++) {
      const bar = daily[j];
      if (wantBull && bar.close > level) { counterAttackIndex = j; break; }
      if (!wantBull && bar.close < level) { counterAttackIndex = j; break; }
    }

    if (counterAttackIndex === -1) {
      rows.push({ id: 'trigger', label: 'Counter-attack close',
        status: 'FAIL', detail: 'price did not close back beyond level within 3 bars' });
      return this._result(direction, { state: 'WATCH', rows });
    }

    // Only signal when we're at or after the counter-attack bar
    if (counterAttackIndex > i) {
      rows.push({ id: 'trigger', label: 'Counter-attack close',
        status: 'FAIL', detail: 'trigger not yet reached' });
      return this._result(direction, { state: 'WATCH', rows });
    }

    rows.push({ id: 'trigger', label: 'Counter-attack close',
      status: 'PASS', detail: `bar ${counterAttackIndex} closed beyond level` });

    // ── Supportive rows ────────────────────────────────────────────────────────
    const vol = features.volRatio[counterAttackIndex];
    const volStatus = (vol !== null && vol >= config.SWING_HEAVY_VOLUME_MULT) ? 'PASS' : 'FAIL';
    rows.push({ id: 'volume', label: 'Volume confirmation',
      status: volStatus, detail: vol !== null ? `ratio=${vol.toFixed(2)}` : 'no data' });

    // "Lower BBC failed" is an undefined course term → NA
    rows.push(naRow('bbc', 'Lower BBC failed'));

    // ── Stop loss = low of the counter-attack candle (LONG) / high (SHORT) ─────
    const caBar  = daily[counterAttackIndex];
    const stopLoss = wantBull ? caBar.low : caBar.high;
    const entry    = daily[i].close;

    // ── Target ─────────────────────────────────────────────────────────────────
    const tgt = targetFor(levels, entry, direction);

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

module.exports = CounterAttackSetup;
