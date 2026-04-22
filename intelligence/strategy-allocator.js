/**
 * @file strategy-allocator.js
 * @description Selects which strategy (or strategies) to execute each evaluation cycle.
 *              Sits between registry.getEligible() and signal emission.
 *
 *              Three modes (config.STRATEGY_SELECTION_MODE):
 *                FIRST_MATCH  — execute first passing strategy (registry order = priority)
 *                BEST_SCORE   — execute highest-scoring passing strategy
 *                ALL_PASSING  — execute all passing strategies up to MAX_CONCURRENT_POSITIONS
 *
 *              Enforces:
 *                - MAX_CONCURRENT_POSITIONS cap across all strategies
 *                - Per-strategy capital allocation (STRATEGY_CAPITAL_PCT)
 *                - Global MAX_TRADES_PER_DAY cap from session context
 *
 *              Emits STRATEGY_SELECTED / STRATEGY_SKIPPED on the event bus.
 */
'use strict';

const eventBus       = require('../core/event-bus');
const EVENTS         = require('../core/events');
const config         = require('../config');
const CircuitBreaker = require('../core/circuit-breaker');

const circuitBreaker = new CircuitBreaker();

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [StrategyAllocator] [${level}] ${msg}`);
}

class StrategyAllocator {
  constructor() {
    // Tracks how many positions are currently open, keyed by strategy name
    this._openPositions = new Map(); // strategyName → count (0 or 1 for now)
    this._totalOpen     = 0;

    eventBus.on(EVENTS.POSITION_ACTIVE, (payload) => {
      const name = payload.strategy || 'unknown';
      this._openPositions.set(name, (this._openPositions.get(name) || 0) + 1);
      this._totalOpen++;
    });

    eventBus.on(EVENTS.POSITION_CLOSED, (payload) => {
      const name = payload.strategy || 'unknown';
      const current = this._openPositions.get(name) || 0;
      if (current > 0) {
        this._openPositions.set(name, current - 1);
        this._totalOpen = Math.max(0, this._totalOpen - 1);
      }
    });
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Given the output of registry.getEligible(), selects which strategies to run
   * based on STRATEGY_SELECTION_MODE and current position/capital state.
   *
   * @param {Array<{ strategy: object, result: object }>} eligible - Sorted by score desc
   * @param {object} sessionContext - snapshot() from SessionContext
   * @returns {Array<{ strategy: object, result: object }>} Strategies approved for execution
   */
  allocate(eligible, sessionContext) {
    if (eligible.length === 0) return [];

    // ── Global cap checks ────────────────────────────────────────────────────
    if (this._totalOpen >= config.MAX_CONCURRENT_POSITIONS) {
      log('INFO', `MAX_CONCURRENT_POSITIONS (${config.MAX_CONCURRENT_POSITIONS}) reached — skipping all`);
      this._emitSkipped(eligible, 'max_concurrent_positions_reached');
      return [];
    }

    const tradesRemaining = config.MAX_TRADES_PER_DAY - (sessionContext.tradesToday || 0);
    if (tradesRemaining <= 0) {
      log('INFO', `MAX_TRADES_PER_DAY (${config.MAX_TRADES_PER_DAY}) reached — skipping all`);
      this._emitSkipped(eligible, 'max_trades_per_day_reached');
      return [];
    }

    const mode = (config.STRATEGY_SELECTION_MODE || 'FIRST_MATCH').toUpperCase();
    let selected;

    if (mode === 'FIRST_MATCH') {
      selected = this._firstMatch(eligible);
    } else if (mode === 'BEST_SCORE') {
      selected = this._bestScore(eligible);
    } else if (mode === 'ALL_PASSING') {
      selected = this._allPassing(eligible, tradesRemaining);
    } else {
      log('WARN', `Unknown STRATEGY_SELECTION_MODE '${mode}' — falling back to FIRST_MATCH`);
      selected = this._firstMatch(eligible);
    }

    // Emit STRATEGY_SKIPPED for everything not selected
    const selectedNames = new Set(selected.map((s) => s.strategy.name));
    const skipped = eligible.filter((e) => !selectedNames.has(e.strategy.name));
    this._emitSkipped(skipped, 'not_selected_by_allocator');

    // Emit STRATEGY_SELECTED for each approved strategy
    for (const { strategy, result } of selected) {
      log('INFO', `Selected: ${strategy.name} [${mode}] score=${result.score}`);
      eventBus.emit(EVENTS.STRATEGY_SELECTED, {
        strategy: strategy.name,
        score:    result.score,
        mode,
      });
    }

    return selected;
  }

  /**
   * Returns current open position count for a given strategy.
   * Used by tests and position-tracker.
   * @param {string} strategyName
   * @returns {number}
   */
  getOpenCount(strategyName) {
    return this._openPositions.get(strategyName) || 0;
  }

  /**
   * Returns total open positions across all strategies.
   * @returns {number}
   */
  getTotalOpen() {
    return this._totalOpen;
  }

  // ── Selection modes ─────────────────────────────────────────────────────────

  /**
   * FIRST_MATCH: return the first capital-eligible strategy (registry order = priority).
   * @private
   */
  _firstMatch(eligible) {
    for (const candidate of eligible) {
      if (this._capitalAvailable(candidate.strategy.name)) {
        return [candidate];
      }
    }
    return [];
  }

  /**
   * BEST_SCORE: eligible is already sorted by score desc — pick the top capital-eligible one.
   * @private
   */
  _bestScore(eligible) {
    for (const candidate of eligible) {
      if (this._capitalAvailable(candidate.strategy.name)) {
        return [candidate];
      }
    }
    return [];
  }

  /**
   * ALL_PASSING: return every capital-eligible strategy up to remaining position slots.
   * @private
   */
  _allPassing(eligible, tradesRemaining) {
    const slotsAvailable = Math.min(
      config.MAX_CONCURRENT_POSITIONS - this._totalOpen,
      tradesRemaining
    );

    const selected = [];
    for (const candidate of eligible) {
      if (selected.length >= slotsAvailable) break;
      if (this._capitalAvailable(candidate.strategy.name)) {
        selected.push(candidate);
      }
    }
    return selected;
  }

  // ── Capital check ───────────────────────────────────────────────────────────

  /**
   * Returns true if the strategy has not already consumed its capital allocation.
   * For now: each strategy is allowed at most 1 concurrent position.
   * The STRATEGY_CAPITAL_PCT map is reserved for future lot-sizing.
   * @private
   */
  _capitalAvailable(strategyName) {
    // Block if this strategy's daily loss breaker is tripped
    if (circuitBreaker.isStrategyTripped(strategyName)) {
      log('INFO', `Strategy breaker tripped: ${strategyName} — skipping`);
      return false;
    }

    const alreadyOpen = this._openPositions.get(strategyName) || 0;
    if (alreadyOpen > 0) {
      log('INFO', `Capital cap: ${strategyName} already has an open position — skipping`);
      return false;
    }

    const pct = config.STRATEGY_CAPITAL_PCT[strategyName];
    if (pct === 0) {
      log('INFO', `Capital cap: ${strategyName} has 0% allocation — skipping`);
      return false;
    }

    return true;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** @private */
  _emitSkipped(candidates, reason) {
    for (const { strategy, result } of candidates) {
      eventBus.emit(EVENTS.STRATEGY_SKIPPED, {
        strategy: strategy.name,
        score:    result.score,
        reason,
      });
    }
  }
}

module.exports = new StrategyAllocator();
