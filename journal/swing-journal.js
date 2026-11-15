/**
 * @file swing-journal.js
 * @description Phase 8: append-only swing trade journal.
 *              NDJSON at journal/swing-trades.ndjson + SQLite for open trade tracking.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { writeSwingTrade, closeSwingTrade, readOpenSwingTrades } = require('../data/db');

const JOURNAL_PATH = path.join(__dirname, 'swing-trades.ndjson');

function _append(eventType, data) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), eventType, data }) + '\n';
  fs.appendFileSync(JOURNAL_PATH, entry, 'utf8');
}

/**
 * Record a signal that was sent to the user.
 * @param {object} signal
 */
function writeSignal(signal) {
  _append('SWING_SIGNAL_SENT', signal);
}

/**
 * Record a manual trade entry logged via /smm enter.
 * @param {{ symbol, setupId, direction, entryPrice, stopLoss, target, shares, tradeDate }}
 */
function writeEntry({ symbol, setupId, direction, entryPrice, stopLoss, target, shares, tradeDate }) {
  _append('SWING_TRADE_ENTERED', { symbol, setupId, direction, entryPrice, stopLoss, target, shares, tradeDate });
  writeSwingTrade({
    symbol,
    setup_id:    setupId,
    direction,
    entry_price: entryPrice,
    stop_loss:   stopLoss,
    target,
    shares,
    trade_date:  tradeDate,
    state:       'OPEN',
  });
}

/**
 * Record a manual trade exit logged via /smm exit.
 * @param {{ symbol, exitPrice, exitReason, exitDate, notes }}
 */
function writeExit({ symbol, exitPrice, exitReason, exitDate, notes }) {
  _append('SWING_TRADE_EXITED', { symbol, exitPrice, exitReason, exitDate, notes });
  closeSwingTrade({ symbol, exitPrice, exitReason, exitDate, notes });
}

/**
 * Returns all open swing trades from SQLite.
 * @returns {Array}
 */
function readOpen() {
  return readOpenSwingTrades();
}

/**
 * Returns all NDJSON journal entries, optionally filtered by date prefix (YYYY-MM-DD).
 * @param {string} [date]
 * @returns {Array}
 */
function readAll(date) {
  if (!fs.existsSync(JOURNAL_PATH)) return [];
  const lines = fs.readFileSync(JOURNAL_PATH, 'utf8').split('\n').filter(l => l.trim());
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!date) return entries;
  return entries.filter(e => e.timestamp.startsWith(date));
}

module.exports = { writeSignal, writeEntry, writeExit, readOpen, readAll };
