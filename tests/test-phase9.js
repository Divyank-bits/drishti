/**
 * @file test-phase9.js
 * @description Phase 9 tests: Bhavcopy parser, candle replayer, options replayer,
 *              options runner trade record shape, analytics query helpers, report metrics.
 *
 * Run: node tests/test-phase9.js
 */
'use strict';

require('dotenv').config();

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

function approxEq(a, b, eps = 0.001) { return Math.abs(a - b) <= eps; }
function section(name) { console.log(`\n── ${name} ──`); }

// ── Bhavcopy parser ───────────────────────────────────────────────────────────

section('bhavcopy — parseCsv');

const { parseCsv, bhavcopyUrl, nseExpiryToIso, tradingDays } = require('../data/bhavcopy');

{
  // Minimal CSV with one OPTNIFTY row
  const csv = [
    'INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP',
    'OPTNIFTY,NIFTY,29-FEB-2024,22000,CE,120.5,135.0,110.0,125.0,125.0,500,62.5,10000,200,29-FEB-2024',
    'FUTIDX,NIFTY,29-MAR-2024,,XX,21900,22100,21800,22000,22000,1000,2200,50000,0,29-FEB-2024',
  ].join('\n');

  const rows = parseCsv(csv, 'NIFTY', '2024-02-29');
  assert(rows.length === 1,                        `parseCsv: 1 row (filtered futures)`);
  assert(rows[0].symbol === 'NIFTY',               `parseCsv: symbol=NIFTY`);
  assert(rows[0].option_type === 'CE',             `parseCsv: option_type=CE`);
  assert(rows[0].strike === 22000,                 `parseCsv: strike=22000`);
  assert(rows[0].open === 120.5,                   `parseCsv: open=120.5`);
  assert(rows[0].expiry === '2024-02-29',          `parseCsv: expiry parsed`);
  assert(rows[0].date === '2024-02-29',            `parseCsv: date=2024-02-29`);
}

{
  // Empty CSV
  const rows = parseCsv('', 'NIFTY', '2024-01-01');
  assert(rows.length === 0, `parseCsv: empty csv → 0 rows`);
}

{
  // No filter → keeps all symbols
  const csv = [
    'INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP',
    'OPTNIFTY,NIFTY,29-MAR-2024,22000,CE,120,130,110,125,125,100,12.5,5000,50,29-FEB-2024',
    'OPTSTK,RELIANCE,29-MAR-2024,2800,PE,30,35,28,32,32,50,1.6,2000,10,29-FEB-2024',
  ].join('\n');

  const rows = parseCsv(csv, null, '2024-02-29');
  assert(rows.length === 2, `parseCsv: no filter → 2 rows`);
}

section('bhavcopy — nseExpiryToIso');

{
  assert(nseExpiryToIso('29-FEB-2024') === '2024-02-29', `DD-MMM-YYYY format`);
  assert(nseExpiryToIso('31-DEC-2023') === '2023-12-31', `DD-MMM-YYYY December`);
  assert(nseExpiryToIso('29FEB2024')   === '2024-02-29', `DDMMMYYYY format`);
  assert(nseExpiryToIso('baddate')     === null,          `invalid → null`);
}

section('bhavcopy — bhavcopyUrl');

{
  const url = bhavcopyUrl('2024-02-29');
  assert(url.includes('2024'),       `URL contains year`);
  assert(url.includes('FEB'),        `URL contains month`);
  assert(url.includes('29FEB2024'),  `URL contains date string`);
  assert(url.endsWith('.zip'),       `URL ends with .zip`);
}

section('bhavcopy — tradingDays');

{
  const days = tradingDays('2024-01-01', '2024-01-07');
  // Mon Jan 1 is a weekday, Sat Jan 6 and Sun Jan 7 are skipped
  assert(days.length === 5,                `2024-01-01 to 01-07 = 5 trading days`);
  assert(!days.includes('2024-01-06'),     `Saturday excluded`);
  assert(!days.includes('2024-01-07'),     `Sunday excluded`);
  assert(days[0] === '2024-01-01',         `first day is Monday`);
}

// ── options-runner helpers ────────────────────────────────────────────────────

section('options-runner — selectStrikes');

const { selectStrikes, nearestExpiry } = require('../backtest/options-runner');

{
  // ATM = round(22150 / 50) * 50 = 22150
  // shortCE = 22150+200=22350, longCE=22550, shortPE=21950, longPE=21750
  // 22350 % 100 = 50, so no shift. 21950 % 100 = 50, no shift.
  const s = selectStrikes(22150);
  assert(s.shortCe === 22350, `shortCe=22350 (got ${s.shortCe})`);
  assert(s.longCe  === 22550, `longCe=22550 (got ${s.longCe})`);
  assert(s.shortPe === 21950, `shortPe=21950 (got ${s.shortPe})`);
  assert(s.longPe  === 21750, `longPe=21750 (got ${s.longPe})`);
}

{
  // exact-hundred shift: ATM=24000, shortCE=24200 (200%100=0 → +50 → 24250)
  const s = selectStrikes(24000);
  assert(s.shortCe % 100 !== 0, `shortCe not on exact hundred after shift (${s.shortCe})`);
  assert(s.shortPe % 100 !== 0, `shortPe not on exact hundred after shift (${s.shortPe})`);
}

section('options-runner — nearestExpiry');

{
  // For a date in January, nearest expiry should be the last Thursday of January
  const e = nearestExpiry('2024-01-02');
  assert(e !== null,                   `nearestExpiry returns a date`);
  assert(e > '2024-01-02',            `expiry is after trade date`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(e), `expiry is ISO date`);
}

