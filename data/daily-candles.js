/**
 * @file daily-candles.js
 * @description Phase 7: daily OHLCV fetch, SQLite cache, and weekly aggregation
 *              for the swing setup engine.
 *
 *              sync(symbol) — fetches SWING_HISTORY_YEARS of daily data via Yahoo
 *              (falling back to Dhan daily) and upserts into daily_candles table.
 *              Subsequent calls only fetch missing days.
 *
 *              get(symbol, from, to) — reads from SQLite, oldest first.
 *
 *              toWeekly(daily) — aggregates daily rows into ISO-week candles.
 */

'use strict';

const axios  = require('axios');
const config = require('../config');
const { writeDaily, readDailyCandles, db } = require('./db');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [DailyCandles] [${level}] ${msg}`);
}

// ── Date helpers ──────────────────────────────────────────────────────────────

function toISODate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

// ── Yahoo Finance daily fetch ─────────────────────────────────────────────────

const YAHOO_EQUITY_MAP = {
  NIFTY:     '%5ENSEI',
  BANKNIFTY: '%5ENSEBANK',
  FINNIFTY:  'NIFTY_FIN_SERVICE.NS',
};

async function _fetchYahooDaily(symbol, fromDate, toDate) {
  const ticker  = YAHOO_EQUITY_MAP[symbol] || `${symbol}.NS`;
  const period1 = Math.floor(new Date(fromDate + 'T00:00:00Z').getTime() / 1000);
  const period2 = Math.floor(new Date(toDate   + 'T23:59:59Z').getTime() / 1000);

  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}` +
    `?interval=1d&period1=${period1}&period2=${period2}`;

  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 15000,
  });

  const chart = res.data?.chart?.result?.[0];
  if (!chart) throw new Error(`No chart data in Yahoo response for ${ticker}`);

  const timestamps = chart.timestamp || [];
  const quote      = chart.indicators?.quote?.[0] || {};

  return timestamps.map((ts, i) => ({
    date:   toISODate(new Date(ts * 1000)),
    open:   quote.open[i],
    high:   quote.high[i],
    low:    quote.low[i],
    close:  quote.close[i],
    volume: quote.volume[i] || 0,
    source: 'yahoo',
  })).filter(c => c.close != null && c.close > 0);
}

// ── Dhan daily fetch (fallback) ───────────────────────────────────────────────

const DHAN_SECURITY_MAP = {
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
  SUNPHARMA:  { securityId: '3351',  segment: 'NSE_EQ', instrument: 'EQUITY' },
  NTPC:       { securityId: '11630', segment: 'NSE_EQ', instrument: 'EQUITY' },
};

