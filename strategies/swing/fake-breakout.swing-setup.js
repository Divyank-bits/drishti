/**
 * @file fake-breakout.swing-setup.js
 * @description Phase 7: Fake Breakout / Fake Breakdown setup.
 *              Source: PAPA #12 / #13.
 */

'use strict';

const config = require('../../config');
const { BaseSwingSetup, targetFor, riskReward, naRow } = require('./base.swing-setup');
const { levelsAt } = require('../../analysis/swings');
const { detectDivergence } = require('../../analysis/divergence');

class FakeBreakoutSetup extends BaseSwingSetup {
  get id()        { return 'fake-breakout'; }
  get name()      { return 'Fake Breakout / Fake Breakdown'; }
  get sourceRef() { return 'PAPA #12/#13'; }

  evaluate({ daily, features, i, direction }) {
    if (i < 3) return this._result(direction, { state: 'NONE' });

    const rows = [];
    const wantShort = direction === 'SHORT';  // #12 = SHORT (fake BO), #13 = LONG (fake BD)
    const wantBull  = direction === 'LONG';

    const levels = levelsAt(daily, features.pivots, i);

    // ── Find relevant major level ──────────────────────────────────────────────
    // SHORT (fake BO): watch for price breaking above a major resistance
    // LONG  (fake BD): watch for price breaking below a major support
    const majors = wantBull
      ? levels.supports.filter(l => l.major)
      : levels.resistances.filter(l => l.major);

    if (majors.length === 0) {
      rows.push({ id: 'level', label: wantBull ? 'Major support (breakdown level)' : 'Major resistance (breakout level)',
        status: 'FAIL', detail: 'no major level found' });
      return this._result(direction, { state: 'NONE', rows });
    }

    const level = majors[0].price;

    // ── Find the breakout / breakdown candle ───────────────────────────────────
    // Scan backward within SWING_SETUP_VALID_BARS bars for a candle that
    // closed beyond the level.
    const validBars = config.SWING_SETUP_VALID_BARS;
    let breakoutIndex = -1;

    for (let j = i - 1; j >= Math.max(0, i - validBars); j--) {
      const bar = daily[j];
      if (wantBull) {
        // Fake BD: a candle that closed below major support
        if (bar.close < level) { breakoutIndex = j; break; }
      } else {
        // Fake BO: a candle that closed above major resistance
        if (bar.close > level) { breakoutIndex = j; break; }
      }
    }

    if (breakoutIndex === -1) {
      rows.push({ id: 'breakout', label: wantBull ? 'Close below support' : 'Close above resistance',
        status: 'FAIL', detail: `level=${level.toFixed(2)} — no bar closed beyond it in last ${validBars} bars` });
      return this._result(direction, { state: 'NONE', rows });
    }

    rows.push({ id: 'breakout', label: wantBull ? 'Breakdown candle (fake BD)' : 'Breakout candle (fake BO)',
      status: 'PASS', detail: `bar ${breakoutIndex}, level=${level.toFixed(2)}` });

    const boBar = daily[breakoutIndex];

    // ── Trigger: follow-up candle closes back beyond the level ────────────────
    // LONG  (fake BD): a bullish candle that closes above breakdown candle's high AND above level
    // SHORT (fake BO): a bearish candle that closes below breakout candle's low AND below level
    const bar = daily[i];
    let triggered = false;

    if (wantBull) {
      // Fake BD (LONG): bullish follow-up closes above breakdown candle's high AND above level
      triggered = bar.close > boBar.high && bar.close > level;
    } else {
      // For fake BO (SHORT): bearish follow-up closes below boBar.low AND below level
      triggered = bar.close < boBar.low && bar.close < level;
    }

    rows.push({ id: 'trigger', label: wantBull ? 'Close above breakdown candle high + level' : 'Close below breakout candle low + level',
      status: triggered ? 'PASS' : 'FAIL',
      detail: wantBull
        ? `close=${bar.close.toFixed(2)} boHigh=${boBar.high.toFixed(2)} level=${level.toFixed(2)}`
        : `close=${bar.close.toFixed(2)} boLow=${boBar.low.toFixed(2)} level=${level.toFixed(2)}` });

    if (!triggered) {
      return this._result(direction, { state: 'WATCH', rows });
    }

    // ── Supportive rows ────────────────────────────────────────────────────────
    // Divergence check
    const oscLabel = config.SWING_WAVE_OSCILLATOR === 'STOCH' ? 'stochK' : 'rsi14';
    const div = detectDivergence(features.pivots, features[oscLabel], i, oscLabel);
    if (wantBull) {
      rows.push({ id: 'divergence', label: 'Bullish divergence',
        status: div.bullish ? 'PASS' : 'NA',
        detail: div.bullish ? 'confirmed' : 'none' });
    } else {
      rows.push({ id: 'divergence', label: 'Bearish divergence',
        status: div.bearish ? 'PASS' : 'NA',
        detail: div.bearish ? 'confirmed' : 'none' });
    }

    // Volume confirmation
    const vol = features.volRatio[i];
    rows.push({ id: 'volume', label: 'Volume confirmation',
      status: (vol !== null && vol >= config.SWING_HEAVY_VOLUME_MULT) ? 'PASS' : 'FAIL',
      detail: vol !== null ? `ratio=${vol.toFixed(2)}` : 'no data' });

    // "BKT" is an undefined course term → NA
    rows.push(naRow('bkt', 'BKT'));

    // ── Stop loss: high of breakout candle (SHORT) / low of breakdown candle (LONG) ─
    const stopLoss = wantBull ? boBar.low : boBar.high;
    const entry    = bar.close;

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

module.exports = FakeBreakoutSetup;
