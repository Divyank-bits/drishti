/**
 * @file test-phase5-scanner.js
 * @description Unit tests for symbol-scanner.js
 *              Tests: scoring logic, correct events emitted, Claude bypass in RULES mode.
 */

'use strict';

// ── Minimal stubs ─────────────────────────────────────────────────────────────

// Stub options-chain and historical before requiring scanner
const mockChain = {
  symbol:          'BANKNIFTY',
  underlyingValue: 48000,
  atmStrike:       48000,
  vix:             14,
  pcr:             1.05,
  maxCeOiStrike:   48500,
  maxPeOiStrike:   47500,
  strikeData:      {},
  timestamp:       new Date().toISOString(),
};

const mockCandles = (() => {
  const candles = [];
  for (let i = 0; i < 30; i++) {
    const close = 48000 + Math.sin(i * 0.3) * 200;
    candles.push({ open: close - 10, high: close + 20, low: close - 20, close, volume: 1000, openTime: Date.now() - (30 - i) * 15 * 60 * 1000 });
  }
  return candles;
})();

// Override module cache before scanner is required
require.cache[require.resolve('../data/options-chain')] = {
  id: require.resolve('../data/options-chain'),
  filename: require.resolve('../data/options-chain'),
  loaded: true,
  exports: { fetchForSymbol: async () => ({ ...mockChain }) },
};

require.cache[require.resolve('../data/historical')] = {
  id: require.resolve('../data/historical'),
  filename: require.resolve('../data/historical'),
  loaded: true,
  exports: { fetchForSymbol: async () => [...mockCandles] },
};

// Stub registry with one minimal strategy
const stubStrategy = {
  name: 'Stub Strategy',
  checkConditions: (data) => ({ eligible: true, score: 75, failedConditions: [] }),
};
require.cache[require.resolve('../strategies/registry')] = {
  id: require.resolve('../strategies/registry'),
  filename: require.resolve('../strategies/registry'),
  loaded: true,
  exports: { getAll: () => [stubStrategy] },
};

const eventBus     = require('../core/event-bus');
const EVENTS       = require('../core/events');
const config       = require('../config');
const symbolScanner = require('../intelligence/symbol-scanner');

// ── Test harness ──────────────────────────────────────────────────────────────

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

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n── Symbol Scanner Tests ──────────────────────────────────────');

  // T1: scan() returns a result with symbol
  {
    const result = await symbolScanner.scan('BANKNIFTY');
    assert(result.symbol === 'BANKNIFTY', 'T1: result.symbol === BANKNIFTY');
    assert(typeof result.score === 'number', 'T2: result.score is a number');
    assert(result.score >= 0 && result.score <= 100, 'T3: score in range 0–100');
  }

  // T4: strategyScores includes stub strategy
  {
    const result = await symbolScanner.scan('BANKNIFTY');
    assert(Array.isArray(result.strategyScores), 'T4: strategyScores is an array');
    assert(result.strategyScores.length === 1, 'T5: one strategy scored');
    assert(result.strategyScores[0].strategy === 'Stub Strategy', 'T6: strategy name matches');
    assert(result.strategyScores[0].eligible === true, 'T7: stub strategy eligible=true');
  }

  // T8: SCAN_RESULT event is emitted
  {
    let received = null;
    eventBus.once(EVENTS.SCAN_RESULT, (p) => { received = p; });
    await symbolScanner.scan('BANKNIFTY');
    assert(received !== null, 'T8: SCAN_RESULT event emitted');
    assert(received.symbol === 'BANKNIFTY', 'T9: SCAN_RESULT carries correct symbol');
  }

  // T10: SCAN_SYMBOL_FLAGGED emitted when score >= threshold
  {
    const origThreshold = config.DEEP_SCAN_CONFIDENCE_THRESHOLD;
    config.DEEP_SCAN_CONFIDENCE_THRESHOLD = 0; // force flag
    let flagged = null;
    eventBus.once(EVENTS.SCAN_SYMBOL_FLAGGED, (p) => { flagged = p; });
    await symbolScanner.scan('BANKNIFTY');
    config.DEEP_SCAN_CONFIDENCE_THRESHOLD = origThreshold;
    assert(flagged !== null, 'T10: SCAN_SYMBOL_FLAGGED emitted when threshold=0');
  }

  // T11: SCAN_SYMBOL_FLAGGED NOT emitted when score < threshold
  {
    const origThreshold = config.DEEP_SCAN_CONFIDENCE_THRESHOLD;
    config.DEEP_SCAN_CONFIDENCE_THRESHOLD = 200; // impossible to reach
    let flagged = null;
    eventBus.once(EVENTS.SCAN_SYMBOL_FLAGGED, (p) => { flagged = p; });
    await symbolScanner.scan('BANKNIFTY');
    config.DEEP_SCAN_CONFIDENCE_THRESHOLD = origThreshold;
    assert(flagged === null, 'T11: SCAN_SYMBOL_FLAGGED NOT emitted when threshold unreachable');
  }

  // T12: scan result includes chain data
  {
    const result = await symbolScanner.scan('BANKNIFTY');
    assert(result.chain !== undefined, 'T12: result.chain present');
    assert(result.chain.pcr === mockChain.pcr, 'T13: chain.pcr matches mock');
  }

  // T14: scan result includes indicators
  {
    const result = await symbolScanner.scan('BANKNIFTY');
    assert(result.indicators !== undefined, 'T14: result.indicators present');
  }

  // T15: handles data fetch failure gracefully
  {
    const origFetch = require('../data/options-chain').fetchForSymbol;
    require('../data/options-chain').fetchForSymbol = async () => { throw new Error('network down'); };
    const result = await symbolScanner.scan('BANKNIFTY');
    require('../data/options-chain').fetchForSymbol = origFetch;
    assert(result.error !== undefined, 'T15: error field set on fetch failure');
    assert(result.score === 0, 'T16: score=0 on fetch failure');
  }

  // T17: checkConditions not called (RULES mode bypass is at strategy-selector level, not scanner)
  // Scanner always scores — it's a pure scoring function. This verifies the call happened.
  {
    let conditionsCalled = 0;
    const origCheck = stubStrategy.checkConditions;
    stubStrategy.checkConditions = (data) => { conditionsCalled++; return { eligible: true, score: 80, failedConditions: [] }; };
    await symbolScanner.scan('BANKNIFTY');
    stubStrategy.checkConditions = origCheck;
    assert(conditionsCalled === 1, 'T17: checkConditions called once per scan');
  }

  console.log(`\nSymbol Scanner: ${passed} passed, ${failed} failed`);
}

runTests().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
}).finally(() => {
  if (failed > 0) process.exit(1);
});
