/**
 * @file test-phase8.js
 * @description Phase 8 tests: risk module, swing journal, swing scanner shape,
 *              signal formatting helpers.
 *
 * Run: node tests/test-phase8.js
 */
'use strict';

require('dotenv').config();

const config = require('../config');
const { computeSize } = require('../core/risk');
const { writeSignal, writeEntry, writeExit, readOpen, readAll } = require('../journal/swing-journal');
const { db } = require('../data/db');

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

function approxEq(a, b, eps = 0.01) { return Math.abs(a - b) <= eps; }
function section(name) { console.log(`\n── ${name} ──`); }

// ── Risk module ───────────────────────────────────────────────────────────────

section('computeSize — basic');

{
  // accountSize=500000, riskPct=1.0 → riskRupees=5000
  // entry=1000, stop=950 → oneR=50 → shares=100, capital=100000
  const saved = { size: config.SWING_ACCOUNT_SIZE, pct: config.SWING_RISK_PCT_PER_TRADE };
  config.SWING_ACCOUNT_SIZE       = 500000;
  config.SWING_RISK_PCT_PER_TRADE = 1.0;

  const r = computeSize(1000, 950, 'LONG');
  assert(r.shares === 100,          `LONG: shares=100 (got ${r.shares})`);
  assert(r.capitalRequired === 100000, `LONG: capital=100000 (got ${r.capitalRequired})`);
  assert(approxEq(r.riskRupees, 5000), `LONG: riskRupees=5000 (got ${r.riskRupees})`);
  assert(approxEq(r.oneR, 50),      `LONG: oneR=50 (got ${r.oneR})`);

  config.SWING_ACCOUNT_SIZE       = saved.size;
  config.SWING_RISK_PCT_PER_TRADE = saved.pct;
}

{
  // SHORT: entry=200, stop=220 → oneR=20
  const saved = { size: config.SWING_ACCOUNT_SIZE, pct: config.SWING_RISK_PCT_PER_TRADE };
  config.SWING_ACCOUNT_SIZE       = 200000;
  config.SWING_RISK_PCT_PER_TRADE = 2.0;

  // riskRupees=4000, oneR=20 → shares=200, capital=40000
  const r = computeSize(200, 220, 'SHORT');
  assert(r.shares === 200,         `SHORT: shares=200 (got ${r.shares})`);
  assert(r.capitalRequired === 40000, `SHORT: capital=40000 (got ${r.capitalRequired})`);

  config.SWING_ACCOUNT_SIZE       = saved.size;
  config.SWING_RISK_PCT_PER_TRADE = saved.pct;
}

{
  // zero oneR → safe return
  const r = computeSize(100, 100, 'LONG');
  assert(r.shares === 0, `zero oneR → shares=0`);
  assert(r.capitalRequired === 0, `zero oneR → capital=0`);
}

section('computeSize — position scales inversely with stop distance');

{
  const saved = { size: config.SWING_ACCOUNT_SIZE, pct: config.SWING_RISK_PCT_PER_TRADE };
  config.SWING_ACCOUNT_SIZE       = 500000;
  config.SWING_RISK_PCT_PER_TRADE = 1.0;

  const tight = computeSize(1000, 990, 'LONG');   // oneR=10 → 500 shares
  const wide  = computeSize(1000, 950, 'LONG');   // oneR=50 → 100 shares
  assert(tight.shares > wide.shares, `tight stop → more shares (${tight.shares} > ${wide.shares})`);

  config.SWING_ACCOUNT_SIZE       = saved.size;
  config.SWING_RISK_PCT_PER_TRADE = saved.pct;
}

// ── Swing journal — write/read ────────────────────────────────────────────────

section('swing journal — writeSignal');

{
  const before = readAll().length;
  writeSignal({
    symbol: '__TEST__', setupId: 'smm-checklist', direction: 'LONG',
    entry: 100, stopLoss: 90, target: 130, riskReward: 3.0,
    asOf: '2024-01-01', size: { shares: 50, capitalRequired: 5000, riskRupees: 500, oneR: 10 },
  });
  const after = readAll().length;
  assert(after === before + 1, `writeSignal appends one entry (before=${before} after=${after})`);
}

section('swing journal — writeEntry + readOpen + writeExit');

