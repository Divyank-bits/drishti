/**
 * @file test-phase2-executor.js
 * @description Phase 2 Gate 1 — Paper executor fill simulation and P&L math.
 */
'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

// ── Test setup ────────────────────────────────────────────────────────────
const EventEmitter = require('events');
const stubBus = new EventEmitter();

// Inject stubs before requiring the module
const Module = require('module');
const _resolveFilename = Module._resolveFilename.bind(Module);
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.includes('event-bus')) return request;
  if (request.includes('events') && request.includes('core')) return request;
  return _resolveFilename(request, parent, isMain, options);
};
require.cache[require.resolve('./core/event-bus')] = { exports: stubBus };

const PaperExecutor = require('./execution/paper-executor');

console.log('\n── Paper Executor Tests ─────────────────────────────────────────\n');

// Inject a fake LTP and fake strikeData
PaperExecutor._lastLtp = 24185;
PaperExecutor._lastStrikeData = {
  24400: { ce: 80.0,  pe: null },
  24600: { ce: 40.0,  pe: null },
  23900: { ce: null,  pe: 75.0  },
  23700: { ce: null,  pe: 40.0  },
};

const legs = [
  { strike: 24400, type: 'CE', action: 'SELL' },  // short CE
  { strike: 24600, type: 'CE', action: 'BUY'  },  // long CE hedge
  { strike: 23900, type: 'PE', action: 'SELL' },  // short PE
  { strike: 23700, type: 'PE', action: 'BUY'  },  // long PE hedge
];

test('T01 placeOrder returns fill with 4 legs', async () => {
  const fill = await PaperExecutor.placeOrder(legs);
  assert.strictEqual(fill.legs.length, 4, 'fill has 4 legs');
  assert(typeof fill.orderId === 'string', 'fill has orderId');
  assert(typeof fill.premiumCollected === 'number', 'fill has premiumCollected');
});

test('T02 sell legs fill at ltp - slippage', async () => {
  const fill = await PaperExecutor.placeOrder(legs);
  const shortCe = fill.legs.find(l => l.strike === 24400 && l.action === 'SELL');
  const config = require('./config');
  assert.strictEqual(shortCe.fillPrice, 80.0 - config.SLIPPAGE_PER_LOT);
});

test('T03 buy legs fill at ltp + slippage', async () => {
  const fill = await PaperExecutor.placeOrder(legs);
  const longCe = fill.legs.find(l => l.strike === 24600 && l.action === 'BUY');
  const config = require('./config');
  assert.strictEqual(longCe.fillPrice, 40.0 + config.SLIPPAGE_PER_LOT);
});

test('T04 premiumCollected = (shortCe - longCe + shortPe - longPe) * lotSize', async () => {
  const config = require('./config');
  const slip = config.SLIPPAGE_PER_LOT;
  const lotSize = config.NIFTY_LOT_SIZE;
  const fill = await PaperExecutor.placeOrder(legs);
  const shortCePrice = 80.0 - slip;
  const longCePrice  = 40.0 + slip;
  const shortPePrice = 75.0 - slip;
  const longPePrice  = 40.0 + slip;
  const expected = (shortCePrice - longCePrice + shortPePrice - longPePrice) * lotSize;
  assert.strictEqual(fill.premiumCollected, Math.round(expected * 100) / 100);
});

test('T05 exitOrder returns realised P&L', async () => {
  const fill = await PaperExecutor.placeOrder(legs);
  // Update strikeData to simulate option price changes (decay)
  PaperExecutor._lastStrikeData = {
    24400: { ce: 50.0,  pe: null },
    24600: { ce: 25.0,  pe: null },
    23900: { ce: null,  pe: 45.0  },
    23700: { ce: null,  pe: 22.0  },
  };
  const exit = await PaperExecutor.exitOrder(fill.orderId);
  assert(typeof exit.realisedPnl === 'number', 'exit has realisedPnl');
  assert(exit.realisedPnl > 0, 'realised P&L positive when premium decayed');
});

test('T06 computeUnrealisedPnl returns number given current strikeData', () => {
  PaperExecutor._lastStrikeData = {
    24400: { ce: 60.0,  pe: null },
    24600: { ce: 30.0,  pe: null },
    23900: { ce: null,  pe: 55.0  },
    23700: { ce: null,  pe: 28.0  },
  };
  const fill = { premiumCollected: 500, legs };
  const pnl = PaperExecutor.computeUnrealisedPnl(fill);
  assert(typeof pnl === 'number', 'returns number');
});

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
