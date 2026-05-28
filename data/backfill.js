/**
 * @file backfill.js
 * @description One-time migration: reads existing NDJSON journal and snapshot files,
 *              inserts any missing rows into SQLite. Safe to run multiple times —
 *              duplicates are ignored via INSERT OR IGNORE.
 *
 * Usage: node data/backfill.js
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH       = path.join(__dirname, '..', 'drishti.db');
const JOURNAL_PATH  = path.join(__dirname, '..', 'journal', 'trades.ndjson');
const SNAPSHOTS_DIR = path.join(__dirname, '..', 'snapshots');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [Backfill] [${level}] ${msg}`);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Add UNIQUE constraints for idempotent re-runs if not already present
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
`);

const insertTrade = db.prepare(`
  INSERT OR IGNORE INTO trades
    (trade_date, strategy, entry_time, exit_time, strikes,
     premium_collected, exit_premium, realised_pnl,
     intelligence_mode, confidence, exit_reason, source)
  VALUES
    (@trade_date, @strategy, @entry_time, @exit_time, @strikes,
     @premium_collected, @exit_premium, @realised_pnl,
     @intelligence_mode, @confidence, @exit_reason, @source)
`);

const insertSnapshot = db.prepare(`
  INSERT OR IGNORE INTO snapshots
    (symbol, timestamp, trade_date, vix, pcr, atm_strike, underlying, strike_data, source)
  VALUES
    (@symbol, @timestamp, @trade_date, @vix, @pcr, @atm_strike, @underlying, @strike_data, @source)
`);

// ── Journal backfill ───────────────────────────────────────────────────────

function backfillJournal() {
  if (!fs.existsSync(JOURNAL_PATH)) {
    log('INFO', 'No trades.ndjson found — skipping journal backfill');
    return 0;
  }

  const lines = fs.readFileSync(JOURNAL_PATH, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0);

  let count = 0;
  const insertMany = db.transaction((entries) => {
    for (const entry of entries) {
      const { data } = entry;
      const entryTime = data.entryTime ?? entry.timestamp;
      insertTrade.run({
        trade_date:        entry.timestamp.slice(0, 10),
        strategy:          data.strategy          ?? 'unknown',
        entry_time:        entryTime,
        exit_time:         data.exitTime          ?? entry.timestamp,
        strikes:           JSON.stringify(data.strikes ?? data.legs ?? {}),
        premium_collected: data.premiumCollected   ?? null,
        exit_premium:      data.exitPremium        ?? null,
        realised_pnl:      data.realisedPnl        ?? null,
        intelligence_mode: data.intelligenceMode   ?? null,
        confidence:        data.confidence         ?? null,
        exit_reason:       data.exitReason         ?? null,
        source:            'live',
      });
      count++;
    }
  });

  const closedEntries = lines
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(e => e && e.eventType === 'TRADE_CLOSED');

  insertMany(closedEntries);
  return count;
}

// ── Snapshot backfill ──────────────────────────────────────────────────────

function backfillSnapshots() {
  if (!fs.existsSync(SNAPSHOTS_DIR)) {
    log('INFO', 'No snapshots/ directory found — skipping snapshot backfill');
    return 0;
  }

  const files = fs.readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.ndjson'));
  let total = 0;

  for (const file of files) {
    const filePath = path.join(SNAPSHOTS_DIR, file);
    const lines = fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);

    const insertMany = db.transaction((entries) => {
      for (const entry of entries) {
        insertSnapshot.run({
          symbol:      (entry.symbol ?? 'NIFTY').toUpperCase(),
          timestamp:   entry.timestamp,
          trade_date:  entry.timestamp.slice(0, 10),
          vix:         entry.vix             ?? null,
          pcr:         entry.pcr             ?? null,
          atm_strike:  entry.atmStrike       ?? null,
          underlying:  entry.underlyingValue ?? null,
          strike_data: entry.strikeData ? JSON.stringify(entry.strikeData) : null,
          source:      'intraday',
        });
        total++;
      }
    });

    const entries = lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    insertMany(entries);
    log('INFO', `Backfilled ${entries.length} snapshots from ${file}`);
  }

  return total;
}

// ── Main ───────────────────────────────────────────────────────────────────

log('INFO', 'Starting backfill…');
const trades    = backfillJournal();
const snapshots = backfillSnapshots();
log('INFO', `Backfill complete — ${trades} trades, ${snapshots} snapshots inserted`);
