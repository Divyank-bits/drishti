/**
 * @file swing-backtester.js
 * @description Phase 7: walks historical daily candles for each symbol, calls each swing
 *              setup on every bar, simulates trades per the Trade Simulation Rules, and
 *              writes per-trade results to backtest-results/YYYY-MM-DD-swing.ndjson.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const config  = require('../config');
const { readDailyCandles } = require('../data/db');
const { buildFeatures }    = require('../analysis/features');
const { getAll }           = require('../strategies/swing/registry');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [SwingBacktester] [${level}] ${msg}`);
}

// ── Trade simulation helpers ──────────────────────────────────────────────────

/**
 * Determine exit for an open trade.
 * Returns { exitDate, exitPrice, exitReason } or null if still open.
 *
 * @param {object} trade     — the open trade record
 * @param {Array}  daily     — full daily candle array
 * @param {number} entryBar  — bar index of entry (bar i+1 from signal)
 * @param {string} exitMode  — 'TARGET_SL' | 'TRAIL_EMA'
 * @param {object} features  — pre-built feature arrays
 */
function simulateExit(trade, daily, entryBar, exitMode, features) {
  const { direction, stopLoss, target } = trade;
  const isLong = direction === 'LONG';
  const maxHold = config.SWING_BT_MAX_HOLD_DAYS;
  const closeBasedStop = config.SWING_BT_STOP_MODE === 'CLOSE_BASED';

  for (let j = entryBar; j < daily.length; j++) {
    const bar = daily[j];
    const holdDays = j - entryBar;

    // ── Time stop ─────────────────────────────────────────────────────────────
    if (holdDays >= maxHold) {
      return { exitDate: bar.date, exitPrice: bar.close, exitReason: 'TIME_STOP' };
    }

    // ── Stop loss ─────────────────────────────────────────────────────────────
    if (closeBasedStop) {
      // Close-based: exit at next open if this bar's close is beyond the stop
      const stopHit = isLong ? bar.close < stopLoss : bar.close > stopLoss;
      if (stopHit) {
        const nextBar = daily[j + 1];
        if (!nextBar) return { exitDate: bar.date, exitPrice: bar.close, exitReason: 'STOP' };
        return { exitDate: nextBar.date, exitPrice: nextBar.open, exitReason: 'STOP' };
      }
    } else {
      // Intraday touch: check if bar's range touches the stop
      const stopHit = isLong ? bar.low <= stopLoss : bar.high >= stopLoss;
      if (stopHit) {
        // If opened beyond the stop, exit at open
        const exitPrice = (isLong && bar.open <= stopLoss) ? bar.open
          : (!isLong && bar.open >= stopLoss) ? bar.open
          : stopLoss;
        return { exitDate: bar.date, exitPrice, exitReason: 'STOP' };
      }
    }

    if (exitMode === 'TARGET_SL') {
      // ── Target ───────────────────────────────────────────────────────────────
      if (target !== null) {
        const targetHit = isLong ? bar.high >= target : bar.low <= target;
        if (targetHit) {
          // Same bar: stop + target → take the stop (conservative)
          const samBarStop = closeBasedStop
            ? (isLong ? bar.close < stopLoss : bar.close > stopLoss)
            : (isLong ? bar.low <= stopLoss  : bar.high >= stopLoss);
          if (samBarStop) {
            const nextBar = daily[j + 1];
            if (!nextBar) return { exitDate: bar.date, exitPrice: bar.close, exitReason: 'STOP' };
            return { exitDate: nextBar.date, exitPrice: nextBar.open, exitReason: 'STOP' };
          }
          // Open beyond target → exit at open
          const exitPrice = (isLong && bar.open >= target) ? bar.open
            : (!isLong && bar.open <= target) ? bar.open
            : target;
          return { exitDate: bar.date, exitPrice, exitReason: 'TARGET' };
        }
      }
    } else {
      // TRAIL_EMA: exit when EMA5 crosses EMA13
      if (j > entryBar) {
        const e5  = features.ema5;
        const e13 = features.ema13;
        if (e5[j] !== null && e13[j] !== null && e5[j - 1] !== null && e13[j - 1] !== null) {
          const crossedDown = e5[j] < e13[j] && e5[j - 1] >= e13[j - 1]; // bearish for LONG
          const crossedUp   = e5[j] > e13[j] && e5[j - 1] <= e13[j - 1]; // bullish for SHORT
          if ((isLong && crossedDown) || (!isLong && crossedUp)) {
            const nextBar = daily[j + 1];
            if (!nextBar) return { exitDate: bar.date, exitPrice: bar.close, exitReason: 'TRAIL_EMA' };
            return { exitDate: nextBar.date, exitPrice: nextBar.open, exitReason: 'TRAIL_EMA' };
          }
        }
      }
    }
  }

  // End of data — exit at last close
  const lastBar = daily[daily.length - 1];
  return { exitDate: lastBar.date, exitPrice: lastBar.close, exitReason: 'END_OF_DATA' };
}

/**
 * Compute result in R units after costs.
 * @param {number} entry
 * @param {number} stop
 * @param {number} exitPrice
 * @param {'LONG'|'SHORT'} direction
 * @returns {number}
 */