async function _fetchDhanDaily(symbol, fromDate, toDate) {
  const entry = DHAN_SECURITY_MAP[symbol];
  if (!entry) throw new Error(`No Dhan security ID mapping for ${symbol}`);
  if (!config.DHAN_CLIENT_ID || !config.DHAN_ACCESS_TOKEN) {
    throw new Error('DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN not set');
  }

  const res = await axios.post(
    `${config.DHAN_REST_URL}/charts/historical`,
    {
      securityId:      entry.securityId,
      exchangeSegment: entry.segment,
      instrument:      entry.instrument,
      expiryCode:      0,
      oi:              false,
      interval:        'D',
      fromDate,
      toDate,
    },
    {
      headers: {
        'access-token': config.DHAN_ACCESS_TOKEN,
        'client-id':    config.DHAN_CLIENT_ID,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );

  const d = res.data;
  if (!Array.isArray(d.timestamp) || d.timestamp.length === 0) {
    throw new Error(`Empty Dhan daily response for ${symbol}`);
  }

  return d.timestamp.map((ts, i) => ({
    date:   toISODate(new Date(ts * 1000)),
    open:   d.open[i],
    high:   d.high[i],
    low:    d.low[i],
    close:  d.close[i],
    volume: d.volume[i] || 0,
    source: 'dhan',
  })).filter(c => c.close != null && c.close > 0);
}

// ── Sanity checks ─────────────────────────────────────────────────────────────

function _sanityCheck(symbol, rows) {
  const clean = [];
  for (const row of rows) {
    if (!row.close || row.close <= 0) {
      log('WARN', `${symbol} ${row.date}: dropping row with null/zero close`);
      continue;
    }
    clean.push(row);
  }

  // Check for large day-over-day gaps (likely unadjusted splits)
  for (let i = 1; i < clean.length; i++) {
    const prev = clean[i - 1].close;
    const curr = clean[i].close;
    const pct  = Math.abs(curr - prev) / prev * 100;
    if (pct > 25) {
      log('WARN', `${symbol}: ${clean[i - 1].date}→${clean[i].date} gap ${pct.toFixed(1)}% — possible unadjusted split`);
    }
  }

  // Check for missing run > 5 trading days
  for (let i = 1; i < clean.length; i++) {
    const a = new Date(clean[i - 1].date + 'T00:00:00Z');
    const b = new Date(clean[i].date     + 'T00:00:00Z');
    const calDays = Math.round((b - a) / (1000 * 60 * 60 * 24));
    if (calDays > 9) { // ~7 calendar days per 5 trading days
      log('WARN', `${symbol}: ${clean[i - 1].date}→${clean[i].date} gap of ${calDays} calendar days`);
    }
  }

  return clean;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Syncs SWING_HISTORY_YEARS of daily candles for symbol into SQLite.
 * On subsequent calls only fetches days after the last stored row.
 * @param {string} symbol — NSE equity symbol
 * @returns {Promise<number>} number of rows upserted
 */
async function sync(symbol) {
  const sym = symbol.toUpperCase();

  // Determine from-date: start of history, or one day after last stored row
  const today = toISODate(new Date());
  const historyStart = toISODate(new Date(
    Date.now() - config.SWING_HISTORY_YEARS * 365.25 * 24 * 60 * 60 * 1000
  ));

  const lastRow = db.prepare(
    'SELECT date FROM daily_candles WHERE symbol = ? ORDER BY date DESC LIMIT 1'
  ).get(sym);

  const fromDate = lastRow ? addDays(lastRow.date, 1) : historyStart;

  if (fromDate > today) {
    log('INFO', `${sym}: already up to date`);
    return 0;
  }

  log('INFO', `${sym}: fetching ${fromDate} → ${today}`);

  let rows = null;

  // Source 1: Yahoo Finance
  try {
    rows = await _fetchYahooDaily(sym, fromDate, today);
    log('INFO', `${sym}: ${rows.length} rows from Yahoo`);
  } catch (err) {
    log('WARN', `${sym} Yahoo daily failed: ${err.message}`);
  }

  // Source 2: Dhan (fallback)
  if (!rows && config.DATA_SOURCE === 'DHAN') {
    try {
      rows = await _fetchDhanDaily(sym, fromDate, today);
      log('INFO', `${sym}: ${rows.length} rows from Dhan`);
    } catch (err) {
      log('WARN', `${sym} Dhan daily failed: ${err.message}`);
    }
  }

  if (!rows || rows.length === 0) {
    log('WARN', `${sym}: no rows fetched for ${fromDate} → ${today}`);
    return 0;
  }

  const clean = _sanityCheck(sym, rows);

  const upsertMany = db.transaction((rowArr) => {
    for (const row of rowArr) {
      writeDaily({ symbol: sym, ...row });
    }
  });
  upsertMany(clean);

  log('INFO', `${sym}: upserted ${clean.length} rows`);
  return clean.length;
}

/**
 * Returns daily candle rows for a symbol in [from, to] inclusive, oldest first.
 * Shape: { date, open, high, low, close, volume }
 * @param {string} symbol
 * @param {string} from — YYYY-MM-DD
 * @param {string} to   — YYYY-MM-DD
 * @returns {Array<{date, open, high, low, close, volume}>}
 */
function get(symbol, from, to) {
  const rows = readDailyCandles(symbol.toUpperCase(), from, to);
  return rows.map(({ date, open, high, low, close, volume }) =>
    ({ date, open, high, low, close, volume })
  );
}

/**
 * Aggregates an array of daily candles into ISO-week candles.
 * Open = first open, High = highest high, Low = lowest low,
 * Close = last close, Volume = sum.
 * The final week is marked partial: true if it has fewer days than the
 * preceding weeks (i.e. today's week is not yet complete).
 *
 * @param {Array<{date: string, open, high, low, close, volume}>} daily
 * @returns {Array<{weekKey: string, open, high, low, close, volume, partial: boolean}>}
 */
function toWeekly(daily) {
  if (!daily || daily.length === 0) return [];

  // ISO week key: YYYY-Www (Monday-based)
  function isoWeek(dateStr) {
    const d   = new Date(dateStr + 'T00:00:00Z');
    const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
    d.setUTCDate(d.getUTCDate() + 4 - day); // Thursday of the week
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo    = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  const buckets = new Map();
  for (const c of daily) {
    const key = isoWeek(c.date);
    if (!buckets.has(key)) {
      buckets.set(key, { weekKey: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, _count: 1 });
    } else {
      const b = buckets.get(key);
      if (c.high  > b.high)  b.high  = c.high;
      if (c.low   < b.low)   b.low   = c.low;
      b.close   = c.close;
      b.volume += c.volume;
      b._count++;
    }
  }

  const weeks = Array.from(buckets.values()).sort((a, b) => a.weekKey.localeCompare(b.weekKey));

  // The last week is partial if it has fewer days than the median of all weeks
  if (weeks.length > 1) {
    const counts = weeks.slice(0, -1).map(w => w._count).sort((a, b) => a - b);
    const medianCount = counts[Math.floor(counts.length / 2)];
    const last = weeks[weeks.length - 1];
    last.partial = last._count < medianCount;
    weeks.slice(0, -1).forEach(w => { w.partial = false; });
  } else if (weeks.length === 1) {
    weeks[0].partial = false;
  }

  // Remove internal _count field
  for (const w of weeks) delete w._count;

  return weeks;
}

module.exports = { sync, get, toWeekly };