{
  // Date on expiry day — should return next month's expiry
  const e = nearestExpiry('2024-01-25');  // Last Thu of Jan 2024
  assert(e !== null && e >= '2024-01-25', `expiry >= trade date`);
}

// ── candle replayer ───────────────────────────────────────────────────────────

section('candle-replayer — load (no data)');

{
  const { load } = require('../backtest/candle-replayer');
  const candles = load('__NOEXIST__', '2024-01-01', '2024-12-31');
  assert(Array.isArray(candles),   `load returns array`);
  assert(candles.length === 0,     `non-existent symbol → empty array`);
}

section('candle-replayer — replay emits events');

{
  const { replay } = require('../backtest/candle-replayer');
  const eventBus = require('../core/event-bus');
  const EVENTS   = require('../core/events');

  // Insert a fake candle so we have data to replay
  const { db } = require('../data/db');
  db.prepare(`
    INSERT OR IGNORE INTO daily_candles (symbol, date, open, high, low, close, volume, source)
    VALUES ('__REPLAY_TEST__', '2024-01-02', 100, 110, 95, 105, 1000, 'TEST')
  `).run();

  let emitted = 0;
  eventBus.once(EVENTS.CANDLE_CLOSE_15, (c) => {
    if (c.symbol === '__REPLAY_TEST__') emitted++;
  });

  replay('__REPLAY_TEST__', '2024-01-01', '2024-12-31');
  assert(emitted === 1, `replay emits CANDLE_CLOSE_15 (got ${emitted})`);

  db.prepare(`DELETE FROM daily_candles WHERE symbol='__REPLAY_TEST__'`).run();
}

// ── options-report metrics ────────────────────────────────────────────────────

section('options-report — computeMetrics');

const { computeMetrics } = require('../backtest/options-report');

{
  const trades = [
    { realised_pnl: 1000, trade_date: '2024-01-02', exit_reason: 'EXPIRY' },
    { realised_pnl: 1500, trade_date: '2024-01-10', exit_reason: 'EXPIRY' },
    { realised_pnl: -800, trade_date: '2024-01-15', exit_reason: 'STOP_HIT' },
    { realised_pnl:  600, trade_date: '2024-02-05', exit_reason: 'EXPIRY' },
    { realised_pnl: -300, trade_date: '2024-02-20', exit_reason: 'STOP_HIT' },
  ];

  const m = computeMetrics(trades);
  assert(m !== null,                        `computeMetrics returns object`);
  assert(approxEq(m.winRate, 3 / 5),        `winRate=0.6 (got ${m.winRate})`);
  assert(approxEq(m.totalPnl, 2000),        `totalPnl=2000 (got ${m.totalPnl})`);
  assert(approxEq(m.avgPnl, 400),           `avgPnl=400 (got ${m.avgPnl})`);
  assert(m.profitFactor > 1,                `profitFactor > 1`);
  assert(m.maxDrawdown >= 0,                `maxDrawdown >= 0`);
  assert(m.maxConsecLoss === 1,             `maxConsecLoss=1 (got ${m.maxConsecLoss})`);
  assert(typeof m.byYear === 'object',      `byYear is object`);
}

{
  // empty trades
  const m = computeMetrics([]);
  assert(m === null, `empty trades → null`);
}

// ── analytics/query ───────────────────────────────────────────────────────────

section('analytics/query — getBtTrades (empty)');

{
  const { getBtTrades, cumulativePnl, yearlyBreakdown, maxDrawdown } = require('../analytics/query');
  const trades = getBtTrades({ strategy: '__NONEXISTENT__' });
  assert(Array.isArray(trades),   `getBtTrades returns array`);
  assert(trades.length === 0,     `no trades for dummy strategy`);

  const cum = cumulativePnl({ strategy: '__NONEXISTENT__' });
  assert(Array.isArray(cum),      `cumulativePnl returns array`);

  const yb = yearlyBreakdown({ strategy: '__NONEXISTENT__' });
  assert(typeof yb === 'object',  `yearlyBreakdown returns object`);

  const dd = maxDrawdown({ strategy: '__NONEXISTENT__' });
  assert(dd === 0,                `maxDrawdown=0 for empty`);
}

section('analytics/query — write + read round-trip');

{
  const { writeBtTrade } = require('../data/db');
  const { getBtTrades, cumulativePnl } = require('../analytics/query');

  writeBtTrade({
    run_date: '2024-01-01', strategy: '__TEST_STRAT__', trade_date: '2024-01-02',
    symbol: 'NIFTY', expiry: '2024-01-25', short_ce: 22400, long_ce: 22600,
    short_pe: 21800, long_pe: 21600, premium_in: 120, premium_out: 60,
    realised_pnl: 1500, exit_reason: 'EXPIRY', data_source: 'EOD_BHAVCOPY',
  });

  const trades = getBtTrades({ strategy: '__TEST_STRAT__' });
  assert(trades.length >= 1,                   `at least 1 trade written`);
  assert(trades[0].realised_pnl === 1500,      `realised_pnl=1500`);
  assert(trades[0].data_source === 'EOD_BHAVCOPY', `data_source=EOD_BHAVCOPY`);

  const cum = cumulativePnl({ strategy: '__TEST_STRAT__' });
  assert(cum[cum.length - 1].cumPnl === 1500,  `cumPnl=1500 after one trade`);

  // Cleanup
  require('../data/db').db.prepare(`DELETE FROM options_bt_trades WHERE strategy='__TEST_STRAT__'`).run();
}

// ── DB schema ─────────────────────────────────────────────────────────────────

section('DB schema — new Phase 9 tables');

{
  const { db } = require('../data/db');
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  assert(tables.includes('options_bhavcopy'),   `options_bhavcopy table exists`);
  assert(tables.includes('options_bt_trades'),  `options_bt_trades table exists`);
}

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Phase 9 tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