{
  // Insert a trade in DB for __TEST2__ symbol
  const countBefore = readOpen().filter(t => t.symbol === '__TEST2__').length;

  writeEntry({
    symbol:     '__TEST2__',
    setupId:    'counter-attack',
    direction:  'LONG',
    entryPrice: 500,
    stopLoss:   480,
    target:     560,
    shares:     25,
    tradeDate:  '2024-01-02',
  });

  const open = readOpen().filter(t => t.symbol === '__TEST2__');
  assert(open.length === countBefore + 1, `writeEntry creates one open trade (got ${open.length})`);
  assert(open[open.length - 1].entry_price === 500, `entry_price=500`);
  assert(open[open.length - 1].state === 'OPEN', `state=OPEN`);

  // Close it
  writeExit({ symbol: '__TEST2__', exitPrice: 555, exitReason: 'MANUAL', exitDate: '2024-01-10', notes: null });
  const stillOpen = readOpen().filter(t => t.symbol === '__TEST2__');
  assert(stillOpen.length === 0, `writeExit closes the trade (open count=${stillOpen.length})`);
}

{
  // writeExit for unknown symbol — should not throw
  let threw = false;
  try { writeExit({ symbol: '__UNKNOWN__', exitPrice: 100, exitReason: 'MANUAL', exitDate: '2024-01-01', notes: null }); }
  catch { threw = true; }
  assert(!threw, `writeExit for unknown symbol does not throw`);
}

section('swing journal — readAll date filter');

{
  const all  = readAll();
  const day  = readAll('2024-01-01');
  assert(Array.isArray(all), `readAll returns array`);
  assert(day.every(e => e.timestamp.startsWith('2024-01-01')), `readAll(date) filters correctly`);
}

// ── swing-scanner shape ───────────────────────────────────────────────────────

section('swing-scanner — returns expected shape (empty universe)');

{
  const { scan } = require('../intelligence/swing-scanner');
  const result = scan([], []);
  assert(Array.isArray(result.signals), `result.signals is array`);
  assert(typeof result.asOf === 'string',       `result.asOf is string`);
  assert(typeof result.scannedAt === 'string',  `result.scannedAt is string`);
  assert(result.signals.length === 0,           `empty universe → 0 signals`);
}

section('swing-scanner — signal shape when signals exist (synthetic)');

{
  // We can't easily produce a live TRIGGERED signal without market data,
  // so we verify the shape contract by stubbing a minimal registry call.
  // Instead: verify computeSize output is attached if a hypothetical signal fires.
  const { computeSize: cs } = require('../core/risk');
  const size = cs(2890, 2820, 'LONG');
  assert(typeof size.shares === 'number',          `size.shares is number`);
  assert(typeof size.capitalRequired === 'number', `size.capitalRequired is number`);
  assert(typeof size.riskRupees === 'number',      `size.riskRupees is number`);
  assert(typeof size.oneR === 'number',            `size.oneR is number`);
}

// ── config keys ───────────────────────────────────────────────────────────────

section('Phase 8 config keys exist');

assert(typeof config.SWING_SCAN_ENABLED === 'boolean',       `SWING_SCAN_ENABLED is boolean`);
assert(typeof config.SWING_SCAN_TIME === 'string',           `SWING_SCAN_TIME is string`);
assert(typeof config.SWING_ACCOUNT_SIZE === 'number',        `SWING_ACCOUNT_SIZE is number`);
assert(typeof config.SWING_RISK_PCT_PER_TRADE === 'number',  `SWING_RISK_PCT_PER_TRADE is number`);
assert(config.SWING_ACCOUNT_SIZE > 0,                        `SWING_ACCOUNT_SIZE > 0`);
assert(config.SWING_RISK_PCT_PER_TRADE > 0,                  `SWING_RISK_PCT_PER_TRADE > 0`);
assert(/^\d{2}:\d{2}$/.test(config.SWING_SCAN_TIME),        `SWING_SCAN_TIME matches HH:MM`);

// ── events ────────────────────────────────────────────────────────────────────

section('Phase 8 events exist');

const EVENTS = require('../core/events');
assert(EVENTS.SWING_SCAN_STARTED     === 'SWING_SCAN_STARTED',     `SWING_SCAN_STARTED`);
assert(EVENTS.SWING_SCAN_COMPLETED   === 'SWING_SCAN_COMPLETED',   `SWING_SCAN_COMPLETED`);
assert(EVENTS.SWING_SIGNAL_TRIGGERED === 'SWING_SIGNAL_TRIGGERED', `SWING_SIGNAL_TRIGGERED`);
assert(EVENTS.SWING_TRADE_ENTERED    === 'SWING_TRADE_ENTERED',    `SWING_TRADE_ENTERED`);
assert(EVENTS.SWING_TRADE_EXITED     === 'SWING_TRADE_EXITED',     `SWING_TRADE_EXITED`);

// ── DB schema ─────────────────────────────────────────────────────────────────

section('swing_trades table exists in DB');

{
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='swing_trades'`).get();
  assert(row && row.name === 'swing_trades', `swing_trades table exists`);
}

// ── Cleanup test data ─────────────────────────────────────────────────────────

db.prepare(`DELETE FROM swing_trades WHERE symbol LIKE '__TEST%'`).run();

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Phase 8 tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
