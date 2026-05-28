/**
 * @file registry.js
 * @description Equity strategy registry that auto-discovers all *.equity-strategy.js files
 *              in this directory. A new equity strategy becomes active simply by dropping a
 *              conforming file here — no changes to any other file needed.
 *
 *              Excludes: base.equity-strategy.js and registry.js itself.
 *              Validates: each file must export a class or singleton extending BaseEquityStrategy
 *              and implementing the required getters + checkPattern().
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const BaseEquityStrategy = require('./base.equity-strategy');

class EquityStrategyRegistry {
  constructor() {
    this._strategies = [];
    this._discover();
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  _discover() {
    const dir = __dirname;
    const EXCLUDED = new Set(['base.equity-strategy.js', 'registry.js']);

    let files;
    try {
      files = fs.readdirSync(dir).filter(
        (f) => f.endsWith('.equity-strategy.js') && !EXCLUDED.has(f)
      );
    } catch (err) {
      throw new Error(`[EquityRegistry] Cannot read equity strategies directory: ${err.message}`);
    }

    for (const file of files) {
      this._load(path.join(dir, file), file);
    }

    const ts = new Date().toTimeString().slice(0, 8);
    console.log(
      `[${ts}] [EquityRegistry] [INFO] ${this._strategies.length} equity strategy/strategies loaded: ` +
      `[${this._strategies.map((s) => s.name).join(', ') || 'none'}]`
    );
  }

  _load(filePath, filename) {
    let StrategyClass;
    try {
      StrategyClass = require(filePath);
    } catch (err) {
      throw new Error(`[EquityRegistry] Failed to load ${filename}: ${err.message}`);
    }

    let instance;
    if (typeof StrategyClass === 'function') {
      try {
        instance = new StrategyClass();
      } catch (err) {
        throw new Error(`[EquityRegistry] Cannot instantiate ${filename}: ${err.message}`);
      }
    } else if (typeof StrategyClass === 'object' && StrategyClass !== null) {
      instance = StrategyClass;
    } else {
      throw new Error(
        `[EquityRegistry] ${filename} must export a class or singleton, got ${typeof StrategyClass}`
      );
    }

    if (!(instance instanceof BaseEquityStrategy)) {
      throw new Error(`[EquityRegistry] ${filename} must extend BaseEquityStrategy`);
    }

    const REQUIRED_GETTERS = ['name', 'direction', 'description'];
    for (const getter of REQUIRED_GETTERS) {
      try {
        const val = instance[getter];
        if (val === undefined || val === null) {
          throw new Error(`getter '${getter}' returned undefined/null`);
        }
      } catch (err) {
        throw new Error(
          `[EquityRegistry] ${filename} has unimplemented getter '${getter}': ${err.message}`
        );
      }
    }

    if (typeof instance.checkPattern !== 'function') {
      throw new Error(`[EquityRegistry] ${filename} must implement checkPattern()`);
    }

    const ts = new Date().toTimeString().slice(0, 8);
    console.log(
      `[${ts}] [EquityRegistry] [INFO] Registered: ${instance.name} (${instance.direction})`
    );
    this._strategies.push(instance);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns all registered equity strategy instances.
   * @returns {BaseEquityStrategy[]}
   */
  getAll() {
    return [...this._strategies];
  }

  /**
   * Returns strategies that match a given direction.
   * @param {'BULLISH' | 'BEARISH' | 'NEUTRAL'} direction
   * @returns {BaseEquityStrategy[]}
   */
  getByDirection(direction) {
    return this._strategies.filter((s) => s.direction === direction);
  }

  /**
   * Runs checkPattern() on all registered strategies for a given timeframe.
   * Skips strategies that throw instead of crashing the scan.
   *
   * @param {object} params - Same shape as BaseEquityStrategy.checkPattern() params
   * @returns {Array<{ strategy: BaseEquityStrategy, result: object }>}
   */
  runAll(params) {
    const results = [];
    for (const strategy of this._strategies) {
      try {
        const result = strategy.checkPattern(params);
        results.push({ strategy, result });
      } catch (err) {
        const ts = new Date().toTimeString().slice(0, 8);
        console.error(
          `[${ts}] [EquityRegistry] [ERROR] ${strategy.name}.checkPattern() threw: ${err.message}`
        );
      }
    }
    return results;
  }

  /**
   * Returns the count of registered equity strategies.
   * @returns {number}
   */
  get count() {
    return this._strategies.length;
  }
}

module.exports = new EquityStrategyRegistry();
