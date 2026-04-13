'use strict';

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// Wipe a module from require cache so each test starts with a fresh instance.
// Also removes all eventBus listeners to prevent cross-test interference.
function resetModules(...paths) {
  const eventBus = require('./core/event-bus');
  eventBus.removeAllListeners();
  paths.forEach((p) => {
    const resolved = require.resolve(p);
    delete require.cache[resolved];
  });
}

// ── All tests run inside this async IIFE (top-level await not valid in CommonJS) ──
(async () => {

// ── T16: correct OHLCV from tick sequence ─────────────────────────────────────
await test('T16 CandleBuilder: tick sequence → correct 1m OHLCV', async () => {
  resetModules('./data/candle-builder');
  const cb = require('./data/candle-builder');
  const eventBus = require('./core/event-bus');
  const EVENTS = require('./core/events');

  const received = [];
  eventBus.on(EVENTS.CANDLE_CLOSE_1M, (c) => received.push(c));

  // All ticks inside the same UTC minute (09:15 IST = 03:45 UTC on 2025-04-13)
  const base = new Date('2025-04-13T03:45:00.000Z').getTime();
  cb._onTick({ ltp: 24100, volume: 100, timestamp: base });
  cb._onTick({ ltp: 24150, volume: 200, timestamp: base + 20000 });
  cb._onTick({ ltp: 24080, volume: 150, timestamp: base + 40000 });

  // Tick in next minute → closes the candle above
  cb._onTick({ ltp: 24200, volume: 50, timestamp: base + 60000 });

  assert(received.length === 1, `Expected 1 close, got ${received.length}`);
  const c = received[0];
  assert(c.open   === 24100, `open:   expected 24100, got ${c.open}`);
  assert(c.high   === 24150, `high:   expected 24150, got ${c.high}`);
  assert(c.low    === 24080, `low:    expected 24080, got ${c.low}`);
  assert(c.close  === 24080, `close:  expected 24080, got ${c.close}`);
  assert(c.volume === 450,   `volume: expected 450,   got ${c.volume}`);
});

// ── T17: event fires at minute boundary ───────────────────────────────────────
await test('T17 CandleBuilder: CANDLE_CLOSE_1M fires at each minute boundary', async () => {
  resetModules('./data/candle-builder');
  const cb = require('./data/candle-builder');
  const eventBus = require('./core/event-bus');
  const EVENTS = require('./core/events');

  let count = 0;
  eventBus.on(EVENTS.CANDLE_CLOSE_1M, () => count++);

  const base = new Date('2025-04-13T03:45:00.000Z').getTime();
  const min  = 60000;
  cb._onTick({ ltp: 24100, volume: 100, timestamp: base });           // opens candle
  cb._onTick({ ltp: 24110, volume: 100, timestamp: base + min });     // closes candle 0
  cb._onTick({ ltp: 24120, volume: 100, timestamp: base + 2 * min }); // closes candle 1

  assert(count === 2, `Expected 2 closes, got ${count}`);
});

// ── T18: 5m and 15m boundaries ────────────────────────────────────────────────
await test('T18 CandleBuilder: 5m and 15m candle boundaries align correctly', async () => {
  resetModules('./data/candle-builder');
  const cb = require('./data/candle-builder');
  const eventBus = require('./core/event-bus');
  const EVENTS = require('./core/events');

  let c5 = 0, c15 = 0;
  eventBus.on(EVENTS.CANDLE_CLOSE_5M,  () => c5++);
  eventBus.on(EVENTS.CANDLE_CLOSE_15M, () => c15++);

  // 09:15 IST = 03:45 UTC (aligns to 5m and 15m UTC boundaries)
  const base = new Date('2025-04-13T03:45:00.000Z').getTime();
  const min  = 60000;

  cb._onTick({ ltp: 24100, volume: 100, timestamp: base });              // 09:15 — open
  cb._onTick({ ltp: 24110, volume: 100, timestamp: base +  5 * min });   // 09:20 — closes 5m
  cb._onTick({ ltp: 24120, volume: 100, timestamp: base + 10 * min });   // 09:25 — closes 5m
  cb._onTick({ ltp: 24130, volume: 100, timestamp: base + 15 * min });   // 09:30 — closes 5m + 15m

  assert(c5  === 3, `Expected 3 5m closes, got ${c5}`);
  assert(c15 === 1, `Expected 1 15m close, got ${c15}`);
});

// ── T19: buffer capped at CANDLE_HISTORY_SIZE ─────────────────────────────────
await test('T19 CandleBuilder: buffer capped at 200, oldest entry dropped', async () => {
  resetModules('./data/candle-builder');
  const cb = require('./data/candle-builder');

  const candles = Array.from({ length: 205 }, (_, i) => ({
    open: 24000 + i, high: 24010 + i, low: 23990 + i,
    close: 24000 + i, volume: 1000,
    openTime: Date.now() + i * 60000,
  }));
  cb.seedBuffer(1, candles);

  const buf = cb.getBuffer(1);
  assert(buf.length === 200, `Expected 200, got ${buf.length}`);
  // Oldest 5 dropped → first surviving entry is index 5 (open = 24005)
  assert(buf[0].open   === 24005, `Expected oldest open 24005, got ${buf[0].open}`);
  assert(buf[199].open === 24204, `Expected newest open 24204, got ${buf[199].open}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

})(); // end async IIFE
