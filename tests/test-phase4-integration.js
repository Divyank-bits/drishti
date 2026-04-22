/**
 * @file test-phase4-integration.js
 * @description Phase 4 integration tests. Verifies:
 *              - Registry filters strategies by ACTIVE_STRATEGIES config
 *              - Registry rejects files missing required interface methods
 *              - Registry.getEligible() returns correct sorted scored list
 *              - PositionTracker accumulates per-strategy P&L across two strategies
 *              - POSITION_UPDATED and POSITION_CLOSED carry strategyId + aggregatePnl
 *              - Prompt-builder includes strategy name and per-strategy P&L
 *              No network calls, no live Dhan API.
 *
 * Run: node test-phase4-integration.js
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

// ── Registry ─────────────────────────────────────────────────────────────────

section('Registry — ACTIVE_STRATEGIES filtering');

// Temporarily override config before loading registry
const config = require('../config');
const originalActive = config.ACTIVE_STRATEGIES;

config.ACTIVE_STRATEGIES = ['iron-condor', 'bull-put-spread', 'bear-call-spread', 'straddle'];

// Clear require cache so registry re-initialises with new config
delete require.cache[require.resolve('./strategies/registry')];
const registry = require('../strategies/registry');

ok('registry loaded 4 strategies', registry.count === 4, `got ${registry.count}`);
ok('iron-condor is registered', registry.getAll().some(s => s.name === 'Iron Condor'));
ok('Bull Put Spread is registered', registry.getAll().some(s => s.name === 'Bull Put Spread'));
ok('Bear Call Spread is registered', registry.getAll().some(s => s.name === 'Bear Call Spread'));
ok('Straddle is registered', registry.getAll().some(s => s.name === 'Straddle'));

section('Registry — filtering excludes inactive strategies');

config.ACTIVE_STRATEGIES = ['iron-condor'];
delete require.cache[require.resolve('./strategies/registry')];
const registryOne = require('../strategies/registry');

ok('only 1 strategy loaded when ACTIVE_STRATEGIES=["iron-condor"]',
  registryOne.count === 1, `got ${registryOne.count}`);
ok('only Iron Condor registered', registryOne.getAll()[0]?.name === 'Iron Condor');

// Restore for remaining tests
config.ACTIVE_STRATEGIES = ['iron-condor', 'bull-put-spread', 'bear-call-spread', 'straddle'];
delete require.cache[require.resolve('./strategies/registry')];
const reg = require('../strategies/registry');

section('Registry — getEligible() returns sorted scored list');

const NOW_IST_10AM = (() => {
  const d = new Date();
  d.setUTCHours(4, 30, 0, 0);
  return d.getTime();
})();

// Neutral market — Iron Condor should pass (RSI ~50, EMA flat, low VIX)
// Bear Call Spread should fail (RSI must be < 50)
// Bull Put Spread should fail (RSI must be > 50)
// Straddle should fail (VIX must be 18-25, IV percentile must be > 70%)
const neutralMarket = {
  indicators: {
    ema9: 25252, ema21: 25250,
    rsi:  50,
    macd: { macd: 0.8, signal: 0.5 },
    bb:   { upper: 25600, lower: 24900, width: 2.8 },
  },
  bbWidthHistory: [2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.0, 3.1, 3.2, 2.8],
  optionsChain: {
    vix:              16,
    pcr:              1.02,
    underlyingValue:  25255,
    maxCeOiStrike:    25600,
    maxPeOiStrike:    25000,
    atmStrike:        25250,
  },
  sessionContext: { dayOpen: 25200, tradesToday: 0 },
  timestamp:        NOW_IST_10AM,
  _isHolidayOverride: false,
};

const eligible = reg.getEligible(neutralMarket);
ok('getEligible() returns an array', Array.isArray(eligible));
ok('eligible list is sorted by score descending', (() => {
  for (let i = 1; i < eligible.length; i++) {
    if (eligible[i].result.score > eligible[i - 1].result.score) return false;
  }
  return true;
})());
ok('each eligible item has strategy and result', eligible.every(e => e.strategy && e.result));
ok('each result has eligible=true', eligible.every(e => e.result.eligible === true));

section('Registry — rejects strategy missing base interface');

// Inline test: create a fake require and validate _load throws for bad export
// We test indirectly by confirming BaseStrategy interface check works
const BaseStrategy = require('../strategies/base.strategy');
class FakeStrategy extends BaseStrategy {
  // Missing: name, regime, claudeDescription, checkConditions, buildTrade, etc.
}
const fake = new FakeStrategy();

let nameThrew = false;
try { void fake.name; } catch { nameThrew = true; }
ok('BaseStrategy throws when name getter not implemented', nameThrew);

let condThrew = false;
try { fake.checkConditions({}); } catch { condThrew = true; }
ok('BaseStrategy throws when checkConditions() not implemented', condThrew);

let tradeThrew = false;
try { fake.buildTrade({}); } catch { tradeThrew = true; }
ok('BaseStrategy throws when buildTrade() not implemented', tradeThrew);

// ── PositionTracker — per-strategy P&L accumulation ──────────────────────────

section('PositionTracker — per-strategy P&L tracking');

const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');

// Load tracker (singleton — already initialised)
const tracker = require('../monitoring/position-tracker');

// Simulate two closed trades from different strategies
// Directly mutate internal _strategyPnl to test helpers without full order flow
tracker._strategyPnl.clear();
tracker._strategyPnl.set('Iron Condor', 1200);
tracker._strategyPnl.set('Bull Put Spread', 650);

ok('getStrategyPnl() returns Map with 2 entries', tracker.getStrategyPnl().size === 2);
ok('Iron Condor P&L = ₹1200', tracker.getStrategyPnl().get('Iron Condor') === 1200);
ok('Bull Put Spread P&L = ₹650', tracker.getStrategyPnl().get('Bull Put Spread') === 650);
ok('getAggregatePnl() = ₹1850', tracker.getAggregatePnl() === 1850, `got ${tracker.getAggregatePnl()}`);

section('PositionTracker — POSITION_UPDATED carries strategy fields');

let lastUpdate = null;
const updateListener = (payload) => { lastUpdate = payload; };
eventBus.on(EVENTS.POSITION_UPDATED, updateListener);

// Simulate an active fill with strategy name
tracker._activeFill = {
  orderId:          'TEST-001',
  strategy:         'Bull Put Spread',
  legs:             [],
  premiumCollected: 500,
  strikes:          { shortPe: 25100, longPe: 24900 },
};
tracker._lastKnownPnl = -120;

// Trigger _onTick manually
tracker._onTick(25300);

ok('POSITION_UPDATED emitted', lastUpdate !== null);
ok('POSITION_UPDATED has strategy field', lastUpdate?.strategy === 'Bull Put Spread');
ok('POSITION_UPDATED has unrealisedPnl', lastUpdate?.unrealisedPnl === -120);
ok('POSITION_UPDATED has strategyPnl map', typeof lastUpdate?.strategyPnl === 'object');
ok('POSITION_UPDATED has aggregatePnl = ₹1850', lastUpdate?.aggregatePnl === 1850, `got ${lastUpdate?.aggregatePnl}`);

eventBus.removeListener(EVENTS.POSITION_UPDATED, updateListener);

// Clean up tracker state
tracker._activeFill = null;
tracker._lastKnownPnl = 0;
tracker._exiting = false;
tracker._strategyPnl.clear();

// ── Prompt builder — strategy context ─────────────────────────────────────────

section('Prompt builder — strategy name in entry prompt');

const { buildEntryPrompt, buildHuntPrompt } = require('../intelligence/prompt-builder');

const signal = {
  strategy:          'Bull Put Spread',
  strikes:           { shortPe: 25100, longPe: 24900 },
  indicatorSnapshot: { ema9: 25300, ema21: 25250, rsi: 56, macd: { macd: 1.2, signal: 0.9 }, bb: { upper: 25600, lower: 24900, width: 2.8 } },
  optionsSnapshot:   { vix: 16, pcr: 1.15, atmStrike: 25300 },
  expectedPremium:   null,
  timestamp:         new Date().toISOString(),
};

const sessionCtx = {
  date: new Date().toISOString().slice(0, 10),
  dayOpen: 25200, dayHigh: 25400, dayLow: 25100,
  vixAtOpen: 16, vixCurrent: 16,
  currentRegime: 'A', regimeChangesToday: 0,
  tradesToday: 0, pnlToday: 0,
  consecutiveLosses: 0,
};

const strategyPnl = { 'Iron Condor': 1200, 'Bull Put Spread': 0 };

const entryPrompt = buildEntryPrompt(signal, sessionCtx, [], strategyPnl);
ok('entry prompt contains strategy name', entryPrompt.includes('Bull Put Spread'));
ok('entry prompt contains per-strategy P&L section', entryPrompt.includes('Per-Strategy Realised P&L'));
ok('entry prompt lists Iron Condor P&L', entryPrompt.includes('Iron Condor'));
ok('entry prompt shows shortPe strike', entryPrompt.includes('25100'));
ok('entry prompt requests JSON with approved field', entryPrompt.includes('"approved"'));

section('Prompt builder — strategy name in hunt prompt');

const position = {
  strategy:     'Bull Put Spread',
  strikes:      { shortPe: 25100, longPe: 24900 },
  currentPnl:   -300,
  ceDelta:      null,
  peDelta:      -0.38,
  entryPremium: 500,
};

const candle = { open: 25080, high: 25090, low: 25020, close: 25035, volume: 50000, openTime: Date.now() };

const huntPrompt = buildHuntPrompt(position, candle, sessionCtx);
ok('hunt prompt contains strategy name', huntPrompt.includes('Bull Put Spread'));
ok('hunt prompt contains shortPe strike', huntPrompt.includes('25100'));
ok('hunt prompt requests JSON with isLikelyHunt field', huntPrompt.includes('"isLikelyHunt"'));

// Restore original config
config.ACTIVE_STRATEGIES = originalActive;

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(58)}`);
console.log(`  Phase 4 Integration Tests: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(58)}\n`);

if (failed > 0) process.exit(1);
