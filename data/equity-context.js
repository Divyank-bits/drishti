/**
 * @file equity-context.js
 * @description Fetches equity market context for Phase 6 directional scans.
 *              Provides: prev day OHLC (S/R levels), day open, and VWAP computed
 *              from intraday ticks accumulated since market open.
 *
 *              getContext(symbol) is the single public entry point — callers pass
 *              the result directly into equity strategy checkPattern() calls.
 */

'use strict';

const axios  = require('axios');
const { NseIndia } = require('stock-nse-india');
const config = require('../config');

const nse = new NseIndia();

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [EquityContext] [${level}] ${msg}`);
}

// ── In-memory VWAP accumulators per symbol ────────────────────────────────────
// Each entry: { cumulativeTPV: number, cumulativeVolume: number, dayOpen: number | null }
// Ticks are accumulated by listenTicks() wired once from equity-scanner.
const _vwapState = new Map();

/**
 * Records an intraday tick for VWAP calculation.
 * Called internally when a TICK_RECEIVED event arrives for a watched symbol.
 * @param {string} symbol
 * @param {{ price: number, volume: number }} tick
 */
function recordTick(symbol, tick) {
  const sym = symbol.toUpperCase();
  if (!_vwapState.has(sym)) {
    _vwapState.set(sym, { cumulativeTPV: 0, cumulativeVolume: 0, dayOpen: null });
  }
  const state = _vwapState.get(sym);
  const typicalPrice = tick.price; // for tick data, TP ≈ last price
  state.cumulativeTPV    += typicalPrice * (tick.volume || 1);
  state.cumulativeVolume += tick.volume || 1;
}

/**
 * Sets the day open for a symbol (call once at market open with first tick price).
 * @param {string} symbol
 * @param {number} openPrice
 */
function setDayOpen(symbol, openPrice) {
  const sym = symbol.toUpperCase();
  if (!_vwapState.has(sym)) {
    _vwapState.set(sym, { cumulativeTPV: 0, cumulativeVolume: 0, dayOpen: null });
  }
  _vwapState.get(sym).dayOpen = openPrice;
}

/**
 * Returns the current VWAP for a symbol, or null if no ticks accumulated.
 * @param {string} symbol
 * @returns {number | null}
 */
function getVwap(symbol) {
  const state = _vwapState.get(symbol.toUpperCase());
  if (!state || state.cumulativeVolume === 0) return null;
  return state.cumulativeTPV / state.cumulativeVolume;
}

/**
 * Resets VWAP accumulators for all symbols — call at start of each trading day.
 */
function resetDailyState() {
  _vwapState.clear();
}

// ── Yahoo Finance prev day OHLC ───────────────────────────────────────────────

// Maps NSE symbol names to Yahoo Finance tickers for equity stocks
const YAHOO_EQUITY_MAP = {
  RELIANCE:  'RELIANCE.NS',
  TCS:       'TCS.NS',
  INFY:      'INFY.NS',
  HDFCBANK:  'HDFCBANK.NS',
  ICICIBANK: 'ICICIBANK.NS',
  SBIN:      'SBIN.NS',
  WIPRO:     'WIPRO.NS',
  AXISBANK:  'AXISBANK.NS',
  KOTAKBANK: 'KOTAKBANK.NS',
  LT:        'LT.NS',
  // Indices (fallback if called for them)
  NIFTY:     '%5ENSEI',
  BANKNIFTY: '%5ENSEBANK',
  FINNIFTY:  '%5ENSEFIN',
};

async function _fetchPrevDayOhlc(symbol) {
  const ticker = YAHOO_EQUITY_MAP[symbol.toUpperCase()] || `${symbol.toUpperCase()}.NS`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;

  const resp = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 8000,
  });

  const result = resp.data?.chart?.result?.[0];
  if (!result) throw new Error(`No data in Yahoo response for ${ticker}`);

  const timestamps = result.timestamp || [];
  const quote      = result.indicators?.quote?.[0] || {};
  const opens      = quote.open  || [];
  const highs      = quote.high  || [];
  const lows       = quote.low   || [];
  const closes     = quote.close || [];

  if (timestamps.length < 2) throw new Error(`Insufficient history for ${ticker}`);

  // Second-to-last candle = previous completed trading day
  const idx = timestamps.length - 2;
  return {
    prevDayHigh:  highs[idx],
    prevDayLow:   lows[idx],
    prevDayClose: closes[idx],
    prevDayOpen:  opens[idx],
  };
}

async function _fetchPrevDayOhlcNse(symbol) {
  try {
    const data = await nse.getEquityDetails(symbol.toUpperCase());
    const pd   = data?.priceInfo?.weekHighLow;
    // NSE equity details has previous close in priceInfo
    const prevClose = data?.priceInfo?.previousClose ?? null;
    // For prev day high/low we fall back to Yahoo; NSE equity API doesn't expose prev day OHLC cleanly
    if (prevClose === null) throw new Error('NSE equity details missing previousClose');
    return { prevDayClose: prevClose, prevDayHigh: null, prevDayLow: null, prevDayOpen: null };
  } catch (err) {
    throw new Error(`NSE equity details failed for ${symbol}: ${err.message}`);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns market context for an equity symbol.
 * Tries Yahoo Finance for prev day OHLC; on failure falls back to NSE equity API (close only).
 * VWAP is computed from accumulated intraday ticks (0 if none recorded yet).
 *
 * @param {string} symbol - NSE symbol e.g. 'RELIANCE'
 * @returns {Promise<{
 *   prevDayHigh:  number | null,
 *   prevDayLow:   number | null,
 *   prevDayClose: number | null,
 *   prevDayOpen:  number | null,
 *   vwap:         number | null,
 *   dayOpen:      number | null,
 * }>}
 */
async function getContext(symbol) {
  const sym = symbol.toUpperCase();
  log('INFO', `Fetching context for ${sym}`);

  let prevDay = { prevDayHigh: null, prevDayLow: null, prevDayClose: null, prevDayOpen: null };

  // Source 1: Yahoo Finance (full OHLC)
  try {
    prevDay = await _fetchPrevDayOhlc(sym);
    log('INFO', `${sym} prev day — H:${prevDay.prevDayHigh} L:${prevDay.prevDayLow} C:${prevDay.prevDayClose}`);
  } catch (err) {
    log('WARN', `${sym} Yahoo prev day failed: ${err.message} — trying NSE`);
    // Source 2: NSE equity API (close only)
    try {
      prevDay = await _fetchPrevDayOhlcNse(sym);
      log('INFO', `${sym} prev day close from NSE: ${prevDay.prevDayClose}`);
    } catch (err2) {
      log('WARN', `${sym} NSE prev day also failed: ${err2.message} — context will have nulls`);
    }
  }

  const vwap    = getVwap(sym);
  const state   = _vwapState.get(sym);
  const dayOpen = state?.dayOpen ?? null;

  return {
    prevDayHigh:  prevDay.prevDayHigh,
    prevDayLow:   prevDay.prevDayLow,
    prevDayClose: prevDay.prevDayClose,
    prevDayOpen:  prevDay.prevDayOpen,
    vwap,
    dayOpen,
  };
}

module.exports = {
  getContext,
  recordTick,
  setDayOpen,
  getVwap,
  resetDailyState,
};
