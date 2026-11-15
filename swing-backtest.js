/**
 * @file swing-backtest.js
 * @description Phase 7: CLI entry point for the swing setup backtester.
 *
 * Usage:
 *   node swing-backtest.js [options]
 *
 * Options:
 *   --setup <id>              run only this setup (default: all)
 *   --symbols A,B,C           override SWING_UNIVERSE
 *   --from YYYY-MM-DD         start date (default: config derives from SWING_HISTORY_YEARS)
 *   --to   YYYY-MM-DD         end date (default: today)
 *   --exit TARGET_SL|TRAIL_EMA  exit mode (default: SWING_BT_EXIT_MODE)
 *   --no-rr-gate              disable RR gate
 *   --sample IS|OOS|BOTH      sample to run (default: IS)
 */

'use strict';

require('dotenv').config();

const path    = require('path');
const config  = require('./config');
const EVENTS = require('./core/events');
const eventBus    = require('./core/event-bus');
const { run }     = require('./backtest/swing-backtester');
const { printReport } = require('./backtest/swing-report');
const { readDailyCandles } = require('./data/db');

// ── Parse CLI args ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function getArg(flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : null;
}

function hasFlag(flag) { return argv.includes(flag); }

// Symbols
const symbolsArg = getArg('--symbols');
const symbols = symbolsArg
  ? symbolsArg.split(',').map(s => s.trim())
  : config.SWING_UNIVERSE;

// Setup filter
const setupIdArg = getArg('--setup');
const setupIds = setupIdArg ? [setupIdArg] : [];

// Date range
const toDate   = getArg('--to')   || new Date().toISOString().slice(0, 10);
const fromDate = getArg('--from') || (() => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - config.SWING_HISTORY_YEARS);
  return d.toISOString().slice(0, 10);
})();

// Exit mode
const exitMode = getArg('--exit') || config.SWING_BT_EXIT_MODE;

// RR gate
const rrGate = !hasFlag('--no-rr-gate');

// Sample
const sample = getArg('--sample') || 'IS';

// ── Validate ──────────────────────────────────────────────────────────────────

if (!['IS', 'OOS', 'BOTH'].includes(sample)) {
  console.error(`Invalid --sample value: ${sample}. Use IS, OOS, or BOTH.`);
  process.exit(1);
}
if (!['TARGET_SL', 'TRAIL_EMA'].includes(exitMode)) {
  console.error(`Invalid --exit value: ${exitMode}. Use TARGET_SL or TRAIL_EMA.`);
  process.exit(1);
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log(`\nDrishti Swing Backtest`);
console.log(`  Symbols : ${symbols.join(', ')}`);
console.log(`  Setups  : ${setupIds.length > 0 ? setupIds.join(', ') : 'all'}`);
console.log(`  Period  : ${fromDate} → ${toDate}`);
console.log(`  Exit    : ${exitMode} / ${config.SWING_BT_STOP_MODE}`);
console.log(`  RR gate : ${rrGate ? '> ' + config.SWING_MIN_RR : 'off'}`);
console.log(`  Sample  : ${sample}\n`);

eventBus.emit(EVENTS.SWING_BACKTEST_STARTED, { symbols, setupIds, from: fromDate, to: toDate });

const trades = run({ symbols, setupIds, from: fromDate, to: toDate, exitMode, rrGate });

// Pre-load candle data for baseline computation
const allCandles = symbols.map(sym => ({
  symbol: sym,
  candles: readDailyCandles(sym, fromDate, toDate),
})).filter(x => x.candles.length > 0);

printReport(trades, {
  sample,
  from: fromDate,
  to: toDate,
  exitMode,
  rrGate,
  symbols,
  allCandles,
});

eventBus.emit(EVENTS.SWING_BACKTEST_COMPLETED, {
  trades: trades.length,
  sample,
  from: fromDate,
  to: toDate,
});

console.log('Done.');
