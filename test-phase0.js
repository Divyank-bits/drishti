/**
 * @file test-phase0.js
 * @description Phase 0 test suite. Validates the architectural skeleton without
 *              any external API calls or network connections.
 *
 *              Run: node test-phase0.js
 *
 *              Tests:
 *                T01 — EventBus: emit 5 events and confirm receipt
 *                T02 — EventBus: off() removes listener correctly
 *                T03 — StateMachine: all valid transitions succeed
 *                T04 — StateMachine: invalid transition throws error
 *                T05 — StateMachine: FORCE_EXIT from eligible states
 *                T06 — StateMachine: FORCE_EXIT from IDLE throws
 *                T07 — CircuitBreaker: each of 7 breakers trips correctly
 *                T08 — CircuitBreaker: isTripped() true after any trip
 *                T09 — CircuitBreaker: reset() clears individual breaker
 *                T10 — CircuitBreaker: resetAll() clears everything
 *                T11 — SessionContext: update() and snapshot()
 *                T12 — SessionContext: recordTrade() P&L tracking
 *                T13 — SessionContext: updateRegime() change counter
 *                T14 — StrategyRegistry: loads without error (0 strategies in Phase 0)
 *                T15 — Config: all required keys present
 */

'use strict';

// Suppress event bus debug output during tests
process.env.NODE_ENV = 'test';

