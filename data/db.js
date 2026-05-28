/**
 * @file db.js
 * @description Opens/creates drishti.db and runs schema migrations on boot.
 *              Exposes a single synchronous better-sqlite3 Database instance.
 *              All writes are fire-and-forget inserts — never read during live trading.
 */
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [DB] [${level}] ${msg}`);
}

const DB_PATH = path.join(__dirname, '..', 'drishti.db');

const db = new Database(DB_PATH);

// WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date        TEXT NOT NULL,
    strategy          TEXT NOT NULL,
    entry_time        TEXT NOT NULL,
    exit_time         TEXT,
    strikes           TEXT NOT NULL,
    premium_collected REAL,
    exit_premium      REAL,
    realised_pnl      REAL,
    intelligence_mode TEXT,
    confidence        REAL,
    exit_reason       TEXT,
    source            TEXT NOT NULL DEFAULT 'live'
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol           TEXT NOT NULL DEFAULT 'NIFTY',
    timestamp        TEXT NOT NULL,
    trade_date       TEXT NOT NULL,
    vix              REAL,
    pcr              REAL,
    atm_strike       REAL,
    underlying       REAL,
    strike_data      TEXT,
    source           TEXT NOT NULL DEFAULT 'intraday'
  );

  CREATE TABLE IF NOT EXISTS scan_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT NOT NULL,
    timestamp     TEXT NOT NULL,
    pattern_name  TEXT,
    direction     TEXT,
    state         TEXT,
    confluence    REAL,
    claude_used   INTEGER NOT NULL DEFAULT 0,
    reasoning     TEXT
  );
`);

log('INFO', `Database ready at ${DB_PATH}`);

// ── Prepared statements ────────────────────────────────────────────────────

const insertTrade = db.prepare(`
  INSERT INTO trades
    (trade_date, strategy, entry_time, exit_time, strikes,
     premium_collected, exit_premium, realised_pnl,
     intelligence_mode, confidence, exit_reason, source)
  VALUES
    (@trade_date, @strategy, @entry_time, @exit_time, @strikes,
     @premium_collected, @exit_premium, @realised_pnl,
     @intelligence_mode, @confidence, @exit_reason, @source)
`);

const insertSnapshot = db.prepare(`
  INSERT INTO snapshots
    (symbol, timestamp, trade_date, vix, pcr, atm_strike, underlying, strike_data, source)
  VALUES
    (@symbol, @timestamp, @trade_date, @vix, @pcr, @atm_strike, @underlying, @strike_data, @source)
`);

const insertScanResult = db.prepare(`
  INSERT INTO scan_results
    (symbol, timestamp, pattern_name, direction, state, confluence, claude_used, reasoning)
  VALUES
    (@symbol, @timestamp, @pattern_name, @direction, @state, @confluence, @claude_used, @reasoning)
`);

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Inserts one closed trade row.
 * @param {object} row — fields matching the trades schema
 */
function writeTrade(row) {
  try {
    insertTrade.run(row);
  } catch (err) {
    log('ERROR', `writeTrade failed: ${err.message}`);
  }
}

/**
 * Inserts one options chain snapshot row.
 * @param {object} row — fields matching the snapshots schema
 */
function writeSnapshot(row) {
  try {
    insertSnapshot.run(row);
  } catch (err) {
    log('ERROR', `writeSnapshot failed: ${err.message}`);
  }
}

/**
 * Inserts one equity scan result row.
 * @param {object} row — fields matching the scan_results schema
 */
function writeScanResult(row) {
  try {
    insertScanResult.run(row);
  } catch (err) {
    log('ERROR', `writeScanResult failed: ${err.message}`);
  }
}

module.exports = { db, writeTrade, writeSnapshot, writeScanResult };
