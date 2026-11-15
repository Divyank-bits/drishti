/**
 * @file options-backtest.js
 * @description Phase 9: CLI entry point for the options backtester.
 *
 * Usage:
 *   node options-backtest.js [options]
 *
 * Options:
 *   --strategy iron-condor   (default; comma-separated for multiple)
 *   --symbols  NIFTY         (default; comma-separated)
 *   --from     YYYY-MM-DD    (default: 2 years ago)
 *   --to       YYYY-MM-DD    (default: today)
 *
 * Prerequisites:
 *   Bhavcopy synced: node sync-bhavcopy.js --from ... --to ...
 *   Underlying index candles are auto-synced from Yahoo Finance on first run.
 */
'use strict';

require('dotenv').config();

const { run }         = require('./backtest/options-runner');
const { printReport } = require('./backtest/options-report');

const argv = process.argv.slice(2);
function getArg(flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : null;
}

const strategiesArg = getArg('--strategy') || 'iron-condor';
const symbolsArg    = getArg('--symbols')  || 'NIFTY';
const to            = getArg('--to')   || new Date().toISOString().slice(0, 10);
const from          = getArg('--from') || (() => {
  const d = new Date(); d.setFullYear(d.getFullYear() - 2); return d.toISOString().slice(0, 10);
})();

const strategies = strategiesArg.split(',').map(s => s.trim());
const symbols    = symbolsArg.split(',').map(s => s.trim());

console.log(`\nDrishti Options Backtest`);
console.log(`  Symbols    : ${symbols.join(', ')}`);
console.log(`  Strategies : ${strategies.join(', ')}`);
console.log(`  Period     : ${from} → ${to}`);
console.log(`  Data       : EOD_BHAVCOPY\n`);

(async () => {
  // Auto-sync underlying index candles (NIFTY, BANKNIFTY) if not present
  const { sync } = require('./data/daily-candles');
  const { readDailyCandles } = require('./data/db');
  for (const sym of symbols) {
    const existing = readDailyCandles(sym, from, to);
    if (existing.length === 0) {
      console.log(`[setup] No daily candles for ${sym} — syncing from Yahoo Finance...`);
      try {
        const n = await sync(sym);
        console.log(`[setup] ${sym}: synced ${n} rows\n`);
      } catch (e) {
        console.warn(`[setup] ${sym} sync failed: ${e.message}\n`);
      }
    }
  }

  const trades = run({ symbols, strategies, from, to });
  printReport(trades, { from, to, symbols, strategies });
  console.log('Done.');
})();
