/**
 * @file scan-scheduler.js
 * @description Runs a deep scan cycle every SCAN_INTERVAL_MINUTES via node-cron.
 *              Iterates WATCHLIST_SYMBOLS, calls symbol-scanner for each, and after
 *              each scan writes the result + options chain to the snapshot store.
 *              Also wires the watchlist-manager (imports it so it self-registers on SCAN_RESULT).
 */

'use strict';

const cron           = require('node-cron');
const eventBus       = require('../core/event-bus');
const EVENTS         = require('../core/events');
const config         = require('../config');
const symbolScanner  = require('./symbol-scanner');
const snapshotStore  = require('../data/snapshot-store');

// Import watchlist-manager so it self-registers its SCAN_RESULT listener on boot
require('./watchlist-manager');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [ScanScheduler] [${level}] ${msg}`);
}

class ScanScheduler {
  constructor() {
    this._running = false;
  }

  /**
   * Starts the cron-based scan cycle.
   * Fires immediately on boot, then every SCAN_INTERVAL_MINUTES.
   */
  start() {
    const interval = config.SCAN_INTERVAL_MINUTES;
    log('INFO', `Scan scheduler started — interval=${interval}m, symbols=${config.WATCHLIST_SYMBOLS.join(',')}`);

    cron.schedule(`*/${interval} * * * 1-5`, () => this._runCycle());

    // Run once immediately on boot (after a short delay for data layer warm-up)
    setTimeout(() => this._runCycle(), 10000);
  }

  /**
   * Scans all watchlist symbols sequentially (to avoid hammering NSE).
   * @private
   */
  async _runCycle() {
    if (this._running) {
      log('WARN', 'Previous scan cycle still running — skipping this tick');
      return;
    }

    this._running = true;
    const symbols = config.WATCHLIST_SYMBOLS;

    log('INFO', `Starting scan cycle — ${symbols.length} symbol(s)`);
    eventBus.emit(EVENTS.SCAN_STARTED, { symbols, timestamp: new Date().toISOString() });

    for (const symbol of symbols) {
      try {
        const result = await symbolScanner.scan(symbol);

        // Write scan result + chain snapshot to disk for Phase 7 backtesting
        if (result && !result.error && result.chain) {
          snapshotStore.write({
            ...result.chain,
            symbol:         result.symbol,
            scanScore:      result.score,
            strategyScores: result.strategyScores,
          });
        }
      } catch (err) {
        log('ERROR', `Scan failed for ${symbol}: ${err.message}`);
      }

      // Brief pause between symbols to be polite to NSE
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    this._running = false;
    log('INFO', 'Scan cycle complete');
  }
}

module.exports = new ScanScheduler();