function computeR(entry, stop, exitPrice, direction) {
  const oneR = Math.abs(entry - stop);
  if (oneR === 0) return 0;
  const pnl = direction === 'LONG' ? exitPrice - entry : entry - exitPrice;
  // Costs: SWING_BT_COST_PCT % of entry, deducted as R units
  const costR = (config.SWING_BT_COST_PCT / 100) * entry / oneR;
  return pnl / oneR - costR;
}

// ── Main run function ─────────────────────────────────────────────────────────

/**
 * Run the backtester.
 *
 * @param {object} opts
 * @param {string[]} opts.symbols       — symbols to backtest
 * @param {string[]} opts.setupIds      — setup ids to run; empty = all
 * @param {string}   opts.from          — 'YYYY-MM-DD' start (inclusive)
 * @param {string}   opts.to            — 'YYYY-MM-DD' end (inclusive)
 * @param {string}   opts.exitMode      — 'TARGET_SL' | 'TRAIL_EMA'
 * @param {boolean}  opts.rrGate        — whether to enforce SWING_MIN_RR at entry
 * @returns {object[]} — array of trade records
 */
function run({ symbols, setupIds = [], from, to, exitMode = 'TARGET_SL', rrGate = true }) {
  const setups = getAll().filter(s => setupIds.length === 0 || setupIds.includes(s.id));
  const oosFraction = config.SWING_BT_OOS_FRACTION;
  const allTrades = [];

  for (const symbol of symbols) {
    log('INFO', `Processing ${symbol}...`);
    const candles = readDailyCandles(symbol, from || '2000-01-01', to || '9999-12-31');
    if (candles.length < 60) {
      log('WARN', `${symbol}: only ${candles.length} candles — skipping`);
      continue;
    }

    // Determine in-sample / out-of-sample boundary
    const oosCount  = Math.floor(candles.length * oosFraction);
    const oosStart  = candles.length - oosCount;
    const oosDate   = candles[oosStart] ? candles[oosStart].date : '9999-12-31';

    const features = buildFeatures(candles);

    // Track open trades per setup+direction to enforce one-at-a-time rule
    const openTrades = {}; // key: `${setupId}:${direction}`

    for (let i = 50; i < candles.length - 1; i++) {
      for (const setup of setups) {
        for (const direction of setup.directions) {
          const key = `${setup.id}:${direction}`;

          // If there's an open trade, check if it's closed by now
          if (openTrades[key]) {
            const ot = openTrades[key];
            if (ot.exitBar <= i) {
              delete openTrades[key];
            } else {
              continue; // position still open
            }
          }

          let result;
          try {
            result = setup.evaluate({ daily: candles, features, i, direction });
          } catch (err) {
            log('WARN', `${symbol} ${setup.id} ${direction} bar ${i}: ${err.message}`);
            continue;
          }

          if (result.state !== 'TRIGGERED') continue;

          // Entry is next bar's open
          const entryBar  = i + 1;
          if (entryBar >= candles.length) continue;
          const entryCandle = candles[entryBar];
          const entryPrice  = entryCandle.open;
          const stopLoss    = result.stopLoss;

          // Skip if entry is already beyond the stop
          if (direction === 'LONG'  && entryPrice <= stopLoss) continue;
          if (direction === 'SHORT' && entryPrice >= stopLoss) continue;

          // Recompute RR with actual entry price
          if (rrGate && result.target !== null) {
            const realRR = Math.abs(result.target - entryPrice) / Math.abs(entryPrice - stopLoss);
            if (realRR <= config.SWING_MIN_RR) continue;
          }

          // Simulate exit
          const trade = { symbol, setupId: setup.id, direction, stopLoss, target: result.target };
          const exit  = simulateExit(trade, candles, entryBar, exitMode, features);

          const holdDays = candles.findIndex(c => c.date === exit.exitDate) - entryBar;
          const rResult  = computeR(entryPrice, stopLoss, exit.exitPrice, direction);

          const sample = candles[i].date >= oosDate ? 'OOS' : 'IS';

          const tradeRecord = {
            symbol,
            setupId:     setup.id,
            direction,
            subtype:     result.subtype || null,
            signalDate:  candles[i].date,
            entryDate:   entryCandle.date,
            entryPrice,
            stopLoss,
            target:      result.target,
            exitDate:    exit.exitDate,
            exitPrice:   exit.exitPrice,
            exitReason:  exit.exitReason,
            holdDays:    Math.max(0, holdDays),
            resultR:     rResult,
            sample,
          };

          allTrades.push(tradeRecord);

          // Mark position as open until exit bar
          const exitBarIndex = candles.findIndex(c => c.date === exit.exitDate);
          openTrades[key] = { exitBar: exitBarIndex };
        }
      }
    }

    log('INFO', `${symbol}: done — ${allTrades.filter(t => t.symbol === symbol).length} trades`);
  }

  // Write NDJSON trade log
  const dateStr  = new Date().toISOString().slice(0, 10);
  const outDir   = path.join(__dirname, '..', 'backtest-results');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile  = path.join(outDir, `${dateStr}-swing.ndjson`);
  const lines    = allTrades.map(t => JSON.stringify(t)).join('\n');
  fs.writeFileSync(outFile, lines + (lines ? '\n' : ''), 'utf8');
  log('INFO', `Wrote ${allTrades.length} trades to ${outFile}`);

  return allTrades;
}

module.exports = { run };
