/**
 * @file db.js
 * @description Opens/creates drishti.db and runs schema migrations on boot.
 *              Exposes a single synchronous better-sqlite3 Database instance.
 *              All writes are fire-and-forget inserts — never read during live trading.
 *              Also read by the offline swing backtester (swing-backtest.js).
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

  CREATE TABLE IF NOT EXISTS daily_candles (
    symbol  TEXT NOT NULL,
    date    TEXT NOT NULL,
    open    REAL NOT NULL,
    high    REAL NOT NULL,
    low     REAL NOT NULL,
    close   REAL NOT NULL,
    volume  REAL NOT NULL DEFAULT 0,
    source  TEXT NOT NULL,
    PRIMARY KEY (symbol, date)
  );

  CREATE TABLE IF NOT EXISTS setup_stats (
    setup_id        TEXT NOT NULL,
    direction       TEXT NOT NULL,
    sample          TEXT NOT NULL,
    run_at          TEXT NOT NULL,
    period_from     TEXT NOT NULL,
    period_to       TEXT NOT NULL,
    exit_mode       TEXT NOT NULL,
    trades          INTEGER NOT NULL,
    win_rate        REAL,
    avg_r           REAL,
    expectancy_r    REAL,
    profit_factor   REAL,
    max_drawdown_r  REAL,
    max_consec_loss INTEGER,
    avg_hold_days   REAL,
    baseline_r      REAL,
    low_sample      INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (setup_id, direction, sample, exit_mode)
  );

  CREATE TABLE IF NOT EXISTS swing_trades (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol        TEXT NOT NULL,
    setup_id      TEXT NOT NULL,
    direction     TEXT NOT NULL,
    entry_price   REAL,
    stop_loss     REAL,
    target        REAL,
    shares        INTEGER,
    trade_date    TEXT,
    exit_price    REAL,
    exit_reason   TEXT,
    exit_date     TEXT,
    notes         TEXT,
    state         TEXT NOT NULL DEFAULT 'OPEN',
    created_at    TEXT DEFAULT (datetime('now'))
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

const upsertDailyCandle = db.prepare(`
  INSERT INTO daily_candles (symbol, date, open, high, low, close, volume, source)
  VALUES (@symbol, @date, @open, @high, @low, @close, @volume, @source)
  ON CONFLICT(symbol, date) DO UPDATE SET
    open   = excluded.open,
    high   = excluded.high,
    low    = excluded.low,
    close  = excluded.close,
    volume = excluded.volume,
    source = excluded.source
`);

const getDailyCandles = db.prepare(`
  SELECT symbol, date, open, high, low, close, volume, source
  FROM daily_candles
  WHERE symbol = ? AND date >= ? AND date <= ?
  ORDER BY date ASC
`);

const upsertSetupStats = db.prepare(`
  INSERT INTO setup_stats
    (setup_id, direction, sample, run_at, period_from, period_to, exit_mode,
     trades, win_rate, avg_r, expectancy_r, profit_factor,
     max_drawdown_r, max_consec_loss, avg_hold_days, baseline_r, low_sample)
  VALUES
    (@setup_id, @direction, @sample, @run_at, @period_from, @period_to, @exit_mode,
     @trades, @win_rate, @avg_r, @expectancy_r, @profit_factor,
     @max_drawdown_r, @max_consec_loss, @avg_hold_days, @baseline_r, @low_sample)
  ON CONFLICT(setup_id, direction, sample, exit_mode) DO UPDATE SET
    run_at          = excluded.run_at,
    period_from     = excluded.period_from,
    period_to       = excluded.period_to,
    trades          = excluded.trades,
    win_rate        = excluded.win_rate,
    avg_r           = excluded.avg_r,
    expectancy_r    = excluded.expectancy_r,
    profit_factor   = excluded.profit_factor,
    max_drawdown_r  = excluded.max_drawdown_r,
    max_consec_loss = excluded.max_consec_loss,
    avg_hold_days   = excluded.avg_hold_days,
    baseline_r      = excluded.baseline_r,
    low_sample      = excluded.low_sample
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

/**
 * Upserts one daily candle row (insert or replace on symbol+date conflict).
 * @param {object} row — { symbol, date, open, high, low, close, volume, source }
 */
function writeDaily(row) {
  try {
    upsertDailyCandle.run(row);
  } catch (err) {
    log('ERROR', `writeDaily failed: ${err.message}`);
  }
}

/**
 * Returns daily candle rows for a symbol in [from, to] inclusive, oldest first.
 * @param {string} symbol
 * @param {string} from — YYYY-MM-DD
 * @param {string} to   — YYYY-MM-DD
 * @returns {Array<{symbol, date, open, high, low, close, volume, source}>}
 */
function readDailyCandles(symbol, from, to) {
  return getDailyCandles.all(symbol, from, to);
}

/**
 * Upserts one setup_stats row for the swing backtester.
 * @param {object} row — fields matching the setup_stats schema
 */
function writeSetupStats(row) {
  try {
    upsertSetupStats.run(row);
  } catch (err) {
    log('ERROR', `writeSetupStats failed: ${err.message}`);
  }
}

const insertSwingTrade = db.prepare(`
  INSERT INTO swing_trades
    (symbol, setup_id, direction, entry_price, stop_loss, target, shares, trade_date, state)
  VALUES
    (@symbol, @setup_id, @direction, @entry_price, @stop_loss, @target, @shares, @trade_date, @state)
`);

const updateSwingTradeExit = db.prepare(`
  UPDATE swing_trades
  SET exit_price = @exit_price, exit_reason = @exit_reason, exit_date = @exit_date,
      notes = @notes, state = 'CLOSED'
  WHERE symbol = @symbol AND state = 'OPEN'
`);

const selectOpenSwingTrades = db.prepare(`
  SELECT * FROM swing_trades WHERE state = 'OPEN' ORDER BY created_at ASC
`);

function writeSwingTrade(row) {
  try {
    insertSwingTrade.run(row);
  } catch (err) {
    log('ERROR', `writeSwingTrade failed: ${err.message}`);
  }
}

function closeSwingTrade({ symbol, exitPrice, exitReason, exitDate, notes }) {
  try {
    updateSwingTradeExit.run({
      symbol,
      exit_price:  exitPrice,
      exit_reason: exitReason || 'MANUAL',
      exit_date:   exitDate || new Date().toISOString().slice(0, 10),
      notes:       notes || null,
    });
  } catch (err) {
    log('ERROR', `closeSwingTrade failed: ${err.message}`);
  }
}

function readOpenSwingTrades() {
  return selectOpenSwingTrades.all();
}

module.exports = {
  db,
  writeTrade, writeSnapshot, writeScanResult, writeDaily, readDailyCandles, writeSetupStats,
  writeSwingTrade, closeSwingTrade, readOpenSwingTrades,
};
