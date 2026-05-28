/**
 * @file snapshot-store.js
 * @description Appends options chain snapshots to daily NDJSON files.
 *              Primary NIFTY snapshots: snapshots/options-YYYY-MM-DD.ndjson
 *              Watchlist symbol snapshots (Phase 5): snapshots/options-SYMBOL-YYYY-MM-DD.ndjson
 *              Accumulates historical data for Phase 7 backtesting.
 */
'use strict';

const fs              = require('fs');
const path            = require('path');
const { writeSnapshot } = require('./db');

const SNAPSHOTS_DIR = path.join(__dirname, '..', 'snapshots');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [SnapshotStore] [${level}] ${msg}`);
}

function _ensureDir() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }
}

/**
 * Writes one options chain snapshot line to today's NDJSON file.
 * If payload.symbol is present and not 'NIFTY', writes to a per-symbol file.
 *
 * @param {object} payload - OPTIONS_CHAIN_UPDATED payload or scan result chain
 */
function write(payload) {
  const today  = new Date().toISOString().slice(0, 10);
  const symbol = (payload.symbol || 'NIFTY').toUpperCase();

  // Primary NIFTY file keeps the original naming for backwards compatibility
  const fileName = symbol === 'NIFTY'
    ? `options-${today}.ndjson`
    : `options-${symbol}-${today}.ndjson`;

  const filePath = path.join(SNAPSHOTS_DIR, fileName);

  const entry = JSON.stringify({
    timestamp:       new Date().toISOString(),
    symbol,
    vix:             payload.vix,
    pcr:             payload.pcr,
    atmStrike:       payload.atmStrike,
    underlyingValue: payload.underlyingValue,
    strikeData:      payload.strikeData ?? null,
    scanScore:       payload.scanScore  ?? null,
    strategyScores:  payload.strategyScores ?? null,
  }) + '\n';

  try {
    _ensureDir();
    fs.appendFileSync(filePath, entry, 'utf8');
  } catch (err) {
    log('ERROR', `Failed to write snapshot for ${symbol}: ${err.message}`);
  }

  const now = new Date().toISOString();
  writeSnapshot({
    symbol,
    timestamp:   now,
    trade_date:  now.slice(0, 10),
    vix:         payload.vix              ?? null,
    pcr:         payload.pcr              ?? null,
    atm_strike:  payload.atmStrike        ?? null,
    underlying:  payload.underlyingValue  ?? null,
    strike_data: payload.strikeData ? JSON.stringify(payload.strikeData) : null,
    source:      'intraday',
  });
}

module.exports = { write };
