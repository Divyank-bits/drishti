/**
 * @file nse-source.js
 * @description Polls NSE for NIFTY LTP (and any additional watchlist symbols) using stock-nse-india.
 * Emits TICK_RECEIVED {symbol, ltp, volume:0, timestamp} on each poll.
 * Supports multi-symbol polling via subscribeSymbol(symbol) for Phase 5 deep scan.
 */

'use strict';

const { NseIndia } = require('stock-nse-india');
const eventBus     = require('../../core/event-bus');
const EVENTS       = require('../../core/events');
const config       = require('../../config');

const nse = new NseIndia();
const POLL_MS = 3000;

// Market hours in UTC (IST - 5:30)
const MARKET_OPEN_UTC_H  = 3;   // 09:15 IST
const MARKET_OPEN_UTC_M  = 45;
const MARKET_CLOSE_UTC_H = 10;  // 15:30 IST
const MARKET_CLOSE_UTC_M = 0;

const MAX_FAILURES = 10;

// NSE index name mapping — used when polling index symbols via getEquityStockIndices
const INDEX_NAME_MAP = {
  NIFTY:     'NIFTY 50',
  BANKNIFTY: 'NIFTY BANK',
  FINNIFTY:  'NIFTY FIN SERVICE',
  MIDCPNIFTY:'NIFTY MIDCAP SELECT',
};

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [NseSource] [${level}] ${msg}`);
}

class NseSource {
  constructor() {
    this._timer            = null;
    this._failureCount     = 0;
    this._connectedEmitted = false;
    this._isWarmingUp      = false;
    // Primary symbol + any additional symbols added via subscribeSymbol()
    this._symbols          = new Set(['NIFTY']);
  }

  /**
   * Adds a symbol to the polling set. Safe to call before or after start().
   * @param {string} symbol — uppercase NSE symbol e.g. 'BANKNIFTY'
   */
  subscribeSymbol(symbol) {
    const sym = symbol.toUpperCase();
    if (!this._symbols.has(sym)) {
      this._symbols.add(sym);
      log('INFO', `Subscribed to additional symbol: ${sym}`);
    }
  }

  /**
   * Starts the polling sequence.
   * Performs a warm-up call to initialize NSE cookies before starting the interval.
   */
  async start() {
    if (this._isWarmingUp) return;
    this._isWarmingUp = true;

    // Subscribe watchlist symbols on boot
    for (const sym of config.WATCHLIST_SYMBOLS || []) {
      this.subscribeSymbol(sym);
    }

    log('INFO', 'Initializing NSE session (warm-up)...');

    try {
      await nse.getEquityStockIndices('NIFTY 50');
      log('INFO', 'NSE Session initialized successfully.');

      this._isWarmingUp = false;
      this._timer = setInterval(() => this._poll(), POLL_MS);
      this._poll();
    } catch (err) {
      log('ERROR', `Warm-up failed: ${err.message}. Retrying in 10s...`);
      this._isWarmingUp = false;
      setTimeout(() => this.start(), 10000);
    }
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    log('INFO', 'NSE polling stopped');
  }

  _isDuringMarketHours() {
    const now = new Date();
    const h   = now.getUTCHours();
    const m   = now.getUTCMinutes();
    const after  = h > MARKET_OPEN_UTC_H  || (h === MARKET_OPEN_UTC_H  && m >= MARKET_OPEN_UTC_M);
    const before = h < MARKET_CLOSE_UTC_H || (h === MARKET_CLOSE_UTC_H && m <= MARKET_CLOSE_UTC_M);
    return after && before;
  }

  async _poll() {
    if (!this._isDuringMarketHours()) return;

    try {
      // Fetch all index data in one call — covers NIFTY, BANKNIFTY, FINNIFTY etc.
      const data = await nse.getEquityStockIndices('NIFTY 50');

      let emittedCount = 0;

      for (const sym of this._symbols) {
        const indexName = INDEX_NAME_MAP[sym];
        let ltp = null;

        if (indexName && data.data) {
          const entry = data.data.find(idx => idx.index === indexName);
          ltp = entry?.last ?? null;
        }

        // Fallback: metadata carries NIFTY 50 last price
        if (!ltp && sym === 'NIFTY' && data.metadata) {
          ltp = data.metadata.last ?? null;
        }

        if (!ltp || ltp <= 0) continue;

        eventBus.emit(EVENTS.TICK_RECEIVED, {
          symbol:    sym,
          ltp:       parseFloat(ltp),
          volume:    0,
          timestamp: Date.now(),
        });

        emittedCount++;
      }

      if (emittedCount === 0) throw new Error('No valid LTP found for any subscribed symbol');

      this._failureCount = 0;

      if (!this._connectedEmitted) {
        eventBus.emit(EVENTS.WEBSOCKET_CONNECTED, { timestamp: Date.now() });
        this._connectedEmitted = true;
        log('INFO', 'First successful poll — WEBSOCKET_CONNECTED emitted');
      }

    } catch (err) {
      this._failureCount++;
      log('WARN', `Poll failed (${this._failureCount}/${MAX_FAILURES}): ${err.message}`);

      if (this._failureCount >= MAX_FAILURES) {
        log('ERROR', `${MAX_FAILURES} consecutive failures — signalling recovery`);
        eventBus.emit(EVENTS.WEBSOCKET_RECONNECT_FAILED, {
          reason:    `NSE library failed ${MAX_FAILURES} times consecutively`,
          timestamp: Date.now(),
        });
        this._failureCount = 0;
      }
    }
  }
}

module.exports = new NseSource();