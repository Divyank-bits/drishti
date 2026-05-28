/**
 * @file trade-journal.js
 * @description Append-only NDJSON trade journal. Never modifies existing entries.
 *              Provides boot-time restore of pnlToday and tradesToday.
 *              Phase 7: also dual-writes closed trades to SQLite via data/db.js.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { writeTrade } = require('../data/db');

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

    if (eventType === 'TRADE_CLOSED') {
      const now = new Date().toISOString();
      writeTrade({
        trade_date:        now.slice(0, 10),
        strategy:          data.strategy          ?? 'unknown',
        entry_time:        data.entryTime         ?? now,
        exit_time:         data.exitTime          ?? now,
        strikes:           JSON.stringify(data.strikes ?? data.legs ?? {}),
        premium_collected: data.premiumCollected   ?? null,
        exit_premium:      data.exitPremium        ?? null,
        realised_pnl:      data.realisedPnl        ?? null,
        intelligence_mode: data.intelligenceMode   ?? null,
        confidence:        data.confidence         ?? null,
        exit_reason:       data.exitReason         ?? null,
        source:            'live',
      });
    }
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
  /**
   * Returns Dhan order IDs for positions that were filled today but not yet closed.
   * Used by boot reconciliation to detect orphaned live orders.
   * @returns {Promise<string[]>}
   */
  async getOpenOrderIds() {
    const entries = await this.readToday();
    const filledIds = new Set();
    const closedIds = new Set();

    for (const e of entries) {
      if (e.eventType === 'ORDER_FILLED' && e.data?.legs) {
        for (const leg of e.data.legs) {
          if (leg.dhanOrderId) filledIds.add(String(leg.dhanOrderId));
        }
      }
      if (e.eventType === 'TRADE_CLOSED' && e.data?.legs) {
        for (const leg of e.data.legs) {
          if (leg.dhanOrderId) closedIds.add(String(leg.dhanOrderId));
        }
      }
    }

    return [...filledIds].filter(id => !closedIds.has(id));
  }

  /**
   * Wires SCAN_RESULT and SCAN_SYMBOL_FLAGGED events to the journal.
   * Called once from index.js after Phase 5 scan scheduler is started.
   */
  hookScanEvents() {
    const eventBus = require('../core/event-bus');
    const EVENTS   = require('../core/events');

    eventBus.on(EVENTS.SCAN_RESULT, (payload) => {
      this.write('SCAN_RESULT', {
        symbol:         payload.symbol,
        score:          payload.score,
        strategyScores: payload.strategyScores,
        chain:          payload.chain,
      });
    });

    eventBus.on(EVENTS.SCAN_SYMBOL_FLAGGED, (payload) => {
      this.write('SCAN_SYMBOL_FLAGGED', {
        symbol:         payload.symbol,
        score:          payload.score,
        strategyScores: payload.strategyScores,
        chain:          payload.chain,
        indicators:     payload.indicators,
      });
    });
  }

  /**
   * Wires EQUITY_SCAN_RESULT, EQUITY_PATTERN_FORMING, EQUITY_PATTERN_CONFIRMED
   * events to the journal. Called once from index.js after Phase 6 scanner is wired.
   */
  hookEquityScanEvents() {
    const eventBus = require('../core/event-bus');
    const EVENTS   = require('../core/events');

    eventBus.on(EVENTS.EQUITY_SCAN_RESULT, (payload) => {
      this.write('EQUITY_SCAN_RESULT', {
        symbol:          payload.symbol,
        mode:            payload.mode,
        confluenceScore: payload.confluence?.score ?? null,
        confluenceState: payload.confluence?.state ?? null,
        dominantPattern: payload.confluence?.dominantPattern ?? null,
        dominantDirection: payload.confluence?.dominantDirection ?? null,
        error:           payload.error ?? null,
      });
    });

    eventBus.on(EVENTS.EQUITY_PATTERN_FORMING, (payload) => {
      this.write('EQUITY_PATTERN_FORMING', {
        symbol:          payload.symbol,
        confluenceScore: payload.confluence?.score,
        dominantPattern: payload.confluence?.dominantPattern,
        dominantDirection: payload.confluence?.dominantDirection,
        context:         payload.context,
        strategyResults: payload.strategyResults,
      });
    });

    eventBus.on(EVENTS.EQUITY_PATTERN_CONFIRMED, (payload) => {
      this.write('EQUITY_PATTERN_CONFIRMED', {
        symbol:          payload.symbol,
        confluenceScore: payload.confluence?.score,
        dominantPattern: payload.confluence?.dominantPattern,
        dominantDirection: payload.confluence?.dominantDirection,
        context:         payload.context,
        strategyResults: payload.strategyResults,
        claudeReasoning: payload.claudeReasoning ?? null,
      });
    });
  }
}

module.exports = new TradeJournal();
