/**
 * @file query.js
 * @description Phase 9: SQLite query helpers for analytics over trades,
 *              options_bt_trades and swing_trades tables.
 */
'use strict';

const { db } = require('../data/db');

// ── Options BT trades ─────────────────────────────────────────────────────────

/**
 * All options backtest trades for a strategy in [from, to].
 */
function getBtTrades({ strategy, from, to } = {}) {
  let sql  = 'SELECT * FROM options_bt_trades WHERE 1=1';
  const params = [];
  if (strategy) { sql += ' AND strategy = ?'; params.push(strategy); }
  if (from)     { sql += ' AND trade_date >= ?'; params.push(from); }
  if (to)       { sql += ' AND trade_date <= ?'; params.push(to); }
  sql += ' ORDER BY trade_date ASC';
  return db.prepare(sql).all(...params);
}

/**
 * Cumulative P&L series: [{ date, pnl, cumPnl }]
 */
function cumulativePnl({ strategy, from, to } = {}) {
  const trades = getBtTrades({ strategy, from, to });
  let cum = 0;
  return trades.map(t => {
    cum += t.realised_pnl ?? 0;
    return { date: t.trade_date, pnl: t.realised_pnl ?? 0, cumPnl: cum };
  });
}

/**
 * Per-year P&L breakdown: { year: { trades, pnl, winRate } }
 */
function yearlyBreakdown({ strategy, from, to } = {}) {
  const trades = getBtTrades({ strategy, from, to });
  const byYear = {};
  for (const t of trades) {
    const year = (t.trade_date || '').slice(0, 4);
    if (!byYear[year]) byYear[year] = { trades: 0, pnl: 0, wins: 0 };
    byYear[year].trades++;
    byYear[year].pnl += t.realised_pnl ?? 0;
    if ((t.realised_pnl ?? 0) > 0) byYear[year].wins++;
  }
  for (const y of Object.values(byYear)) {
    y.winRate = y.trades > 0 ? y.wins / y.trades : 0;
  }
  return byYear;
}

/**
 * Max drawdown (₹) over all BT trades for a strategy.
 */
function maxDrawdown({ strategy, from, to } = {}) {
  const trades = getBtTrades({ strategy, from, to });
  let peak = 0, cum = 0, dd = 0;
  for (const t of trades) {
    cum += t.realised_pnl ?? 0;
    if (cum > peak) peak = cum;
    const cur = peak - cum;
    if (cur > dd) dd = cur;
  }
  return dd;
}

// ── Swing trades ──────────────────────────────────────────────────────────────

/**
 * All swing journal trades (live entries) in [from, to].
 */
function getSwingTrades({ from, to, state } = {}) {
  let sql = 'SELECT * FROM swing_trades WHERE 1=1';
  const params = [];
  if (from)  { sql += ' AND trade_date >= ?'; params.push(from); }
  if (to)    { sql += ' AND trade_date <= ?'; params.push(to); }
  if (state) { sql += ' AND state = ?';       params.push(state); }
  sql += ' ORDER BY trade_date ASC';
  return db.prepare(sql).all(...params);
}

/**
 * Per-setup win rate for logged swing trades.
 */
function swingPerSetup({ from, to } = {}) {
  const trades = getSwingTrades({ from, to, state: 'CLOSED' });
  const bySetup = {};
  for (const t of trades) {
    const id = t.setup_id;
    if (!bySetup[id]) bySetup[id] = { trades: 0, wins: 0, pnl: 0 };
    bySetup[id].trades++;
    if (t.exit_price && t.entry_price) {
      const pnl = t.direction === 'LONG'
        ? (t.exit_price - t.entry_price) * (t.shares || 1)
        : (t.entry_price - t.exit_price) * (t.shares || 1);
      bySetup[id].pnl += pnl;
      if (pnl > 0) bySetup[id].wins++;
    }
  }
  for (const s of Object.values(bySetup)) {
    s.winRate = s.trades > 0 ? s.wins / s.trades : 0;
  }
  return bySetup;
}

module.exports = { getBtTrades, cumulativePnl, yearlyBreakdown, maxDrawdown, getSwingTrades, swingPerSetup };
