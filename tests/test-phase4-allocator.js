/**
 * @file test-phase4-allocator.js
 * @description Unit tests for strategy-allocator.js.
 *              Tests all 3 STRATEGY_SELECTION_MODE values, capital cap enforcement,
 *              concurrent position limit enforcement, and per-strategy circuit breaker
 *              isolation. No network calls, no live Dhan API.
 *
 * Run: node test-phase4-allocator.js
 */
'use strict';

require('dotenv').config();

let passed = 0;
let failed = 0;

function ok(label, bool, detail = '') {
  if (bool) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function section(title) {
  const line = '─'.repeat(Math.max(2, 54 - title.length));
  console.log(`\n── ${title} ${line}\n`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeCandidate(name, score, eligible = true) {
  return {
    strategy: { name },
    result:   { eligible, score, failedConditions: [] },
  };
}

function makeSessionCtx(overrides = {}) {
  return { tradesToday: 0, consecutiveLosses: 0, ...overrides };
}

// ── Patch config before loading allocator ─────────────────────────────────────
// We need to test all 3 modes without restarting the process, so we override
// config.STRATEGY_SELECTION_MODE dynamically before each allocate() call.

const config = require('../config');

// Ensure test strategies are in the capital map
config.STRATEGY_CAPITAL_PCT['iron-condor']      = 1.0;
config.STRATEGY_CAPITAL_PCT['bull-put-spread']  = 0.5;
config.STRATEGY_CAPITAL_PCT['bear-call-spread'] = 0.5;
config.STRATEGY_CAPITAL_PCT['straddle']         = 0.4;
config.MAX_CONCURRENT_POSITIONS = 2;
config.MAX_TRADES_PER_DAY = 3;

// Load allocator after config mutation
const allocator = require('../intelligence/strategy-allocator');

// ── Helper: reset allocator open position state between tests ─────────────────
// Allocator tracks positions via event bus listeners — for unit tests we reach
// into the internal map directly to simulate open/closed positions.

function resetAllocator() {
  allocator._openPositions.clear();
  allocator._totalOpen = 0;
}

// ── FIRST_MATCH mode ──────────────────────────────────────────────────────────

section('FIRST_MATCH — basic selection');

config.STRATEGY_SELECTION_MODE = 'FIRST_MATCH';
resetAllocator();

const fm1 = allocator.allocate(
  [makeCandidate('iron-condor', 90), makeCandidate('bull-put-spread', 85)],
  makeSessionCtx()
);
ok('returns 1 strategy', fm1.length === 1, `got ${fm1.length}`);
ok('selects first passing strategy (iron-condor)', fm1[0]?.strategy.name === 'iron-condor');

section('FIRST_MATCH — skips first if capital exhausted');

resetAllocator();
allocator._openPositions.set('iron-condor', 1);
allocator._totalOpen = 1;

const fm2 = allocator.allocate(
  [makeCandidate('iron-condor', 90), makeCandidate('bull-put-spread', 85)],
  makeSessionCtx()
);
ok('skips iron-condor (already open), picks bull-put-spread', fm2[0]?.strategy.name === 'bull-put-spread');

section('FIRST_MATCH — empty eligible list');

resetAllocator();
const fm3 = allocator.allocate([], makeSessionCtx());
ok('returns empty array when no eligible strategies', fm3.length === 0);

// ── BEST_SCORE mode ───────────────────────────────────────────────────────────

section('BEST_SCORE — selects highest scorer');

config.STRATEGY_SELECTION_MODE = 'BEST_SCORE';
resetAllocator();

// Eligible list already sorted desc by registry — allocator picks first capital-eligible
const bs1 = allocator.allocate(
  [makeCandidate('bull-put-spread', 92), makeCandidate('iron-condor', 88)],
  makeSessionCtx()
);
ok('returns 1 strategy', bs1.length === 1);
ok('selects highest scoring strategy (bull-put-spread)', bs1[0]?.strategy.name === 'bull-put-spread');

section('BEST_SCORE — skips highest if capital exhausted, picks next');

resetAllocator();
allocator._openPositions.set('bull-put-spread', 1);
allocator._totalOpen = 1;

const bs2 = allocator.allocate(
  [makeCandidate('bull-put-spread', 92), makeCandidate('iron-condor', 88)],
  makeSessionCtx()
);
ok('skips bull-put-spread (open), selects iron-condor', bs2[0]?.strategy.name === 'iron-condor');

// ── ALL_PASSING mode ──────────────────────────────────────────────────────────

section('ALL_PASSING — returns all up to MAX_CONCURRENT_POSITIONS');

config.STRATEGY_SELECTION_MODE = 'ALL_PASSING';
config.MAX_CONCURRENT_POSITIONS = 2;
resetAllocator();

const ap1 = allocator.allocate(
  [
    makeCandidate('iron-condor', 90),
    makeCandidate('bull-put-spread', 85),
    makeCandidate('bear-call-spread', 80),
  ],
  makeSessionCtx()
);
ok('returns 2 strategies (capped at MAX_CONCURRENT_POSITIONS)', ap1.length === 2, `got ${ap1.length}`);
ok('first is iron-condor (highest score)', ap1[0]?.strategy.name === 'iron-condor');
ok('second is bull-put-spread', ap1[1]?.strategy.name === 'bull-put-spread');

section('ALL_PASSING — respects MAX_TRADES_PER_DAY');

config.MAX_CONCURRENT_POSITIONS = 3;
resetAllocator();

const ap2 = allocator.allocate(
  [makeCandidate('iron-condor', 90), makeCandidate('bull-put-spread', 85)],
  makeSessionCtx({ tradesToday: 2 }) // 1 trade remaining (MAX=3)
);
ok('limits to 1 strategy when only 1 trade remaining', ap2.length === 1, `got ${ap2.length}`);

// ── Global cap enforcement ────────────────────────────────────────────────────

section('Global — MAX_CONCURRENT_POSITIONS blocks all when full');

config.STRATEGY_SELECTION_MODE = 'FIRST_MATCH';
config.MAX_CONCURRENT_POSITIONS = 2;
resetAllocator();
allocator._openPositions.set('iron-condor', 1);
allocator._openPositions.set('bull-put-spread', 1);
allocator._totalOpen = 2;

const gc1 = allocator.allocate(
  [makeCandidate('straddle', 95)],
  makeSessionCtx()
);
ok('blocks all when MAX_CONCURRENT_POSITIONS reached', gc1.length === 0);

section('Global — MAX_TRADES_PER_DAY blocks all when exhausted');

resetAllocator();
const gc2 = allocator.allocate(
  [makeCandidate('iron-condor', 90)],
  makeSessionCtx({ tradesToday: 3 }) // exhausted
);
ok('blocks all when MAX_TRADES_PER_DAY reached', gc2.length === 0);

// ── STRATEGY_CAPITAL_PCT = 0 blocks strategy ──────────────────────────────────

section('Capital — zero-allocation strategy is skipped');

config.STRATEGY_SELECTION_MODE = 'FIRST_MATCH';
config.STRATEGY_CAPITAL_PCT['straddle'] = 0;
resetAllocator();

const cap1 = allocator.allocate(
  [makeCandidate('straddle', 99), makeCandidate('iron-condor', 80)],
  makeSessionCtx()
);
ok('straddle (0% allocation) skipped, iron-condor selected', cap1[0]?.strategy.name === 'iron-condor');

// Restore straddle allocation
config.STRATEGY_CAPITAL_PCT['straddle'] = 0.4;

// ── Per-strategy circuit breaker isolation ────────────────────────────────────

section('Circuit Breaker — strategy breaker isolates one strategy');

const CircuitBreaker = require('../core/circuit-breaker');
const cb = new CircuitBreaker();

// Trip the bear-call-spread strategy breaker directly
cb.checkStrategyDailyLoss('bear-call-spread', 999999); // guaranteed to trip
ok('bear-call-spread strategy breaker is tripped', cb.isStrategyTripped('bear-call-spread'));
ok('iron-condor strategy breaker is NOT tripped', !cb.isStrategyTripped('iron-condor'));
ok('global isTripped() remains false', !cb.isTripped(), 'strategy breaker must not affect global');

section('Circuit Breaker — strategy cap calculation');

const cb2 = new CircuitBreaker();
// iron-condor: MAX_DAILY_LOSS(5000) * 1.0 = 5000
cb2.checkStrategyDailyLoss('iron-condor', 4999);
ok('iron-condor not tripped at ₹4999 loss', !cb2.isStrategyTripped('iron-condor'));

cb2.checkStrategyDailyLoss('iron-condor', 5000);
ok('iron-condor tripped at ₹5000 loss (cap = ₹5000)', cb2.isStrategyTripped('iron-condor'));

const cb3 = new CircuitBreaker();
// bull-put-spread: MAX_DAILY_LOSS(5000) * 0.5 = 2500
cb3.checkStrategyDailyLoss('bull-put-spread', 2499);
ok('bull-put-spread not tripped at ₹2499 loss', !cb3.isStrategyTripped('bull-put-spread'));

cb3.checkStrategyDailyLoss('bull-put-spread', 2500);
ok('bull-put-spread tripped at ₹2500 loss (cap = ₹2500)', cb3.isStrategyTripped('bull-put-spread'));

section('Circuit Breaker — resetStrategy clears only that strategy');

cb2.resetStrategy('iron-condor');
ok('iron-condor breaker cleared after resetStrategy()', !cb2.isStrategyTripped('iron-condor'));
ok('bear-call-spread on separate instance still tripped (isolation)', cb.isStrategyTripped('bear-call-spread'));

section('Circuit Breaker — resetAllStrategyBreakers');

const cb4 = new CircuitBreaker();
cb4.checkStrategyDailyLoss('iron-condor', 9999);
cb4.checkStrategyDailyLoss('straddle', 9999);
cb4.resetAllStrategyBreakers();
ok('iron-condor cleared after resetAllStrategyBreakers()', !cb4.isStrategyTripped('iron-condor'));
ok('straddle cleared after resetAllStrategyBreakers()', !cb4.isStrategyTripped('straddle'));

// ── Allocator helpers ─────────────────────────────────────────────────────────

section('Allocator — getOpenCount / getTotalOpen');

resetAllocator();
allocator._openPositions.set('iron-condor', 1);
allocator._totalOpen = 1;

ok('getOpenCount("iron-condor") = 1', allocator.getOpenCount('iron-condor') === 1);
ok('getOpenCount("straddle") = 0', allocator.getOpenCount('straddle') === 0);
ok('getTotalOpen() = 1', allocator.getTotalOpen() === 1);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(58)}`);
console.log(`  Phase 4 Allocator Tests: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(58)}\n`);

if (failed > 0) process.exit(1);
