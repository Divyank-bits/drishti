/**
 * @file test-phase2-integration.js
 * @description Phase 2 Gate 6 — Full paper trading loop without live APIs.
 *              Injects synthetic events through the real event bus and verifies the
 *              complete signal → fill → monitor → exit → journal lifecycle.
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n── Integration Tests ────────────────────────────────────────────\n');

// Use real event bus for integration
const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');

// Patch journal to temp file before any module loads it
const journal     = require('../journal/trade-journal');
const tmpJournal  = path.join(os.tmpdir(), `drishti-integration-${Date.now()}.ndjson`);
journal._filePath = tmpJournal;

// Load modules — they self-register on the event bus via require
const paperExecutor   = require('../execution/paper-executor');
const positionTracker = require('../monitoring/position-tracker');

// Inject fake market data so fills and exits can compute prices
const fakeStrikeData = {
  24400: { ce: 80, pe: null },
  24600: { ce: 40, pe: null },
  24000: { ce: null, pe: 75 },
  23800: { ce: null, pe: 40 },
};
paperExecutor._lastLtp        = 24185;
paperExecutor._lastStrikeData = fakeStrikeData;

const legs = [
  { strike: 24400, type: 'CE', action: 'SELL' },
  { strike: 24600, type: 'CE', action: 'BUY'  },
  { strike: 24000, type: 'PE', action: 'SELL' },
  { strike: 23800, type: 'PE', action: 'BUY'  },
];

(async () => {

  await test('T01 OPTIONS_CHAIN_UPDATED populates strikeData in executor', async () => {
    eventBus.emit(EVENTS.OPTIONS_CHAIN_UPDATED, {
      underlyingValue: 24185, vix: 16, pcr: 1.05, atmStrike: 24200,
      maxCeOiStrike: 24500, maxPeOiStrike: 23900,
      strikeData: fakeStrikeData,
      timestamp: new Date().toISOString(),
    });
    assert.deepStrictEqual(paperExecutor._lastStrikeData, fakeStrikeData);
  });

  await test('T02 placeOrder → ORDER_FILLED emitted, fill has orderId', async () => {
    let filled = false;
    eventBus.once(EVENTS.ORDER_FILLED, () => { filled = true; });
    const fill = await paperExecutor.placeOrder(legs);
    assert.strictEqual(filled, true, 'ORDER_FILLED was emitted');
    assert(fill.orderId, 'fill has orderId');
    // Wait for position to fully close if T02 triggers an unexpected exit
    await new Promise(r => setTimeout(r, 50));
  });

  await test('T03 CANDLE_CLOSE_15M within bounds → POSITION_CLOSED not emitted', async () => {
    // Ensure we have an active position for this test
    if (!positionTracker._activeFill) {
      await paperExecutor.placeOrder(legs);
      await new Promise(r => setTimeout(r, 50));
    }

    let exitEmitted = false;
    const handler = () => { exitEmitted = true; };
    eventBus.once(EVENTS.POSITION_CLOSED, handler);

    // 10:00 IST = 04:30 UTC — candle well within bounds
    eventBus.emit(EVENTS.CANDLE_CLOSE_15M, {
      open: 24180, high: 24200, low: 24160, close: 24185,
      volume: 800,
      openTime: new Date('2026-04-14T04:30:00.000Z').getTime(),
    });

    await new Promise(r => setTimeout(r, 100));
    eventBus.removeListener(EVENTS.POSITION_CLOSED, handler);
    assert.strictEqual(exitEmitted, false, 'no exit on candle within bounds');
  });

  await test('T04 absolute P&L stop triggers POSITION_CLOSED', async () => {
    // T03 left the position active — use it directly
    assert(positionTracker._activeFill, 'expected active position from T03');

    // Force P&L below absolute stop (> 50% of MAX_DAILY_LOSS = ₹2500)
    positionTracker._lastKnownPnl = -3000;

    let closed = false;
    eventBus.once(EVENTS.POSITION_CLOSED, () => { closed = true; });

    eventBus.emit(EVENTS.CANDLE_CLOSE_15M, {
      open: 24400, high: 24450, low: 24380, close: 24430,
      volume: 2000,
      openTime: new Date('2026-04-14T04:30:00.000Z').getTime(),
    });

    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(closed, true, 'POSITION_CLOSED emitted on absolute P&L stop');
  });

  await test('T05 journal has TRADE_CLOSED entry with realisedPnl and reasoning:null', async () => {
    await new Promise(r => setTimeout(r, 100)); // let journal writes settle
    const entries = await journal.readToday();
    const closed  = entries.filter(e => e.eventType === 'TRADE_CLOSED');
    assert(closed.length >= 1, 'at least one TRADE_CLOSED in journal');
    assert(typeof closed[0].data.realisedPnl === 'number', 'realisedPnl is a number');
    assert.strictEqual(closed[0].data.reasoning, null, 'reasoning is null (RULES mode)');
  });

  // Cleanup
  if (fs.existsSync(tmpJournal)) fs.unlinkSync(tmpJournal);

  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