// ── Test runner ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ PASS  ${name}`);
    passed++;
    results.push({ name, status: 'PASS' });
  } catch (err) {
    console.log(`  ✗ FAIL  ${name}`);
    console.log(`         └─ ${err.message}`);
    failed++;
    results.push({ name, status: 'FAIL', error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertThrows(fn, expectedMessage) {
  try {
    fn();
    throw new Error('Expected function to throw but it did not');
  } catch (err) {
    if (err.message === 'Expected function to throw but it did not') throw err;
    if (expectedMessage && !err.message.includes(expectedMessage)) {
      throw new Error(
        `Expected error containing "${expectedMessage}", got: "${err.message}"`
      );
    }
  }
}

// ── Imports ─────────────────────────────────────────────────────────────────
const eventBus       = require('./core/event-bus');
const EVENTS         = require('./core/events');
const PositionStateMachine = require('./core/state-machine');
const CircuitBreaker = require('./core/circuit-breaker');
const SessionContext = require('./core/session-context');
const config         = require('./config');

// ── T01–T02: EventBus ───────────────────────────────────────────────────────
console.log('\n── EventBus ─────────────────────────────────────────────────');

test('T01 — EventBus: emit 5 events and confirm receipt', () => {
  const received = [];
  const events = [
    EVENTS.SYSTEM_READY,
    EVENTS.TICK_RECEIVED,
    EVENTS.CANDLE_CLOSE_5M,
    EVENTS.CIRCUIT_BREAKER_HIT,
    EVENTS.STATE_TRANSITION,
  ];

  const handler = (name) => (data) => received.push({ name, data });
  const handlers = {};

  for (const ev of events) {
    handlers[ev] = handler(ev);
    eventBus.on(ev, handlers[ev]);
  }

  // Emit all 5
  eventBus.emit(EVENTS.SYSTEM_READY,       { test: true });
  eventBus.emit(EVENTS.TICK_RECEIVED,      { price: 24000 });
  eventBus.emit(EVENTS.CANDLE_CLOSE_5M,    { open: 24000, close: 24050 });
  eventBus.emit(EVENTS.CIRCUIT_BREAKER_HIT,{ breakerName: 'test' });
  eventBus.emit(EVENTS.STATE_TRANSITION,   { from: 'IDLE', to: 'SIGNAL_DETECTED' });

  // Clean up
  for (const ev of events) eventBus.off(ev, handlers[ev]);

  assert(received.length === 5, `Expected 5 events received, got ${received.length}`);
  assert(received[0].name === EVENTS.SYSTEM_READY, 'First event should be SYSTEM_READY');
  assert(received[4].name === EVENTS.STATE_TRANSITION, 'Last event should be STATE_TRANSITION');
});

test('T02 — EventBus: off() removes listener', () => {
  let callCount = 0;
  const handler = () => callCount++;

  eventBus.on(EVENTS.DAILY_SUMMARY, handler);
  eventBus.emit(EVENTS.DAILY_SUMMARY, {});
  assert(callCount === 1, 'Handler should fire once');

  eventBus.off(EVENTS.DAILY_SUMMARY, handler);
  eventBus.emit(EVENTS.DAILY_SUMMARY, {});
  assert(callCount === 1, 'Handler should not fire after off()');
});

// ── T03–T06: StateMachine ───────────────────────────────────────────────────
console.log('\n── StateMachine ─────────────────────────────────────────────');

// Full valid path through all states
const VALID_PATH = [
  ['IDLE',              'SIGNAL_DETECTED'],
  ['SIGNAL_DETECTED',   'AWAITING_APPROVAL'],
  ['AWAITING_APPROVAL', 'ORDER_PLACING'],
  ['ORDER_PLACING',     'ACTIVE'],
  ['ACTIVE',            'FLAGGED'],
  ['FLAGGED',           'HUNT_SUSPECTED'],
  ['HUNT_SUSPECTED',    'EXITING'],
  ['EXITING',           'CLOSED'],
  ['CLOSED',            'IDLE'],
];

// Additional valid transitions not in the linear path
const EXTRA_VALID = [
  ['SIGNAL_DETECTED',   'IDLE'],           // signal discarded
  ['AWAITING_APPROVAL', 'IDLE'],           // user rejected
  ['ORDER_PLACING',     'PARTIALLY_FILLED'],
  ['PARTIALLY_FILLED',  'IDLE'],           // rollback done
  ['FLAGGED',           'ACTIVE'],         // delta recovered
  ['FLAGGED',           'EXITING'],        // direct exit from flagged
  ['HUNT_SUSPECTED',    'FLAGGED'],        // not a hunt, still flagged
  ['ORDER_PLACING',     'IDLE'],           // circuit breaker before any fill
];

test('T03 — StateMachine: all valid linear transitions succeed', () => {
  const sm = new PositionStateMachine();

  for (const [from, to] of VALID_PATH) {
    assert(sm.getCurrentState() === from, `Expected state ${from}, got ${sm.getCurrentState()}`);
    sm.transition(to);
    assert(sm.getCurrentState() === to, `Transition to ${to} failed`);
  }

  assert(sm.getCurrentState() === 'IDLE', 'Should end back at IDLE');
});

test('T03b — StateMachine: all extra valid transitions succeed', () => {
  for (const [from, to] of EXTRA_VALID) {
    const sm = new PositionStateMachine();
    sm._state = from; // directly set for test
    sm.transition(to);
    assert(sm.getCurrentState() === to, `${from} → ${to} failed`);
  }
});

test('T04 — StateMachine: invalid transitions throw errors', () => {
  const INVALID = [
    ['IDLE',    'ACTIVE'],
    ['IDLE',    'EXITING'],
    ['IDLE',    'CLOSED'],
    ['ACTIVE',  'IDLE'],
    ['ACTIVE',  'AWAITING_APPROVAL'],
    ['EXITING', 'ACTIVE'],
    ['CLOSED',  'ACTIVE'],
  ];

  for (const [from, to] of INVALID) {
    const sm = new PositionStateMachine();
    sm._state = from;
    assertThrows(
      () => sm.transition(to),
      `Invalid transition: ${from} → ${to}`
    );
  }
});

test('T05 — StateMachine: FORCE_EXIT from all eligible states', () => {
  const ELIGIBLE = ['ORDER_PLACING', 'PARTIALLY_FILLED', 'ACTIVE', 'FLAGGED', 'HUNT_SUSPECTED', 'EXITING'];

  for (const state of ELIGIBLE) {
    const sm = new PositionStateMachine();
    sm._state = state;
    assert(sm.canTransition('FORCE_EXIT'), `canTransition(FORCE_EXIT) should be true from ${state}`);
    sm.transition('FORCE_EXIT');
    assert(sm.getCurrentState() === 'FORCE_EXIT', `FORCE_EXIT failed from ${state}`);
  }
});

test('T06 — StateMachine: FORCE_EXIT from IDLE throws', () => {
  const sm = new PositionStateMachine();
  assert(sm.getCurrentState() === 'IDLE', 'Should start at IDLE');
  assert(!sm.canTransition('FORCE_EXIT'), 'canTransition(FORCE_EXIT) should be false from IDLE');
  assertThrows(() => sm.transition('FORCE_EXIT'));
});

// ── T07–T10: CircuitBreaker ─────────────────────────────────────────────────
console.log('\n── CircuitBreaker ───────────────────────────────────────────');

test('T07 — CircuitBreaker: all 7 breakers trip correctly', () => {
  const cb = new CircuitBreaker();

  assert(!cb.isTripped(), 'Should start un-tripped');

  // Breaker 1: daily loss
  cb.checkDailyLoss(-(config.MAX_DAILY_LOSS + 1));
  assert(cb.isBreaker('daily_loss'), 'daily_loss should be tripped');

  cb.resetAll();
  assert(!cb.isTripped(), 'Should be clear after resetAll');

  // Breaker 2: consecutive loss
  cb.checkConsecutiveLoss(config.CONSECUTIVE_LOSS_PAUSE);
  assert(cb.isBreaker('consecutive_loss'), 'consecutive_loss should be tripped');
  cb.resetAll();

  // Breaker 3: fill price deviation
  const result = cb.checkFillPrice(100, 107); // 7% deviation > 5% limit
  assert(!result, 'checkFillPrice should return false on bad fill');
  assert(cb.isBreaker('fill_price_deviation'), 'fill_price_deviation should be tripped');
  cb.resetAll();

  const okResult = cb.checkFillPrice(100, 103); // 3% OK
  assert(okResult, 'checkFillPrice should return true on acceptable fill');
  assert(!cb.isBreaker('fill_price_deviation'), 'fill_price_deviation should not trip on acceptable fill');

  // Breaker 4: websocket timeout
  cb.checkWebsocketTimeout(config.WEBSOCKET_RECONNECT_TIMEOUT, true);
  assert(cb.isBreaker('websocket_timeout'), 'websocket_timeout should be tripped');
  cb.resetAll();

  // Timeout below threshold should NOT trip
  cb.checkWebsocketTimeout(config.WEBSOCKET_RECONNECT_TIMEOUT - 1, true);
  assert(!cb.isBreaker('websocket_timeout'), 'Should not trip below timeout threshold');

  // No open position should NOT trip
  cb.checkWebsocketTimeout(config.WEBSOCKET_RECONNECT_TIMEOUT + 10, false);
  assert(!cb.isBreaker('websocket_timeout'), 'Should not trip without open position');
  cb.resetAll();

  // Breaker 5: claude API
  cb.tripClaudeApi('API timeout');
  assert(cb.isBreaker('claude_api'), 'claude_api should be tripped');
  cb.resetAll();

  // Breaker 6: absolute P&L stop
  cb.checkAbsolutePnlStop(config.ABSOLUTE_PNL_STOP_RUPEES + 1);
  assert(cb.isBreaker('absolute_pnl_stop'), 'absolute_pnl_stop should be tripped');
  cb.resetAll();

  // Below threshold should NOT trip
  cb.checkAbsolutePnlStop(config.ABSOLUTE_PNL_STOP_RUPEES - 1);
  assert(!cb.isBreaker('absolute_pnl_stop'), 'Should not trip below threshold');

  // Breaker 7: manual pause
  cb.toggleManualPause(true);
  assert(cb.isBreaker('manual_pause'), 'manual_pause should be tripped');
  cb.toggleManualPause(false); // resume
  assert(!cb.isBreaker('manual_pause'), 'manual_pause should clear on resume');
});

test('T08 — CircuitBreaker: isTripped() true when any breaker trips', () => {
  const cb = new CircuitBreaker();
  assert(!cb.isTripped(), 'Should start clean');

  cb.tripClaudeApi('test');
  assert(cb.isTripped(), 'isTripped() should be true after one trip');

  const tripped = cb.getTripped();
  assert(tripped.length === 1, `Expected 1 tripped breaker, got ${tripped.length}`);
  assert(tripped[0].name === 'claude_api', 'Tripped breaker should be claude_api');
});

test('T09 — CircuitBreaker: reset() clears individual breaker', () => {
  const cb = new CircuitBreaker();
  cb.tripClaudeApi('test');
  cb.checkConsecutiveLoss(config.CONSECUTIVE_LOSS_PAUSE);

  assert(cb.getTripped().length === 2, 'Should have 2 tripped breakers');

  cb.reset('claude_api');
  assert(!cb.isBreaker('claude_api'), 'claude_api should be clear');
  assert(cb.isBreaker('consecutive_loss'), 'consecutive_loss should still be tripped');
  assert(cb.isTripped(), 'isTripped() should still be true');
});

test('T10 — CircuitBreaker: resetAll() clears everything', () => {
  const cb = new CircuitBreaker();
  cb.tripClaudeApi('test');
  cb.checkDailyLoss(-(config.MAX_DAILY_LOSS + 1));
  cb.toggleManualPause(true);

  assert(cb.getTripped().length === 3, 'Should have 3 tripped');
  cb.resetAll();
  assert(!cb.isTripped(), 'isTripped() should be false after resetAll');
  assert(cb.getTripped().length === 0, 'No tripped breakers after resetAll');
});

// ── T11–T13: SessionContext ─────────────────────────────────────────────────
console.log('\n── SessionContext ────────────────────────────────────────────');

test('T11 — SessionContext: update() and snapshot()', () => {
  const ctx = new SessionContext();

  ctx.update({ dayOpen: 24000, vixAtOpen: 16.2 });
  const snap = ctx.snapshot();

  assert(snap.dayOpen === 24000, `dayOpen should be 24000, got ${snap.dayOpen}`);
  assert(snap.vixAtOpen === 16.2, `vixAtOpen should be 16.2, got ${snap.vixAtOpen}`);
  assert(snap.tradesToday === 0, 'tradesToday should start at 0');
  assert(snap.pnlToday === 0, 'pnlToday should start at 0');

  // snapshot is a copy — mutation should not affect internal state
  snap.tradesToday = 99;
  assert(ctx.tradesToday === 0, 'Internal state should not be affected by snapshot mutation');
});

test('T12 — SessionContext: recordTrade() P&L and streak tracking', () => {
  const ctx = new SessionContext();

  // Win
  ctx.recordTrade(500, 600);
  assert(ctx.tradesToday === 1, 'tradesToday should be 1');
  assert(ctx.pnlToday === 500, `pnlToday should be 500, got ${ctx.pnlToday}`);
  assert(ctx.consecutiveLosses === 0, 'No consecutive losses after win');

  // Loss
  ctx.recordTrade(-300, -250);
  assert(ctx.tradesToday === 2, 'tradesToday should be 2');
  assert(ctx.pnlToday === 200, `pnlToday should be 200, got ${ctx.pnlToday}`);
  assert(ctx.consecutiveLosses === 1, 'consecutiveLosses should be 1');

  // Another loss
  ctx.recordTrade(-200, -180);
  assert(ctx.consecutiveLosses === 2, 'consecutiveLosses should be 2');

  // Win resets streak
  ctx.recordTrade(100, 120);
  assert(ctx.consecutiveLosses === 0, 'Win should reset consecutiveLosses');

  const snap = ctx.snapshot();
  assert(snap.wins === 2, `Expected 2 wins, got ${snap.wins}`);
  assert(snap.losses === 2, `Expected 2 losses, got ${snap.losses}`);
});

test('T13 — SessionContext: updateRegime() tracks changes', () => {
  const ctx = new SessionContext();

  ctx.updateRegime('A');
  assert(ctx.currentRegime === 'A', 'Regime should be A');

  ctx.updateRegime('A');
  assert(ctx.snapshot().regimeChangesToday === 0, 'Same regime should not increment counter');

  ctx.updateRegime('B');
  assert(ctx.currentRegime === 'B', 'Regime should be B');
  assert(ctx.snapshot().regimeChangesToday === 1, 'Should count one regime change');

  ctx.updateRegime('C');
  assert(ctx.snapshot().regimeChangesToday === 2, 'Should count two regime changes');
  assert(ctx.snapshot().lastRegime === 'B', 'lastRegime should be B');
});

// ── T14: StrategyRegistry ───────────────────────────────────────────────────
console.log('\n── StrategyRegistry ─────────────────────────────────────────');

test('T14 — Registry: loads without error, 0 strategies in Phase 0', () => {
  const registry = require('./strategies/registry');
  assert(Array.isArray(registry.getAll()), 'getAll() should return an array');
  assert(registry.count === 0, `Expected 0 strategies in Phase 0, got ${registry.count}`);
  assert(registry.getByRegime('A').length === 0, 'getByRegime should return empty array');
  assert(registry.getBestForMarket({}, 'A') === null, 'getBestForMarket should return null');
});

// ── T15: Config ─────────────────────────────────────────────────────────────
console.log('\n── Config ───────────────────────────────────────────────────');

test('T15 — Config: all required fields present with correct types', () => {
  const REQUIRED_NUMBERS = [
    'MAX_DAILY_LOSS', 'MAX_TRADES_PER_DAY', 'CONSECUTIVE_LOSS_PAUSE',
    'ABSOLUTE_PNL_STOP_PCT', 'NIFTY_LOT_SIZE', 'DEFAULT_LOTS', 'MAX_LOTS',
    'TARGET_DTE_MIN', 'TARGET_DTE_MAX', 'VIX_SAFE_MAX', 'VIX_DANGER',
    'CONFIDENCE_THRESHOLD', 'MATCH_SCORE_THRESHOLD', 'DASHBOARD_PORT',
    'WEBSOCKET_RECONNECT_TIMEOUT', 'OPTIONS_CHAIN_INTERVAL',
  ];
  const REQUIRED_STRINGS = [
    'INTELLIGENCE_MODE', 'EXECUTION_MODE', 'MARKET_OPEN', 'MARKET_CLOSE',
    'NO_NEW_TRADES_AFTER', 'SQUARE_OFF_TIME', 'CLAUDE_MODEL',
  ];
  const REQUIRED_ARRAYS = ['CANDLE_TIMEFRAMES', 'TELEGRAM_AUTHORIZED_USER_IDS'];
  const REQUIRED_BOOLEANS = ['NO_ENTRY_ON_EXPIRY_DAY', 'IS_DEV'];

  for (const key of REQUIRED_NUMBERS) {
    assert(typeof config[key] === 'number', `config.${key} should be a number, got ${typeof config[key]}`);
  }
  for (const key of REQUIRED_STRINGS) {
    assert(typeof config[key] === 'string', `config.${key} should be a string`);
  }
  for (const key of REQUIRED_ARRAYS) {
    assert(Array.isArray(config[key]), `config.${key} should be an array`);
  }
  for (const key of REQUIRED_BOOLEANS) {
    assert(typeof config[key] === 'boolean', `config.${key} should be a boolean`);
  }

  // Validate intelligence mode is one of the allowed values
  assert(
    ['AI', 'RULES', 'HYBRID'].includes(config.INTELLIGENCE_MODE),
    `INTELLIGENCE_MODE must be AI|RULES|HYBRID, got "${config.INTELLIGENCE_MODE}"`
  );
  assert(
    ['PAPER', 'LIVE'].includes(config.EXECUTION_MODE),
    `EXECUTION_MODE must be PAPER|LIVE, got "${config.EXECUTION_MODE}"`
  );

  // Derived constants
  assert(
    config.ABSOLUTE_PNL_STOP_RUPEES === config.MAX_DAILY_LOSS * config.ABSOLUTE_PNL_STOP_PCT,
    'ABSOLUTE_PNL_STOP_RUPEES should equal MAX_DAILY_LOSS * ABSOLUTE_PNL_STOP_PCT'
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────
console.log('\n─────────────────────────────────────────────────────────────');
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log(`  Total  : ${passed + failed} tests`);

if (failed > 0) {
  console.log('\n  Failed tests:');
  results.filter((r) => r.status === 'FAIL').forEach((r) => {
    console.log(`    ✗ ${r.name}`);
    console.log(`      ${r.error}`);
  });
  console.log('');
  process.exit(1);
} else {
  console.log('\n  All Phase 0 tests passed. Ready to proceed to Phase 1.\n');
  process.exit(0);
}
