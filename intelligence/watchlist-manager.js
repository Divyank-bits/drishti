/**
 * @file watchlist-manager.js
 * @description Maintains an in-memory ranked list of symbols by scan score.
 *              Emits WATCHLIST_UPDATED whenever the ranking changes.
 *              Scores expire after SCAN_INTERVAL_MINUTES × 2 — stale symbols drop automatically.
 *              Capped at SCAN_MAX_SYMBOLS entries.
 */

'use strict';

const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const config   = require('../config');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [WatchlistManager] [${level}] ${msg}`);
}

class WatchlistManager {
  constructor() {
    // Map of symbol → { score, timestamp, strategyScores, chain }
    this._entries = new Map();
    this._ttlMs   = config.SCAN_INTERVAL_MINUTES * 2 * 60 * 1000;

    eventBus.on(EVENTS.SCAN_RESULT, (payload) => this._onScanResult(payload));
  }

  /**
   * Called on each SCAN_RESULT. Updates the ranking and evicts stale entries.
   * @param {object} payload — SCAN_RESULT event data
   */
  _onScanResult(payload) {
    if (!payload.symbol || payload.error) return;

    this._evictStale();

    const previous = this._entries.get(payload.symbol);
    this._entries.set(payload.symbol, {
      score:          payload.score,
      timestamp:      Date.now(),
      strategyScores: payload.strategyScores,
      chain:          payload.chain,
      indicators:     payload.indicators,
    });

    // Enforce max symbols — evict lowest-scoring if over cap
    if (this._entries.size > config.SCAN_MAX_SYMBOLS) {
      const sorted = this._getSorted();
      const evict  = sorted[sorted.length - 1];
      this._entries.delete(evict.symbol);
      log('DEBUG', `Evicted ${evict.symbol} (lowest score=${evict.score}) — cap reached`);
    }

    const scoreChanged = !previous || previous.score !== payload.score;
    if (scoreChanged) {
      const ranked = this._getSorted();
      log('INFO', `Watchlist updated — ${ranked.length} symbols. Top: ${ranked[0]?.symbol ?? 'none'} (${ranked[0]?.score ?? 0})`);
      eventBus.emit(EVENTS.WATCHLIST_UPDATED, { ranked, timestamp: new Date().toISOString() });
    }
  }

  _evictStale() {
    const now = Date.now();
    for (const [sym, entry] of this._entries) {
      if (now - entry.timestamp > this._ttlMs) {
        this._entries.delete(sym);
        log('DEBUG', `Evicted stale entry: ${sym}`);
      }
    }
  }

  _getSorted() {
    return [...this._entries.entries()]
      .map(([symbol, entry]) => ({ symbol, ...entry }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Returns the current ranked watchlist (score descending).
   * @returns {Array<{ symbol, score, timestamp, strategyScores, chain }>}
   */
  getRanked() {
    this._evictStale();
    return this._getSorted();
  }

  /**
   * Returns the score for a specific symbol, or null if not in watchlist / stale.
   * @param {string} symbol
   * @returns {number|null}
   */
  getScore(symbol) {
    const entry = this._entries.get(symbol.toUpperCase());
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this._ttlMs) {
      this._entries.delete(symbol.toUpperCase());
      return null;
    }
    return entry.score;
  }
}

module.exports = new WatchlistManager();
