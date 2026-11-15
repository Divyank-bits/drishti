/**
 * @file bhavcopy.js
 * @description Phase 9: downloads and parses NSE FO Bhavcopy files.
 *              Stores OHLCV + OI per strike/expiry to options_bhavcopy SQLite table.
 *
 * NSE archive URL pattern:
 *   https://nsearchives.nseindia.com/content/historical/DERIVATIVES/YYYY/MMM/fo{DDMMMYYYY}bhav.csv.zip
 */
'use strict';

const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const zlib    = require('zlib');
const { writeBhavcopyBatch } = require('./db');

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [Bhavcopy] [${level}] ${msg}`);
}

function isoToNseDate(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  const dd  = String(d.getUTCDate()).padStart(2, '0');
  const mon = MONTHS[d.getUTCMonth()];
  const yyyy = d.getUTCFullYear();
  return { dd, mon, yyyy };
}

function bhavcopyUrl(isoDate) {
  const { dd, mon, yyyy } = isoToNseDate(isoDate);
  return `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/${yyyy}/${mon}/fo${dd}${mon}${yyyy}bhav.csv.zip`;
}

/**
 * Fetch a URL and return a Buffer.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
      },
      timeout: 30000,
    }, (res) => {
      if (res.statusCode === 404) {
        reject(new Error(`HTTP 404 — file not found: ${url}`));
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

/**
 * Decompress a zip buffer and return the CSV text inside.
 * Uses Node zlib unzip (handles deflate-compressed zip entries).
 * Falls back to raw buffer if not zipped (some NSE files are plain CSV).
 * @param {Buffer} buf
 * @returns {Promise<string>}
 */
function unzipBuffer(buf) {
  return new Promise((resolve, reject) => {
    zlib.unzip(buf, (err, result) => {
      if (err) {
        // Not zipped — return raw
        resolve(buf.toString('utf8'));
      } else {
        resolve(result.toString('utf8'));
      }
    });
  });
}

/**
 * Parse NSE FO Bhavcopy CSV text.
 * Columns: INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,
 *          CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP
 *
 * @param {string} csvText
 * @param {string} filterSymbol  - only keep this underlying (e.g. 'NIFTY')
 * @param {string} isoDate       - the trade date (YYYY-MM-DD)
 * @returns {Array<object>}
 */
function parseCsv(csvText, filterSymbol, isoDate) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length < 2) return [];

  // Header row (case-insensitive)
  const header = lines[0].split(',').map(h => h.trim().toUpperCase());
  const col = (name) => header.indexOf(name);

  const iInstrument = col('INSTRUMENT');
  const iSymbol     = col('SYMBOL');
  const iExpiry     = col('EXPIRY_DT');
  const iStrike     = col('STRIKE_PR');
  const iOptType    = col('OPTION_TYP');
  const iOpen       = col('OPEN');
  const iHigh       = col('HIGH');
  const iLow        = col('LOW');
  const iClose      = col('CLOSE');
  const iSettle     = col('SETTLE_PR');
  const iContracts  = col('CONTRACTS');
  const iOI         = col('OPEN_INT');

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(',');
    if (parts.length < 10) continue;

    const instrument = (parts[iInstrument] || '').trim();
    if (!instrument.startsWith('OPT')) continue;  // options only

    const symbol = (parts[iSymbol] || '').trim();
    if (filterSymbol && symbol !== filterSymbol) continue;

    const optType = (parts[iOptType] || '').trim().toUpperCase();
    if (optType !== 'CE' && optType !== 'PE') continue;

    // Parse expiry: NSE format is "DD-MMM-YYYY"
    const expiryRaw = (parts[iExpiry] || '').trim();
    const expiry = nseExpiryToIso(expiryRaw);
    if (!expiry) continue;

    rows.push({
      symbol,
      expiry,
      option_type: optType,
      strike:    parseFloat(parts[iStrike]) || 0,
      date:      isoDate,
      open:      parseFloat(parts[iOpen])    || null,
      high:      parseFloat(parts[iHigh])    || null,
      low:       parseFloat(parts[iLow])     || null,
      close:     parseFloat(parts[iClose])   || null,
      settle:    parseFloat(parts[iSettle])  || null,
      contracts: parseInt(parts[iContracts], 10) || null,
      oi:        parseInt(parts[iOI], 10)    || null,
    });
  }
  return rows;
}

function nseExpiryToIso(raw) {
  // "29-FEB-2024" or "29FEB2024"
  const m1 = raw.match(/^(\d{2})-([A-Z]{3})-(\d{4})$/);
  if (m1) {
    const mon = MONTHS.indexOf(m1[2]);
    if (mon === -1) return null;
    return `${m1[3]}-${String(mon + 1).padStart(2, '0')}-${m1[1]}`;
  }
  const m2 = raw.match(/^(\d{2})([A-Z]{3})(\d{4})$/);
  if (m2) {
    const mon = MONTHS.indexOf(m2[2]);
    if (mon === -1) return null;
    return `${m2[3]}-${String(mon + 1).padStart(2, '0')}-${m2[1]}`;
  }
  return null;
}

/**
 * Download, parse and store Bhavcopy for one trading date.
 * @param {string} isoDate   - YYYY-MM-DD
 * @param {string} [symbol]  - filter to one underlying; defaults to all
 * @returns {Promise<{ date, rows }>}
 */
async function syncDate(isoDate, symbol) {
  const url = bhavcopyUrl(isoDate);
  log('DEBUG', `Fetching ${url}`);

  const buf     = await fetchBuffer(url);
  const csvText = await unzipBuffer(buf);
  const rows    = parseCsv(csvText, symbol || null, isoDate);

  if (rows.length > 0) {
    writeBhavcopyBatch(rows);
    log('INFO', `${isoDate}: stored ${rows.length} row(s)${symbol ? ` for ${symbol}` : ''}`);
  } else {
    log('WARN', `${isoDate}: no matching rows (symbol=${symbol || 'ALL'})`);
  }

  return { date: isoDate, rows: rows.length };
}

/**
 * Enumerate trading days in [from, to] (Mon–Fri, skip obvious weekends).
 * Does not skip public holidays — HTTP 404 will be caught per-date.
 */
function tradingDays(from, to) {
  const days = [];
  const cur  = new Date(from + 'T00:00:00Z');
  const end  = new Date(to   + 'T00:00:00Z');
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) days.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return days;
}

/**
 * Sync Bhavcopy for a date range, skipping 404s (holidays).
 * @param {{ from, to, symbol, concurrency }} opts
 * @returns {Promise<{ synced, skipped, errors }>}
 */
async function syncRange({ from, to, symbol, concurrency = 2 }) {
  const days = tradingDays(from, to);
  log('INFO', `Syncing ${days.length} trading day(s) from ${from} to ${to}${symbol ? ` [${symbol}]` : ''}`);

  let synced = 0, skipped = 0, errors = 0;

  // Process in small batches to avoid hammering NSE
  for (let i = 0; i < days.length; i += concurrency) {
    const batch = days.slice(i, i + concurrency);
    await Promise.all(batch.map(async (date) => {
      try {
        const result = await syncDate(date, symbol);
        if (result.rows > 0) synced++;
        else skipped++;
      } catch (err) {
        if (err.message.includes('404')) {
          log('DEBUG', `${date}: skipped (holiday or file not published)`);
          skipped++;
        } else {
          log('WARN', `${date}: ${err.message}`);
          errors++;
        }
      }
    }));
  }

  log('INFO', `Done — synced=${synced} skipped=${skipped} errors=${errors}`);
  return { synced, skipped, errors };
}

module.exports = { syncDate, syncRange, parseCsv, bhavcopyUrl, nseExpiryToIso, tradingDays };
