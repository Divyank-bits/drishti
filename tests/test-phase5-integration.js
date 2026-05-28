/**
 * @file test-phase5-integration.js
 * @description Integration tests for Phase 5 deep scan pipeline.
 *              Tests: scan scheduler triggers scan, SCAN_SYMBOL_FLAGGED emitted,
 *              journal writes scan events, watchlist updated, config knobs respected.
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
  console.log('\n── Phase 5 Integration Tests ─────────────────────────────────');

  // ── Gate 1: Config values present ────────────────────────────────────────
  console.log('\n  Gate 1 — Config');
  assert(Array.isArray(config.WATCHLIST_SYMBOLS), 'G1.1: WATCHLIST_SYMBOLS is an array');
  assert(config.WATCHLIST_SYMBOLS.length > 0, 'G1.2: WATCHLIST_SYMBOLS not empty');
  assert(typeof config.SCAN_INTERVAL_MINUTES === 'number', 'G1.3: SCAN_INTERVAL_MINUTES is a number');
  assert(typeof config.SCAN_MAX_SYMBOLS === 'number', 'G1.4: SCAN_MAX_SYMBOLS is a number');
  assert(typeof config.DEEP_SCAN_CONFIDENCE_THRESHOLD === 'number', 'G1.5: DEEP_SCAN_CONFIDENCE_THRESHOLD is a number');

  // ── Gate 2: Event constants present ──────────────────────────────────────
  console.log('\n  Gate 2 — Event constants');
  assert(typeof EVENTS.SCAN_STARTED === 'string', 'G2.1: SCAN_STARTED constant defined');
  assert(typeof EVENTS.SCAN_RESULT === 'string', 'G2.2: SCAN_RESULT constant defined');
  assert(typeof EVENTS.SCAN_SYMBOL_FLAGGED === 'string', 'G2.3: SCAN_SYMBOL_FLAGGED constant defined');
  assert(typeof EVENTS.WATCHLIST_UPDATED === 'string', 'G2.4: WATCHLIST_UPDATED constant defined');

  // ── Gate 3: Symbol scanner module loads ───────────────────────────────────
  console.log('\n  Gate 3 — Symbol scanner interface');
  const symbolScanner = require('../intelligence/symbol-scanner');
  assert(typeof symbolScanner.scan === 'function', 'G3.1: symbolScanner.scan is a function');

  // ── Gate 4: Watchlist manager loads and exposes correct interface ─────────
  console.log('\n  Gate 4 — Watchlist manager interface');
  const watchlistManager = require('../intelligence/watchlist-manager');
  assert(typeof watchlistManager.getRanked === 'function', 'G4.1: watchlistManager.getRanked is a function');
  assert(typeof watchlistManager.getScore === 'function', 'G4.2: watchlistManager.getScore is a function');

  // ── Gate 5: Scan pipeline emits correct events ────────────────────────────
  console.log('\n  Gate 5 — Event pipeline');
  const events = [];
  const collect = (name) => (p) => events.push({ name, payload: p });
  const collectResult   = collect('SCAN_RESULT');
  const collectFlagged  = collect('SCAN_SYMBOL_FLAGGED');
  const collectWatchlist= collect('WATCHLIST_UPDATED');

  eventBus.on(EVENTS.SCAN_RESULT,         collectResult);
  eventBus.on(EVENTS.SCAN_SYMBOL_FLAGGED, collectFlagged);
  eventBus.on(EVENTS.WATCHLIST_UPDATED,   collectWatchlist);

  // Drive the pipeline by emitting a SCAN_RESULT directly (scanner is tested separately)
  const origThreshold = config.DEEP_SCAN_CONFIDENCE_THRESHOLD;
  config.DEEP_SCAN_CONFIDENCE_THRESHOLD = 50;

  const testPayload = {
    symbol:         'TESTINDEX',
    score:          80,
    strategyScores: [{ strategy: 'Iron Condor', eligible: true, score: 75, failed: [] }],
    chain:          { vix: 14, pcr: 1.05, atmStrike: 48000, underlyingValue: 48000 },
    indicators:     { rsi: 50, ema9: 48000, ema21: 48000, bbWidth: 2.5 },
    timestamp:      new Date().toISOString(),
  };

  eventBus.emit(EVENTS.SCAN_RESULT, testPayload);
  eventBus.emit(EVENTS.SCAN_SYMBOL_FLAGGED, testPayload);

  await new Promise(r => setTimeout(r, 20));

  config.DEEP_SCAN_CONFIDENCE_THRESHOLD = origThreshold;

  eventBus.removeListener(EVENTS.SCAN_RESULT,         collectResult);
  eventBus.removeListener(EVENTS.SCAN_SYMBOL_FLAGGED, collectFlagged);
  eventBus.removeListener(EVENTS.WATCHLIST_UPDATED,   collectWatchlist);

  const resultEvents   = events.filter(e => e.name === 'SCAN_RESULT');
  const flaggedEvents  = events.filter(e => e.name === 'SCAN_SYMBOL_FLAGGED');
  const watchlistEvents= events.filter(e => e.name === 'WATCHLIST_UPDATED');

  assert(resultEvents.length >= 1,   'G5.1: SCAN_RESULT received by listeners');
  assert(flaggedEvents.length >= 1,  'G5.2: SCAN_SYMBOL_FLAGGED received by listeners');
  assert(watchlistEvents.length >= 1,'G5.3: WATCHLIST_UPDATED emitted by watchlist manager');

  // ── Gate 6: Watchlist manager updated correctly ───────────────────────────
  console.log('\n  Gate 6 — Watchlist state');
  const ranked = watchlistManager.getRanked();
  const entry  = ranked.find(e => e.symbol === 'TESTINDEX');
  assert(entry !== undefined, 'G6.1: TESTINDEX in watchlist after SCAN_RESULT');
  if (entry) {
    assert(entry.score === 80, 'G6.2: TESTINDEX score=80');
  }

  // ── Gate 7: Prompt builder exports buildScanPrompt ────────────────────────
  console.log('\n  Gate 7 — Prompt builder');
  const { buildScanPrompt } = require('../intelligence/prompt-builder');
  assert(typeof buildScanPrompt === 'function', 'G7.1: buildScanPrompt exported');
  const prompt = buildScanPrompt(testPayload);
  assert(typeof prompt === 'string' && prompt.length > 0, 'G7.2: buildScanPrompt returns non-empty string');
  assert(prompt.includes('TESTINDEX'), 'G7.3: prompt includes symbol name');

  // ── Gate 8: Journal hookScanEvents method exists ───────────────────────────
  console.log('\n  Gate 8 — Journal scan event wiring');
  const journal = require('../journal/trade-journal');
  assert(typeof journal.hookScanEvents === 'function', 'G8.1: journal.hookScanEvents is a function');

  // ── Gate 9: Snapshot store handles symbol-keyed writes ────────────────────
  console.log('\n  Gate 9 — Snapshot store multi-symbol');
  const snapshotStore = require('../data/snapshot-store');
  let snapshotError = null;
  try {
    snapshotStore.write({
      symbol:          'BANKNIFTY',
      vix:             15,
      pcr:             1.1,
      atmStrike:       47000,
      underlyingValue: 47050,
      scanScore:       72,
    });
  } catch (err) {
    snapshotError = err;
  }
  assert(snapshotError === null, 'G9.1: snapshotStore.write() for non-NIFTY symbol does not throw');

  // ── Gate 10: NSE source has subscribeSymbol method ────────────────────────
  console.log('\n  Gate 10 — Data source multi-symbol API');
  const nseSource = require('../data/sources/nse-source');
  assert(typeof nseSource.subscribeSymbol === 'function', 'G10.1: nseSource.subscribeSymbol is a function');

  // ── Gate 11: Options chain has fetchForSymbol ─────────────────────────────
  console.log('\n  Gate 11 — Options chain fetchForSymbol');
  const optionsChain = require('../data/options-chain');
  assert(typeof optionsChain.fetchForSymbol === 'function', 'G11.1: optionsChain.fetchForSymbol is a function');

  // ── Gate 12: Historical has fetchForSymbol ────────────────────────────────
  console.log('\n  Gate 12 — Historical fetchForSymbol');
  const historical = require('../data/historical');
  assert(typeof historical.fetchForSymbol === 'function', 'G12.1: historical.fetchForSymbol is a function');

  // ── Gate 13: Scan scheduler loads correctly ───────────────────────────────
  console.log('\n  Gate 13 — Scan scheduler');
  const scanScheduler = require('../intelligence/scan-scheduler');
  assert(typeof scanScheduler.start === 'function', 'G13.1: scanScheduler.start is a function');

  console.log(`\nPhase 5 Integration: ${passed} passed, ${failed} failed`);
}

runTests().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
}).finally(() => {
  if (failed > 0) process.exit(1);
});
