/**
 * @file historical.js
 * @description Fetches STARTUP_CANDLE_COUNT candles of 15m NIFTY data at boot.
 *              Tries NSE India → Yahoo Finance → local cache in order.
 *              Seeds CandleBuilder buffers before the tick stream starts.
 *              Emits HISTORICAL_DATA_LOADED on success, STARTUP_DATA_FAILED if all fail.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const config   = require('../config');

const CACHE_PATH = path.join(__dirname, 'cache/nifty-15m.json');
const COUNT      = config.STARTUP_CANDLE_COUNT; // 50

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [Historical] [${level}] ${msg}`);
}

class Historical {
  constructor() {
    // Injected in tests to simulate HTTP failures without live network calls
    this._http = axios;
  }

  async fetch() {
    let candles = null;

    // Source 1: Dhan historical API (when DATA_SOURCE=DHAN, tried first)
    if (config.DATA_SOURCE === 'DHAN') {
      try {
        candles = await this._fetchFromDhan();
        log('INFO', `Loaded ${candles.length} candles from Dhan historical API`);
        this._writeCache(candles);
      } catch (err) {
        log('WARN', `Dhan historical fetch failed: ${err.message}`);
      }
    }

    // Source 2: NSE India
    if (!candles) {
      try {
        candles = await this._fetchFromNSE();
        log('INFO', `Loaded ${candles.length} candles from NSE India`);
        this._writeCache(candles);
      } catch (err) {
        log('WARN', `NSE India failed: ${err.message}`);
      }
    }

    // Source 3: Yahoo Finance
    if (!candles) {
      try {
        candles = await this._fetchFromYahoo();
        log('INFO', `Loaded ${candles.length} candles from Yahoo Finance`);
        this._writeCache(candles);
      } catch (err) {
        log('WARN', `Yahoo Finance failed: ${err.message}`);
      }
    }

    // Source 4: local cache
    if (!candles) {
      try {
        candles = this._readCache();
        log('WARN', `Using stale local cache (${candles.length} candles) — live sources unavailable`);
      } catch (err) {
        log('ERROR', `Local cache unavailable: ${err.message}`);
      }
    }

    if (!candles) {
      log('ERROR', 'All historical sources failed — indicators will warm up from live candles');
      eventBus.emit(EVENTS.STARTUP_DATA_FAILED, { reason: 'all sources unavailable' });
      return;
    }

    // Seed the candle builder with 15m history
    const candleBuilder = require('./candle-builder');
    candleBuilder.seedBuffer(15, candles.slice(-COUNT));
    eventBus.emit(EVENTS.HISTORICAL_DATA_LOADED, { count: candles.length, timeframe: 15 });
  }

  /**
   * Seeds candle history for a watchlist symbol on boot (Phase 5 scanner use).
   * Returns the fetched candles without emitting events or writing to the candle builder.
   * The caller (scan-scheduler) injects them into indicator-engine as needed.
   * @param {string} symbol — e.g. 'BANKNIFTY'
   * @returns {Promise<Array>} array of {open,high,low,close,volume,openTime} candles
   */
  async fetchForSymbol(symbol) {
    const sym = symbol.toUpperCase();
    log('INFO', `Fetching historical candles for ${sym}`);

    // Yahoo first — Dhan's 15m historical API only returns ~17 candles regardless of range.
    // Yahoo reliably gives full history. Dhan is used as fallback if Yahoo fails.
    try {
      const candles = await this._fetchFromYahooSymbol(sym);
      log('INFO', `${sym}: ${candles.length} candles from Yahoo`);
      return candles.slice(-COUNT);
    } catch (err) {
      log('WARN', `${sym} Yahoo historical failed: ${err.message}`);
    }

    if (config.DATA_SOURCE === 'DHAN') {
      try {
        const candles = await this._fetchFromDhanSymbol(sym);
        log('INFO', `${sym}: ${candles.length} candles from Dhan`);
        return candles.slice(-COUNT);
      } catch (err) {
        log('WARN', `${sym} Dhan historical failed: ${err.message}`);
      }
    }

    log('WARN', `${sym}: all historical sources failed — returning empty array`);
    return [];
  }

  async _fetchFromYahooSymbol(symbol) {
    // Yahoo Finance ticker: BANKNIFTY → ^NSEBANK, FINNIFTY → ^NSEFIN etc.
    const YAHOO_MAP = {
      NIFTY:     '%5ENSEI',
      BANKNIFTY: '%5ENSEBANK',
      FINNIFTY:  'NIFTY_FIN_SERVICE.NS',
    };
    const ticker = YAHOO_MAP[symbol] || `${symbol}.NS`;

    const res = await this._http.get(
      `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=15m&range=10d`,
      { timeout: 10000 }
    );

    const chart = res.data.chart.result[0];
    const timestamps = chart.timestamp;
    const ohlcv      = chart.indicators.quote[0];

    return timestamps.map((ts, i) => ({
      open:     ohlcv.open[i]   || ohlcv.close[i],
      high:     ohlcv.high[i]   || ohlcv.close[i],
      low:      ohlcv.low[i]    || ohlcv.close[i],
      close:    ohlcv.close[i],
      volume:   ohlcv.volume[i] || 0,
      openTime: ts * 1000,
    })).filter((c) => c.close != null);
  }

  async _fetchFromDhanSymbol(symbol) {
    const DHAN_SECURITY_MAP = {
      // Indices
      NIFTY:      { securityId: config.DHAN_SECURITY_ID, segment: config.DHAN_EXCHANGE_SEGMENT, instrument: 'INDEX' },
      BANKNIFTY:  { securityId: '25',   segment: 'IDX_I',  instrument: 'INDEX' },
      FINNIFTY:   { securityId: '27',   segment: 'IDX_I',  instrument: 'INDEX' },
      MIDCPNIFTY: { securityId: '442',  segment: 'IDX_I',  instrument: 'INDEX' },
      // NSE Equities
      RELIANCE:   { securityId: '2885',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      TCS:        { securityId: '11536', segment: 'NSE_EQ', instrument: 'EQUITY' },
      INFY:       { securityId: '1594',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      HDFCBANK:   { securityId: '1333',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      ICICIBANK:  { securityId: '4963',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      SBIN:       { securityId: '3045',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      WIPRO:      { securityId: '3787',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      AXISBANK:   { securityId: '5900',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      KOTAKBANK:  { securityId: '1922',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      LT:         { securityId: '11483', segment: 'NSE_EQ', instrument: 'EQUITY' },
      BHARTIARTL: { securityId: '10604', segment: 'NSE_EQ', instrument: 'EQUITY' },
      ITC:        { securityId: '1660',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      HINDUNILVR: { securityId: '1394',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      BAJFINANCE: { securityId: '317',   segment: 'NSE_EQ', instrument: 'EQUITY' },
      MARUTI:     { securityId: '10999', segment: 'NSE_EQ', instrument: 'EQUITY' },
      TATASTEEL:  { securityId: '3499',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      ADANIENT:   { securityId: '25',    segment: 'NSE_EQ', instrument: 'EQUITY' },
      SUNPHARMA:  { securityId: '3351',  segment: 'NSE_EQ', instrument: 'EQUITY' },
      NTPC:       { securityId: '11630', segment: 'NSE_EQ', instrument: 'EQUITY' },
    };

    const entry = DHAN_SECURITY_MAP[symbol];
    if (!entry) throw new Error(`No Dhan security ID mapping for ${symbol}`);

    if (!config.DHAN_CLIENT_ID || !config.DHAN_ACCESS_TOKEN) {
      throw new Error('DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN not set');
    }

    const toDate   = new Date();
    // 50 × 15m candles ≈ 1.5 trading days. Fetch 30 calendar days back
    // to safely cover weekends, holidays, and thin trading sessions.
    const fromDate = new Date(toDate - 30 * 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);

    const res = await this._http.post(
      `${config.DHAN_REST_URL}/charts/historical`,
      {
        securityId:      entry.securityId,
        exchangeSegment: entry.segment,
        instrument:      entry.instrument,
        expiryCode:      0,
        oi:              false,
        interval:        '15',
        fromDate:        fmt(fromDate),
        toDate:          fmt(toDate),
      },
      {
        headers: {
          'access-token':  config.DHAN_ACCESS_TOKEN,
          'client-id':     config.DHAN_CLIENT_ID,
          'Content-Type':  'application/json',
        },
        timeout: 15000,
      }
    );

    const d = res.data;
    if (!Array.isArray(d.timestamp) || d.timestamp.length === 0) {
      throw new Error(`Empty Dhan historical response for ${symbol}`);
    }

    return d.timestamp.map((ts, i) => ({
      open:     d.open[i],
      high:     d.high[i],
      low:      d.low[i],
      close:    d.close[i],
      volume:   d.volume[i] || 0,
      openTime: ts * 1000,
    })).filter((c) => c.close != null && c.close > 0);
  }

  async _fetchFromNSE() {
    // Step 1: acquire session cookie
    await this._http.get('https://www.nseindia.com', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 10000,
    });

    // Step 2: fetch chart data
    const res = await this._http.get(
      'https://www.nseindia.com/api/chart-databyindex?index=NIFTY50&indices=true',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer':    'https://www.nseindia.com',
        },
        timeout: 10000,
      }
    );

    // NSE chart response: { grapthData: [[timestamp_ms, close], ...] }
    const raw = res.data.grapthData || res.data.data;
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty NSE response');

    return this._resampleTo15m(raw.map(([ts, close]) => ({
      open: close, high: close, low: close, close, volume: 0, openTime: ts,
    })));
  }

  async _fetchFromYahoo() {
    const res = await this._http.get(
      'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=15m&range=2d',
      { timeout: 10000 }
    );

    const chart = res.data.chart.result[0];
    const timestamps = chart.timestamp;
    const ohlcv      = chart.indicators.quote[0];

    return timestamps.map((ts, i) => ({
      open:     ohlcv.open[i]   || ohlcv.close[i],
      high:     ohlcv.high[i]   || ohlcv.close[i],
      low:      ohlcv.low[i]    || ohlcv.close[i],
      close:    ohlcv.close[i],
      volume:   ohlcv.volume[i] || 0,
      openTime: ts * 1000,
    })).filter((c) => c.close != null);
  }

  // Dhan historical charts API: POST /v2/charts/historical
  // Response: { open:[], high:[], low:[], close:[], volume:[], timestamp:[] }
  // timestamp values are unix seconds
  async _fetchFromDhan() {
    if (!config.DHAN_CLIENT_ID || !config.DHAN_ACCESS_TOKEN) {
      throw new Error('DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN not set');
    }

    const toDate   = new Date();
    const fromDate = new Date(toDate - COUNT * 15 * 60 * 1000 * 2); // fetch 2× to ensure COUNT candles after gaps

    const fmt = (d) => d.toISOString().slice(0, 10); // YYYY-MM-DD

    const res = await this._http.post(
      `${config.DHAN_REST_URL}/charts/historical`,
      {
        securityId:      config.DHAN_SECURITY_ID,
        exchangeSegment: config.DHAN_EXCHANGE_SEGMENT,
        instrument:      'INDEX',
        expiryCode:      0,
        oi:              false,
        interval:        '15',   // 15-minute candles
        fromDate:        fmt(fromDate),
        toDate:          fmt(toDate),
      },
      {
        headers: {
          'access-token':  config.DHAN_ACCESS_TOKEN,
          'client-id':     config.DHAN_CLIENT_ID,
          'Content-Type':  'application/json',
        },
        timeout: 15000,
      }
    );

    const d = res.data;
    if (!Array.isArray(d.timestamp) || d.timestamp.length === 0) {
      throw new Error('Empty Dhan historical response');
    }

    return d.timestamp.map((ts, i) => ({
      open:     d.open[i],
      high:     d.high[i],
      low:      d.low[i],
      close:    d.close[i],
      volume:   d.volume[i] || 0,
      openTime: ts * 1000, // convert unix seconds → ms
    })).filter((c) => c.close != null && c.close > 0);
  }

  _readCache() {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const candles = JSON.parse(raw);
    if (!Array.isArray(candles) || candles.length === 0) throw new Error('Empty cache');
    return candles;
  }

  _writeCache(candles) {
    try {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(candles));
    } catch (err) {
      log('WARN', `Cache write failed: ${err.message}`);
    }
  }

  // Converts 1m-resolution NSE data into 15m candles
  _resampleTo15m(candles1m) {
    const buckets = {};
    for (const c of candles1m) {
      const key = Math.floor(c.openTime / (15 * 60 * 1000)) * (15 * 60 * 1000);
      if (!buckets[key]) {
        buckets[key] = { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, openTime: key };
      } else {
        if (c.high  > buckets[key].high) buckets[key].high  = c.high;
        if (c.low   < buckets[key].low)  buckets[key].low   = c.low;
        buckets[key].close   = c.close;
        buckets[key].volume += c.volume;
      }
    }
    return Object.values(buckets).sort((a, b) => a.openTime - b.openTime);
  }
}

module.exports = new Historical();
