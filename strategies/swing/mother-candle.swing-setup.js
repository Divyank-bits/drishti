/**
 * @file mother-candle.swing-setup.js
 * @description Phase 7: Mother Candle reversal and continuation setups.
 *              Source: PAPA #16 / #17 / #18.
 */

'use strict';

const config = require('../../config');
const { BaseSwingSetup, targetFor, riskReward, naRow } = require('./base.swing-setup');
const { trendAt, levelsAt } = require('../../analysis/swings');

class MotherCandleSetup extends BaseSwingSetup {
  get id()        { return 'mother-candle'; }
  get name()      { return 'Mother Candle'; }
  get sourceRef() { return 'PAPA #16/#17/#18'; }

  evaluate({ daily, features, i, direction }) {
    if (i < config.SWING_MOTHER_MIN_INSIDE + 2) return this._result(direction, { state: 'NONE' });

    const rows = [];
    const wantBull = direction === 'LONG';
    const atr = features.atr14[i];

    if (atr === null) return this._result(direction, { state: 'NONE' });

    // ── Find the Mother Candle ─────────────────────────────────────────────────
    // Mother: range >= SWING_MOTHER_ATR_MULT × ATR14, followed by at least
    //         SWING_MOTHER_MIN_INSIDE candles that stay inside the mother's high/low.
    const minInside = config.SWING_MOTHER_MIN_INSIDE;
    let motherIndex = -1;
    let motherHigh  = null;
    let motherLow   = null;

    for (let m = i - minInside - 1; m >= Math.max(0, i - config.SWING_SETUP_VALID_BARS - minInside); m--) {
      const moth = daily[m];
      const mothRange = moth.high - moth.low;
      if (mothRange < config.SWING_MOTHER_ATR_MULT * atr) continue;

      // Check that the next minInside candles stay inside the mother
      let allInside = true;
      let insideCount = 0;
      for (let k = m + 1; k <= i; k++) {
        if (daily[k].high <= moth.high && daily[k].low >= moth.low) {
          insideCount++;
        } else {
          break;
        }
      }
      if (insideCount >= minInside) {
        motherIndex = m;
        motherHigh  = moth.high;
        motherLow   = moth.low;
        break;
      }
    }

    if (motherIndex === -1) {
      rows.push({ id: 'mother', label: 'Mother candle + inside bars',
        status: 'FAIL', detail: 'no qualifying mother candle found' });
      return this._result(direction, { state: 'NONE', rows });
    }

    rows.push({ id: 'mother', label: 'Mother candle + inside bars',
      status: 'PASS', detail: `mother at bar ${motherIndex}: ${motherLow.toFixed(2)}-${motherHigh.toFixed(2)}` });

    // ── Classify: Reversal vs Continuation ────────────────────────────────────
    const levels = levelsAt(daily, features.pivots, i);
    const atPct  = config.SWING_AT_LEVEL_PCT / 100;

    // Check if mother is at a major support (LONG #16) or resistance (SHORT #17)
    const majors = wantBull
      ? levels.supports.filter(l => l.major)
      : levels.resistances.filter(l => l.major);

    let atMajorLevel = false;
    for (const lv of majors) {
      const ref = wantBull ? motherLow : motherHigh;
      if (Math.abs(ref - lv.price) / lv.price <= atPct) {
        atMajorLevel = true;
        break;
      }
    }

    const trend = trendAt(features, i);
    const trendOk = wantBull ? trend === 'UP' : trend === 'DOWN';
    const subtype = atMajorLevel ? 'REVERSAL' : (trendOk ? 'CONTINUATION' : null);

    if (subtype === null) {
      rows.push({ id: 'type', label: 'Reversal or continuation context',
        status: 'FAIL',
        detail: `not at major level and trend=${trend} (want ${wantBull ? 'UP' : 'DOWN'})` });
      return this._result(direction, { state: 'NONE', rows });
    }

    rows.push({ id: 'type', label: `${subtype} context`,
      status: 'PASS',
      detail: subtype === 'REVERSAL'
        ? (wantBull ? 'mother low at major support' : 'mother high at major resistance')
        : `trend ${trend}` });

    // NA rows for undefined course terms
    rows.push(naRow('bkp', wantBull ? 'BKP at major support' : 'BKT at major resistance'));

    // ── Trigger ────────────────────────────────────────────────────────────────
    const bar = daily[i];
    let triggered = false;

    if (subtype === 'REVERSAL') {
      // #16 LONG: close above mother's high; #17 SHORT: close below mother's low
      triggered = wantBull ? bar.close > motherHigh : bar.close < motherLow;
    } else {
      // #18 Continuation: close beyond mother in trend direction
      triggered = wantBull ? bar.close > motherHigh : bar.close < motherLow;
    }

    rows.push({ id: 'trigger', label: wantBull ? 'Close above mother high' : 'Close below mother low',
      status: triggered ? 'PASS' : 'FAIL',
      detail: wantBull
        ? `close=${bar.close.toFixed(2)} motherHigh=${motherHigh.toFixed(2)}`
        : `close=${bar.close.toFixed(2)} motherLow=${motherLow.toFixed(2)}` });

    if (!triggered) {
      return this._result(direction, { state: 'WATCH', subtype, rows });
    }

    // ── Stop loss: opposite end of the mother ─────────────────────────────────
    const stopLoss = wantBull ? motherLow : motherHigh;
    const entry    = bar.close;

    // ── Target ─────────────────────────────────────────────────────────────────
    const tgt = targetFor(levels, entry, direction);

    if (tgt === null) {
      return this._result(direction, {
        state: 'WATCH', subtype, rows, stopLoss, target: null, blockedBy: 'NO_TARGET',
      });
    }

    const rr = riskReward(entry, stopLoss, tgt, direction);
    if (rr === null || rr <= config.SWING_MIN_RR) {
      return this._result(direction, {
        state: 'WATCH', subtype, rows, stopLoss, target: tgt, blockedBy: 'RR_GATE',
      });
    }

    return this._result(direction, { state: 'TRIGGERED', subtype, rows, stopLoss, target: tgt });
  }
}

module.exports = MotherCandleSetup;
