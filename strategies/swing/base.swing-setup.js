/**
 * @file base.swing-setup.js
 * @description Phase 7: abstract base class for swing setup plugins.
 *              Also exports shared helpers used by all setups:
 *              hatAt, targetFor, riskReward.
 */

'use strict';

const config = require('../../config');
const { tideAt } = require('../../analysis/features');
const { crossedAbove, crossedBelow } = require('../../analysis/swing-indicators');

// ── Abstract base ─────────────────────────────────────────────────────────────

class BaseSwingSetup {
  /** Unique kebab-case identifier — override in subclass */
  get id()        { throw new Error(`${this.constructor.name} must implement id`); }
  /** Human-readable name — override in subclass */
  get name()      { throw new Error(`${this.constructor.name} must implement name`); }
  /** Source reference string e.g. 'PAPA #5/#6' */
  get sourceRef() { throw new Error(`${this.constructor.name} must implement sourceRef`); }
  /** Array of supported directions: ['LONG','SHORT'] */
  get directions(){ return ['LONG', 'SHORT']; }

  /**
   * Evaluates the setup at bar i.
   * @param {{ daily: Array, features: object, i: number, direction: 'LONG'|'SHORT' }} ctx
   * @returns {object} — Setup Result Shape
   */
  evaluate(ctx) {  // eslint-disable-line no-unused-vars
    throw new Error(`${this.constructor.name} must implement evaluate()`);
  }

  /** Builds a skeleton result. Subclasses fill in state/rows/stop/target. */
  _result(direction, { state = 'NONE', subtype = null, rows = [], stopLoss = null, target = null, blockedBy = null } = {}) {
    const rr = (stopLoss !== null && target !== null)
      ? riskReward(null, stopLoss, target, direction) // provisional — real entry filled by backtester
      : null;
    return {
      setupId:    this.id,
      setupName:  this.name,
      sourceRef:  this.sourceRef,
      direction,
      subtype,
      state,
      asOf:       null,  // filled by caller with daily[i].date
      stopLoss,
      target,
      riskReward: rr,
      rows,
      blockedBy,
    };
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Computes the Hat (Tide × Wave) at bar i.
 * Returns 'BULL' | 'BEAR' | 'NONE'.
 *
 * Tide (weekly): tideAt() returns UP/FLAT_AFTER_DOWN → Buy; DOWN/FLAT_AFTER_UP → Sell.
 * Wave (daily):  Stochastic or RSI crossover within SWING_CROSSOVER_LOOKBACK bars.
 */
function hatAt(daily, features, i) {
  const tide = tideAt(daily, i);
  const tideBuy  = tide === 'UP' || tide === 'FLAT_AFTER_DOWN';
  const tideSell = tide === 'DOWN' || tide === 'FLAT_AFTER_UP';

  let waveBuy  = false;
  let waveSell = false;

  if (config.SWING_WAVE_OSCILLATOR === 'STOCH') {
    const { stochK, stochD } = features;
    const lookback = config.SWING_CROSSOVER_LOOKBACK;
    // Buy: %K crossed above %D within lookback bars, %K was at/below oversold in the 3 bars before the cross
    if (crossedAbove(stochK, stochD, i, lookback)) {
      // Check that %K was oversold in [i-lookback-2 .. i]
      const checkStart = Math.max(0, i - lookback - 2);
      for (let j = checkStart; j <= i; j++) {
        if (stochK[j] !== null && stochK[j] <= config.SWING_STOCH_OVERSOLD) { waveBuy = true; break; }
      }
    }
    // Sell: %K crossed below %D within lookback, %K was at/above overbought
    if (crossedBelow(stochK, stochD, i, lookback)) {
      const checkStart = Math.max(0, i - lookback - 2);
      for (let j = checkStart; j <= i; j++) {
        if (stochK[j] !== null && stochK[j] >= config.SWING_STOCH_OVERBOUGHT) { waveSell = true; break; }
      }
    }
  } else {
    // RSI mode: crossing up through 40 / down through 60
    const rsi = features.rsi14;
    const lookback = config.SWING_CROSSOVER_LOOKBACK;
    const forty  = new Array(rsi.length).fill(40);
    const sixty  = new Array(rsi.length).fill(60);
    if (crossedAbove(rsi, forty,  i, lookback)) waveBuy  = true;
    if (crossedBelow(rsi, sixty,  i, lookback)) waveSell = true;
  }

  if (tideBuy  && waveBuy)  return 'BULL';
  if (tideSell && waveSell) return 'BEAR';
  return 'NONE';
}

/**
 * Returns the nearest major level beyond the entry in the trade direction.
 * Returns null when no major level is found.
 *
 * @param {{ supports: Array, resistances: Array }} levels — from levelsAt
 * @param {number} entry — provisional entry price (close of signal bar)
 * @param {'LONG'|'SHORT'} direction
 * @returns {number|null}
 */
function targetFor(levels, entry, direction) {
  if (direction === 'LONG') {
    // Target = nearest major resistance above entry
    const candidates = levels.resistances.filter(l => l.major && l.price > entry);
    if (candidates.length === 0) return null;
    // Already sorted by distance from close (which ≈ entry)
    return candidates[0].price;
  } else {
    // Target = nearest major support below entry
    const candidates = levels.supports.filter(l => l.major && l.price < entry);
    if (candidates.length === 0) return null;
    return candidates[0].price;
  }
}

/**
 * Computes reward/risk ratio.
 * entry may be null; uses stop/target distance only.
 * @param {number|null} entry
 * @param {number}      stop
 * @param {number}      target
 * @param {'LONG'|'SHORT'} direction
 * @returns {number|null}
 */
function riskReward(entry, stop, target, direction) {
  if (stop === null || target === null) return null;
  const ref = entry !== null ? entry : (direction === 'LONG' ? stop + 1e-9 : stop - 1e-9);
  const risk   = Math.abs(ref - stop);
  const reward = Math.abs(target - ref);
  if (risk === 0) return null;
  return reward / risk;
}

/** NA row factory for undefined course terms */
function naRow(id, label) {
  return { id, label, status: 'NA', detail: 'undefined in source material' };
}

module.exports = { BaseSwingSetup, hatAt, targetFor, riskReward, naRow };
