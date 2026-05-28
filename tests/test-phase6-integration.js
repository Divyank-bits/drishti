/**
 * @file test-phase6-integration.js
 * @description Integration gates for Phase 6 equity directional scan pipeline.
 *              Tests: config/events present, module interfaces, event pipeline,
 *              journal wiring, Claude bypass verification in rules-only mode.
 */

'use strict';

const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const config   = require('../config');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n── Phase 6 Integration Tests ────────────────────────────────');

  // ── Gate 1: Config values present ────────────────────────────────────────
  console.log('\n  Gate 1 — Config');
  assert(Array.isArray(config.EQUITY_SCAN_SYMBOLS),              'G1.1: EQUITY_SCAN_SYMBOLS is array');
  assert(config.EQUITY_SCAN_SYMBOLS.length > 0,                  'G1.2: EQUITY_SCAN_SYMBOLS not empty');
  assert(Array.isArray(config.EQUITY_SCAN_CANDLE_TIMEFRAMES),    'G1.3: EQUITY_SCAN_CANDLE_TIMEFRAMES is array');
  assert(typeof config.EQUITY_SCAN_CONFLUENCE_THRESHOLD === 'number', 'G1.4: EQUITY_SCAN_CONFLUENCE_THRESHOLD is number');
  assert(typeof config.EQUITY_SCAN_FORMING_THRESHOLD === 'number',    'G1.5: EQUITY_SCAN_FORMING_THRESHOLD is number');
  assert(config.EQUITY_SCAN_CONFLUENCE_THRESHOLD > config.EQUITY_SCAN_FORMING_THRESHOLD, 'G1.6: CONFIRMED threshold > FORMING threshold');

  // ── Gate 2: Event constants present ──────────────────────────────────────
  console.log('\n  Gate 2 — Event constants');
  assert(typeof EVENTS.EQUITY_SCAN_STARTED      === 'string', 'G2.1: EQUITY_SCAN_STARTED defined');
  assert(typeof EVENTS.EQUITY_SCAN_RESULT       === 'string', 'G2.2: EQUITY_SCAN_RESULT defined');
  assert(typeof EVENTS.EQUITY_PATTERN_FORMING   === 'string', 'G2.3: EQUITY_PATTERN_FORMING defined');
  assert(typeof EVENTS.EQUITY_PATTERN_CONFIRMED === 'string', 'G2.4: EQUITY_PATTERN_CONFIRMED defined');

  // ── Gate 3: Base equity strategy loads ───────────────────────────────────
  console.log('\n  Gate 3 — Base class');
  const BaseEquityStrategy = require('../strategies/equity/base.equity-strategy');
  assert(typeof BaseEquityStrategy === 'function', 'G3.1: BaseEquityStrategy is a class');

  // ── Gate 4: Equity registry loads all 5 strategies ───────────────────────
  console.log('\n  Gate 4 — Equity registry');
  // Clear singleton so fresh load
  delete require.cache[require.resolve('../strategies/equity/registry')];
  const equityRegistry = require('../strategies/equity/registry');
  assert(equityRegistry.count === 5,                           'G4.1: 5 equity strategies registered');
  assert(typeof equityRegistry.getAll === 'function',          'G4.2: getAll() exists');
  assert(typeof equityRegistry.runAll === 'function',          'G4.3: runAll() exists');
  assert(typeof equityRegistry.getByDirection === 'function',  'G4.4: getByDirection() exists');
  assert(equityRegistry.getByDirection('BULLISH').length === 2,'G4.5: 2 BULLISH strategies');
  assert(equityRegistry.getByDirection('BEARISH').length === 2,'G4.6: 2 BEARISH strategies');
  assert(equityRegistry.getByDirection('NEUTRAL').length === 1,'G4.7: 1 NEUTRAL strategy');

  // ── Gate 5: Equity context module interface ───────────────────────────────
  console.log('\n  Gate 5 — Equity context');
  const equityContext = require('../data/equity-context');
  assert(typeof equityContext.getContext      === 'function', 'G5.1: getContext() exists');
  assert(typeof equityContext.recordTick      === 'function', 'G5.2: recordTick() exists');
  assert(typeof equityContext.setDayOpen      === 'function', 'G5.3: setDayOpen() exists');
  assert(typeof equityContext.getVwap         === 'function', 'G5.4: getVwap() exists');
  assert(typeof equityContext.resetDailyState === 'function', 'G5.5: resetDailyState() exists');

  // ── Gate 6: VWAP computation correctness ─────────────────────────────────
  console.log('\n  Gate 6 — VWAP');
  equityContext.resetDailyState();
  equityContext.setDayOpen('TESTSTOCK', 500);
  equityContext.recordTick('TESTSTOCK', { price: 502, volume: 1000 });
  equityContext.recordTick('TESTSTOCK', { price: 504, volume: 2000 });
  const vwap = equityContext.getVwap('TESTSTOCK');
  const expectedVwap = (502 * 1000 + 504 * 2000) / 3000;
  assert(Math.abs(vwap - expectedVwap) < 0.01, 'G6.1: VWAP computed correctly from ticks');
  equityContext.resetDailyState();
  assert(equityContext.getVwap('TESTSTOCK') === null, 'G6.2: VWAP resets to null after resetDailyState()');

  // ── Gate 7: Confluence scorer interface ──────────────────────────────────
  console.log('\n  Gate 7 — Confluence scorer');
  const { score } = require('../intelligence/confluence-scorer');
  assert(typeof score === 'function', 'G7.1: score() function exported');
  const r = score({ 15: [], 5: [], 1: [] });
  assert(typeof r.score            === 'number', 'G7.2: score() returns .score number');
  assert(typeof r.state            === 'string', 'G7.3: score() returns .state string');
  assert(typeof r.timeframeScores  === 'object', 'G7.4: score() returns .timeframeScores object');

  // ── Gate 8: Equity scanner interface ─────────────────────────────────────
  console.log('\n  Gate 8 — Equity scanner');
  const equityScanner = require('../intelligence/equity-scanner');
  assert(typeof equityScanner.scan === 'function', 'G8.1: equityScanner.scan() exists');

  // ── Gate 9: Event pipeline (rules mode, no Claude) ───────────────────────
  console.log('\n  Gate 9 — Event pipeline (mocked scan)');
  const events = [];
  const collect = (name) => (p) => events.push({ name, payload: p });
  const onStarted   = collect('EQUITY_SCAN_STARTED');
  const onResult    = collect('EQUITY_SCAN_RESULT');
  const onForming   = collect('EQUITY_PATTERN_FORMING');
  const onConfirmed = collect('EQUITY_PATTERN_CONFIRMED');

  eventBus.on(EVENTS.EQUITY_SCAN_STARTED,      onStarted);
  eventBus.on(EVENTS.EQUITY_SCAN_RESULT,       onResult);
  eventBus.on(EVENTS.EQUITY_PATTERN_FORMING,   onForming);
  eventBus.on(EVENTS.EQUITY_PATTERN_CONFIRMED, onConfirmed);

  // Emit events manually to test listeners (scanner itself requires live data)
  const testPayload = {
    symbol:     'RELIANCE',
    mode:       'rules',
    confluence: { score: 70, state: 'CONFIRMED', timeframeScores: { 1: 65, 5: 68, 15: 72 }, dominantPattern: 'Bull Flag', dominantDirection: 'BULLISH' },
    context:    { prevDayHigh: 2900, prevDayLow: 2800, prevDayClose: 2845, vwap: 2855, dayOpen: 2848 },
    strategyResults: [],
    timestamp:  new Date().toISOString(),
  };

  eventBus.emit(EVENTS.EQUITY_SCAN_STARTED,      { symbol: 'RELIANCE', mode: 'rules' });
  eventBus.emit(EVENTS.EQUITY_SCAN_RESULT,        testPayload);
  eventBus.emit(EVENTS.EQUITY_PATTERN_CONFIRMED,  testPayload);

  await new Promise(r => setTimeout(r, 20));

  eventBus.removeListener(EVENTS.EQUITY_SCAN_STARTED,      onStarted);
  eventBus.removeListener(EVENTS.EQUITY_SCAN_RESULT,       onResult);
  eventBus.removeListener(EVENTS.EQUITY_PATTERN_FORMING,   onForming);
  eventBus.removeListener(EVENTS.EQUITY_PATTERN_CONFIRMED, onConfirmed);

  assert(events.filter(e => e.name === 'EQUITY_SCAN_STARTED').length >= 1,   'G9.1: EQUITY_SCAN_STARTED received');
  assert(events.filter(e => e.name === 'EQUITY_SCAN_RESULT').length >= 1,    'G9.2: EQUITY_SCAN_RESULT received');
  assert(events.filter(e => e.name === 'EQUITY_PATTERN_CONFIRMED').length >= 1,'G9.3: EQUITY_PATTERN_CONFIRMED received');

  // ── Gate 10: Journal hookEquityScanEvents method exists ──────────────────
  console.log('\n  Gate 10 — Journal');
  const journal = require('../journal/trade-journal');
  assert(typeof journal.hookEquityScanEvents === 'function', 'G10.1: journal.hookEquityScanEvents() exists');

  // ── Gate 11: Journal writes on equity events ──────────────────────────────
  {
    let writeCount = 0;
    const origWrite = journal.write.bind(journal);
    journal.write = async (eventType, data) => { writeCount++; return origWrite(eventType, data); };
    journal.hookEquityScanEvents();

    eventBus.emit(EVENTS.EQUITY_SCAN_RESULT,       { symbol: 'TEST', mode: 'rules', confluence: { score: 50, state: 'FORMING' }, error: null });
    eventBus.emit(EVENTS.EQUITY_PATTERN_FORMING,   { symbol: 'TEST', confluence: { score: 50 }, context: {}, strategyResults: [] });
    eventBus.emit(EVENTS.EQUITY_PATTERN_CONFIRMED, { symbol: 'TEST', confluence: { score: 70 }, context: {}, strategyResults: [], claudeReasoning: null });

    await new Promise(r => setTimeout(r, 20));
    journal.write = origWrite;
    assert(writeCount >= 3, 'G11.1: Journal writes at least 3 entries for equity events');
  }

  // ── Gate 12: buildEquityScanPrompt exported ───────────────────────────────
  console.log('\n  Gate 12 — Prompt builder');
  const { buildEquityScanPrompt } = require('../intelligence/prompt-builder');
  assert(typeof buildEquityScanPrompt === 'function', 'G12.1: buildEquityScanPrompt exported');
  const prompt = buildEquityScanPrompt('RELIANCE', { 1: [], 5: [], 15: [] }, {}, testPayload.context, [], testPayload.confluence);
  assert(typeof prompt === 'string' && prompt.length > 0, 'G12.2: buildEquityScanPrompt returns non-empty string');
  assert(prompt.includes('RELIANCE'),    'G12.3: Prompt includes symbol name');
  assert(prompt.includes('VWAP'),        'G12.4: Prompt includes VWAP reference');
  assert(prompt.includes('patternDetected'), 'G12.5: Prompt includes JSON field name');

  // ── Gate 13: Rules mode — Claude client not called ────────────────────────
  console.log('\n  Gate 13 — Claude bypass in rules mode');
  {
    let claudeCalled = false;
    // Inject mock claude-client into cache
    require.cache[require.resolve('../intelligence/claude-client')] = {
      id: require.resolve('../intelligence/claude-client'),
      filename: require.resolve('../intelligence/claude-client'),
      loaded: true,
      exports: { call: async () => { claudeCalled = true; return '{}'; }, parseJSON: (r) => ({}) },
    };

    // Stub out data deps so scan() doesn't make real network calls
    require.cache[require.resolve('../data/historical')] = {
      id: require.resolve('../data/historical'),
      filename: require.resolve('../data/historical'),
      loaded: true,
      exports: { fetchForSymbol: async () => [] },
    };
    require.cache[require.resolve('../data/equity-context')] = {
      id: require.resolve('../data/equity-context'),
      filename: require.resolve('../data/equity-context'),
      loaded: true,
      exports: { getContext: async () => ({}) },
    };

    // Re-require equity-scanner to pick up stubs
    delete require.cache[require.resolve('../intelligence/equity-scanner')];
    const scanner = require('../intelligence/equity-scanner');

    await scanner.scan('RELIANCE', 'rules');
    assert(!claudeCalled, 'G13.1: Claude not called in rules-only mode');

    // Clean up stubs
    delete require.cache[require.resolve('../intelligence/claude-client')];
    delete require.cache[require.resolve('../data/historical')];
    delete require.cache[require.resolve('../data/equity-context')];
    delete require.cache[require.resolve('../intelligence/equity-scanner')];
  }

  // ── Gate 14: Equity registry runAll returns correct shape ─────────────────
  console.log('\n  Gate 14 — Registry runAll shape');
  {
    const candles = Array.from({ length: 20 }, (_, i) => ({
      open: 2848, high: 2860, low: 2840, close: 2850 + i * 0.5, volume: 4000, openTime: Date.now() - i * 60000,
    }));
    const indicators = { rsi: 52, ema9: 2855, ema21: 2848, macd: { MACD: 0.5 }, bb: { upper: 2870, lower: 2830, middle: 2850 }, avgVolume: 3800 };
    const ctx = { prevDayHigh: 2900, prevDayLow: 2800, prevDayClose: 2845, vwap: 2847, dayOpen: 2848 };

    delete require.cache[require.resolve('../strategies/equity/registry')];
    const reg = require('../strategies/equity/registry');
    const results = reg.runAll({ candles, indicators, context: ctx, timeframe: 15 });
    assert(Array.isArray(results), 'G14.1: runAll returns array');
    assert(results.length === 5,   'G14.2: runAll returns result for each of 5 strategies');
    const allValid = results.every(r =>
      r.strategy && r.result &&
      ['NONE','FORMING','CONFIRMED'].includes(r.result.state) &&
      typeof r.result.confidence === 'number'
    );
    assert(allValid, 'G14.3: All runAll results have valid state and confidence');
  }

  console.log(`\nPhase 6 Integration: ${passed} passed, ${failed} failed`);
}

runTests().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
}).finally(() => {
  if (failed > 0) process.exit(1);
});
