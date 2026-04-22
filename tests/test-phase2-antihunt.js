/**
 * @file test-phase2-antihunt.js
 * @description Phase 2 Gate 4 — Anti-hunt rule evaluation.
 *              Pure function tests — no event bus needed.
 */
'use strict';

const assert   = require('assert');
const antiHunt = require('../monitoring/anti-hunt');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n── Anti-Hunt Tests ──────────────────────────────────────────────\n');

function makePosition(overrides = {}) {
  return { orderId: 'test-order', strikes: { shortCe: 24400, longCe: 24600, shortPe: 24000, longPe: 23800 },
    entryPremium: 600, currentPnl: -200, ceDelta: 0.20, peDelta: -0.20, avgVolume: 1000, ...overrides };
}
function makeCandle(overrides = {}) {
  return { close: 24350, high: 24380, low: 24320, volume: 800,
    openTime: new Date('2026-04-14T04:30:00.000Z').getTime(), ...overrides }; // 10:00 IST
}
function makeContext(overrides = {}) { return { dayOpen: 24185, ...overrides }; }

// ── Rule 6: Absolute P&L stop ─────────────────────────────────────────────
test('T01 Rule 6: loss > 50% of MAX_DAILY_LOSS → shouldExit true', () => {
  const result = antiHunt.evaluate(makePosition({ currentPnl: -2600 }), makeCandle(), makeContext());
  assert.strictEqual(result.shouldExit, true);
  assert.strictEqual(result.rule, 6);
});

test('T02 Rule 6: loss = -2499 (below threshold) → does not trigger', () => {
  const result = antiHunt.evaluate(makePosition({ currentPnl: -2499 }), makeCandle(), makeContext());
  assert.notStrictEqual(result.rule, 6);
});

// ── Rule 4: Dangerous windows ─────────────────────────────────────────────
test('T03 Rule 4: dangerous window 09:20 IST → shouldExit false even if price breached', () => {
  // 09:20 IST = 03:50 UTC
  const candle = makeCandle({ close: 24480, openTime: new Date('2026-04-14T03:50:00.000Z').getTime(), volume: 2000 });
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false);
});

test('T04 Rule 4: dangerous window 11:35 IST + 60pt breach → no exit', () => {
  // 11:35 IST = 06:05 UTC
  const candle = makeCandle({ close: 24460, openTime: new Date('2026-04-14T06:05:00.000Z').getTime(), volume: 2000 });
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false, 'Rule 4 must block exit even with price breach');
});

test('T05 Rule 6 still exits inside dangerous window', () => {
  // 09:20 IST = 03:50 UTC
  const candle = makeCandle({ openTime: new Date('2026-04-14T03:50:00.000Z').getTime() });
  const result = antiHunt.evaluate(makePosition({ currentPnl: -2600 }), candle, makeContext());
  assert.strictEqual(result.shouldExit, true);
  assert.strictEqual(result.rule, 6, 'Only Rule 6 exits during dangerous window');
});

// ── Rules 1+2: Price close vs touch + buffer ──────────────────────────────
test('T06 Rule 1+2: price only touches strike (high > shortCe but close < buffer) → no exit', () => {
  const candle = makeCandle({ high: 24420, close: 24380 }); // touched but closed below buffer
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false);
});

test('T07 Rule 2: close 30pt beyond shortCe (< 50pt buffer) → no exit', () => {
  const candle = makeCandle({ close: 24430 }); // 30pt beyond 24400
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false);
});

test('T08 Rule 2+3: close 60pt beyond shortCe + high volume → exit', () => {
  const candle = makeCandle({ close: 24460, volume: 2000 }); // 60pt beyond, 2× avg
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, true);
});

// ── Rule 3: Volume confirmation ───────────────────────────────────────────
test('T09 Rule 3: volume = 0 (NSE source) → skip rule, treat as no-exit', () => {
  const candle = makeCandle({ close: 24460, volume: 0 });
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false, 'volume=0 should skip Rule 3 → no exit');
});

test('T10 Rule 3: volume below 1.5× average → likely hunt, no exit', () => {
  const candle = makeCandle({ close: 24460, volume: 400 }); // 400 < 1500 (1.5 × 1000)
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false);
});

// ── Rule 5: Delta monitoring ──────────────────────────────────────────────
test('T11 Rule 5: CE delta > 0.35 → flagged:true, shouldExit:false', () => {
  const result = antiHunt.evaluate(makePosition({ ceDelta: 0.40 }), makeCandle(), makeContext());
  assert.strictEqual(result.shouldExit, false);
  assert.strictEqual(result.flagged, true);
  assert.strictEqual(result.rule, 5);
});

test('T12 Rule 5: PE delta < -0.35 → flagged:true, shouldExit:false', () => {
  const result = antiHunt.evaluate(makePosition({ peDelta: -0.40 }), makeCandle(), makeContext());
  assert.strictEqual(result.shouldExit, false);
  assert.strictEqual(result.flagged, true);
});

test('T13 normal position within all thresholds → shouldExit false, flagged false', () => {
  const result = antiHunt.evaluate(makePosition(), makeCandle(), makeContext());
  assert.strictEqual(result.shouldExit, false);
  assert.strictEqual(result.flagged, false);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
