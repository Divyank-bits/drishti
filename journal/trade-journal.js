/**
 * @file trade-journal.js
 * @description Append-only NDJSON trade journal. Never modifies existing entries.
 *              Provides boot-time restore of pnlToday and tradesToday.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [TradeJournal] [${level}] ${msg}`);
}

class TradeJournal {
  constructor() {
    this._filePath = path.join(__dirname, 'trades.ndjson');
  }

  /**
   * Appends one NDJSON line. Never overwrites.
   * @param {string} eventType
   * @param {object} data
   */
  async write(eventType, data) {
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), eventType, data }) + '\n';
    fs.appendFileSync(this._filePath, entry, 'utf8');
  }

  /**
   * Returns all journal entries from today (UTC date match).
   * @returns {Promise<Array>}
   */
  async readToday() {
    if (!fs.existsSync(this._filePath)) return [];
    const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const lines = fs.readFileSync(this._filePath, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    return lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.timestamp && e.timestamp.startsWith(today));
  }

  /**
   * Reads today's TRADE_CLOSED entries and returns running totals.
   * Called at boot to restore session state after a restart.
   * @returns {Promise<{pnlToday: number, tradesToday: number}>}
   */
  async restoreFromJournal() {
    const entries = await this.readToday();
    const closedTrades = entries.filter(e => e.eventType === 'TRADE_CLOSED');
    const pnlToday   = closedTrades.reduce((sum, e) => sum + (e.data.realisedPnl || 0), 0);
    const tradesToday = closedTrades.length;
    if (tradesToday > 0) {
      log('INFO', `Restored from journal: ${tradesToday} trades, P&L ₹${pnlToday}`);
    }
    return { pnlToday: Math.round(pnlToday * 100) / 100, tradesToday };
  }
}

module.exports = new TradeJournal();
