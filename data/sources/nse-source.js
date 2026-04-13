/**
 * @file nse-source.js
 * @description Polls NSE for NIFTY LTP every 3 seconds during market hours.
 *              Emits TICK_RECEIVED {symbol, ltp, volume:0, timestamp} on each poll.
 *              Used when DATA_SOURCE='NSE' (default, no paid subscription required).
 *
 *              Volume is 0 — NSE quote endpoint does not return volume.
 *              Anti-hunt volume rules will treat 0-volume ticks as "data unavailable"
 *              and fall back to candle-level volume (Phase 2).
 */

'use strict';

const axios    = require('axios');
const eventBus = require('../../core/event-bus');
const EVENTS   = require('../../core/events');

const NSE_BASE   = 'https://www.nseindia.com';
const NSE_QUOTE  = `${NSE_BASE}/api/quote-equity?symbol=NIFTY%2050`;
const UA         = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
const POLL_MS    = 3000;  // 3 second polling interval

// Market hours in UTC (IST - 5:30)
const MARKET_OPEN_UTC_H  = 3;   // 09:15 IST
const MARKET_OPEN_UTC_M  = 45;
const MARKET_CLOSE_UTC_H = 10;  // 15:30 IST
const MARKET_CLOSE_UTC_M = 0;

// Consecutive failure threshold before emitting WEBSOCKET_RECONNECT_FAILED
// 10 polls × 3s = 30s — matches WEBSOCKET_RECONNECT_TIMEOUT in config
const MAX_FAILURES = 10;

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [NseSource] [${level}] ${msg}`);
}

class NseSource {
  constructor() {
    this._cookie          = null;
    this._timer           = null;
    this._failureCount    = 0;
    this._connectedEmitted = false;
  }

  start() {
    log('INFO', `Starting NSE LTP polling every ${POLL_MS / 1000}s`);
    this._timer = setInterval(() => this._poll(), POLL_MS);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
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
      if (!this._cookie) await this._refreshCookie();

      const res = await axios.get(NSE_QUOTE, {
        headers: { 'User-Agent': UA, 'Referer': NSE_BASE, 'Cookie': this._cookie },
        timeout: 5000,
      });

      const ltp = res.data?.priceInfo?.lastPrice;
      if (!ltp || ltp <= 0) throw new Error('Invalid LTP in response');

      this._failureCount = 0;

      if (!this._connectedEmitted) {
        eventBus.emit(EVENTS.WEBSOCKET_CONNECTED, { timestamp: Date.now() });
        this._connectedEmitted = true;
        log('INFO', 'First successful poll — WEBSOCKET_CONNECTED emitted');
      }

      eventBus.emit(EVENTS.TICK_RECEIVED, {
        symbol:    'NIFTY',
        ltp,
        volume:    0,
        timestamp: Date.now(),
      });
    } catch (err) {
      this._cookie = null; // force cookie refresh next poll
      this._failureCount++;
      log('WARN', `Poll failed (${this._failureCount}/${MAX_FAILURES}): ${err.message}`);

      if (this._failureCount >= MAX_FAILURES) {
        log('ERROR', `${MAX_FAILURES} consecutive failures — emitting WEBSOCKET_RECONNECT_FAILED`);
        eventBus.emit(EVENTS.WEBSOCKET_RECONNECT_FAILED, {
          reason:    `NSE polling failed ${MAX_FAILURES} times consecutively`,
          timestamp: Date.now(),
        });
        this._failureCount = 0; // reset so circuit breaker (not this module) decides next step
      }
    }
  }

  async _refreshCookie() {
    const r = await axios.get(NSE_BASE, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 8000,
    });
    this._cookie = (r.headers['set-cookie'] || []).join('; ');
  }
}

module.exports = new NseSource();
