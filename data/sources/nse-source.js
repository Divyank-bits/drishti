/**
 * @file nse-source.js
 * @description Polls NSE for NIFTY LTP using stock-nse-india package.
 * Emits TICK_RECEIVED {symbol, ltp, volume:0, timestamp} on each poll.
 * Handles session initialization and cookie refreshes automatically.
 */

'use strict';

const { NseIndia } = require('stock-nse-india');
const eventBus     = require('../../core/event-bus');
const EVENTS       = require('../../core/events');

const nse = new NseIndia();
const POLL_MS = 3000; 

// Market hours in UTC (IST - 5:30)
const MARKET_OPEN_UTC_H  = 3;   // 09:15 IST
const MARKET_OPEN_UTC_M  = 45;
const MARKET_CLOSE_UTC_H = 10;  // 15:30 IST
const MARKET_CLOSE_UTC_M = 0;

const MAX_FAILURES = 10;

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
  }

  /**
   * Starts the polling sequence.
   * Performs a warm-up call to initialize NSE cookies before starting the interval.
   */
  async start() {
    if (this._isWarmingUp) return;
    this._isWarmingUp = true;

    log('INFO', 'Initializing NSE session (warm-up)...');
    
    try {
      // Library handshake: visiting the index page to get cookies
      await nse.getEquityStockIndices("NIFTY 50");
      log('INFO', 'NSE Session initialized successfully.');
      
      this._isWarmingUp = false;
      this._timer = setInterval(() => this._poll(), POLL_MS);
      this._poll(); // run first poll immediately
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
    // Only poll during market hours to avoid unnecessary 403s
    if (!this._isDuringMarketHours()) return;

    try {
      // Fetch data for NIFTY 50 index
      const data = await nse.getEquityStockIndices("NIFTY 50");
      
      // Find the NIFTY 50 entry in the indices list
      const nifty = data.data.find(idx => idx.index === "NIFTY 50");
      const ltp = nifty?.last;

      if (!ltp || ltp <= 0) throw new Error('Invalid LTP in library response');

      this._failureCount = 0;

      if (!this._connectedEmitted) {
        eventBus.emit(EVENTS.WEBSOCKET_CONNECTED, { timestamp: Date.now() });
        this._connectedEmitted = true;
        log('INFO', 'First successful poll — WEBSOCKET_CONNECTED emitted');
      }

      eventBus.emit(EVENTS.TICK_RECEIVED, {
        symbol:    'NIFTY',
        ltp:       parseFloat(ltp),
        volume:    0, // Library index data doesn't provide real-time volume
        timestamp: Date.now(),
      });

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

  async _poll2() {
  try {
    // Test with a specific stock instead of the index during off-market hours
    const data = await nse.getEquityDetails("RELIANCE");
    const ltp = data.priceInfo.lastPrice;

    if (!ltp || ltp <= 0) throw new Error('Invalid LTP in library response');

    this._failureCount = 0;
    log('INFO', `Test Success: RELIANCE LTP is ${ltp}`);

    eventBus.emit(EVENTS.TICK_RECEIVED, {
      symbol:    'RELIANCE',
      ltp:       parseFloat(ltp),
      volume:    0,
      timestamp: Date.now(),
    });

  } catch (err) {
    this._failureCount++;
    log('WARN', `Poll failed (${this._failureCount}/${MAX_FAILURES}): ${err.message}`);
    // ... rest of error handling
  }
}
}

module.exports = new NseSource();