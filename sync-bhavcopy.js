/**
 * @file sync-bhavcopy.js
 * @description Phase 9: CLI to download and store NSE FO Bhavcopy data.
 *
 * Usage:
 *   node sync-bhavcopy.js --from YYYY-MM-DD --to YYYY-MM-DD [--symbol NIFTY]
 *
 * Downloads one zip file per trading day from NSE archives and stores parsed
 * options OHLCV data to the options_bhavcopy SQLite table.
 */
'use strict';

require('dotenv').config();

const { syncRange } = require('./data/bhavcopy');

const argv = process.argv.slice(2);
function getArg(flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : null;
}

const from   = getArg('--from') || (() => {
  const d = new Date(); d.setFullYear(d.getFullYear() - 2); return d.toISOString().slice(0, 10);
})();
const to     = getArg('--to')   || new Date().toISOString().slice(0, 10);
const symbol = getArg('--symbol') || 'NIFTY';

console.log(`\nDrishti Bhavcopy Sync`);
console.log(`  Symbol : ${symbol}`);
console.log(`  From   : ${from}`);
console.log(`  To     : ${to}\n`);

syncRange({ from, to, symbol, concurrency: 2 })
  .then(({ synced, skipped, errors }) => {
    console.log(`\nDone — synced=${synced} skipped=${skipped} errors=${errors}`);
  })
  .catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
