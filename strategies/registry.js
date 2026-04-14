/**
 * @file registry.js
 * @description Strategy registry that auto-discovers and validates all strategy files
 *              in the /strategies folder. A new strategy becomes active simply by
 *              adding a [name].strategy.js file — no changes to any other file needed.
 *
 *              Excludes: base.strategy.js and registry.js itself.
 *              Validates: each discovered file must export a class that extends BaseStrategy.
 */

const fs = require('fs');
const path = require('path');
const BaseStrategy = require('./base.strategy');

class StrategyRegistry {
  constructor() {
    this._strategies = [];
    this._discover();
  }

  // ── Discovery ─────────────────────────────────────────────────────────────

  /**
   * Scans the /strategies directory and loads all valid strategy files.
   * @private
   */
  _discover() {
    const dir = __dirname;
    const EXCLUDED = new Set(['base.strategy.js', 'registry.js']);

    let files;
    try {
      files = fs.readdirSync(dir).filter(
        (f) => f.endsWith('.strategy.js') && !EXCLUDED.has(f)
      );
    } catch (err) {
      throw new Error(`[Registry] Cannot read strategies directory: ${err.message}`);
    }

    for (const file of files) {
      this._load(path.join(dir, file), file);
    }

    const ts = new Date().toTimeString().slice(0, 8);
    console.log(
      `[${ts}] [Registry] [INFO] ${this._strategies.length} strategy/strategies loaded: ` +
      `[${this._strategies.map((s) => s.name).join(', ') || 'none'}]`
    );
  }

  /**
   * Loads a single strategy file, validates it, and registers the instance.
   * @private
   */
  _load(filePath, filename) {
    let StrategyClass;
    try {
      StrategyClass = require(filePath);
    } catch (err) {
      throw new Error(`[Registry] Failed to load ${filename}: ${err.message}`);
    }

    // Accept either a class (function) or a pre-instantiated singleton object
    let instance;
    if (typeof StrategyClass === 'function') {
      try {
        instance = new StrategyClass();
      } catch (err) {
        throw new Error(`[Registry] Cannot instantiate ${filename}: ${err.message}`);
      }
    } else if (typeof StrategyClass === 'object' && StrategyClass !== null) {
      instance = StrategyClass;
    } else {
      throw new Error(`[Registry] ${filename} must export a class or singleton instance, got ${typeof StrategyClass}`);
    }

    // Must extend BaseStrategy
    if (!(instance instanceof BaseStrategy)) {
      throw new Error(`[Registry] ${filename} must extend BaseStrategy`);
    }

    // Validate required getters are implemented (not throwing the base class error)
    const REQUIRED = ['name', 'regime', 'claudeDescription'];
    for (const getter of REQUIRED) {
      try {
        const val = instance[getter];
        if (val === undefined || val === null) {
          throw new Error(`getter '${getter}' returned undefined/null`);
        }
      } catch (err) {
        throw new Error(`[Registry] ${filename} has unimplemented getter '${getter}': ${err.message}`);
      }
    }

    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`[${ts}] [Registry] [INFO] Registered: ${instance.name} (regime: ${instance.regime})`);
    this._strategies.push(instance);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns all registered strategy instances.
   * @returns {BaseStrategy[]}
   */
  getAll() {
    return [...this._strategies];
  }

  /**
   * Returns strategies that support a given market regime.
   * @param {string} regime - "A" | "B" | "C"
   * @returns {BaseStrategy[]}
   */
  getByRegime(regime) {
    return this._strategies.filter((s) => s.supportsRegime(regime));
  }

  /**
   * Scores all regime-eligible strategies against current market data and
   * returns the best one. Returns null if no strategy is eligible.
   *
   * @param {object} marketData - Full market snapshot
   * @param {string} regime - Current market regime
   * @returns {{ strategy: BaseStrategy, result: object } | null}
   */
  getBestForMarket(marketData, regime) {
    const candidates = this.getByRegime(regime);

    const scored = candidates
      .map((strategy) => {
        try {
          const result = strategy.checkConditions(marketData);
          return { strategy, result };
        } catch (err) {
          const ts = new Date().toTimeString().slice(0, 8);
          console.error(
            `[${ts}] [Registry] [ERROR] ${strategy.name}.checkConditions() threw: ${err.message}`
          );
          return null;
        }
      })
      .filter((r) => r !== null && r.result.eligible);

    if (scored.length === 0) return null;

    // Sort by score descending; prefer non-directional on tie
    scored.sort((a, b) => b.result.score - a.result.score);
    return scored[0];
  }

  /**
   * Returns the count of registered strategies.
   * @returns {number}
   */
  get count() {
    return this._strategies.length;
  }
}

// Export singleton — instantiated once on first require()
module.exports = new StrategyRegistry();
