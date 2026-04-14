/**
 * @file test-phase2-strategy.js
 * @description Phase 2 Gate 3 — Iron Condor entry conditions and strike selection.
 */
'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n── Iron Condor Strategy Tests ───────────────────────────────────\n');

const IronCondor = require('./strategies/iron-condor.strategy');

function passingSnapshot() {
  return {
    indicators: {
      rsi:   50,
      ema9:  24185,
      ema21: 24180,
      macd:  { macd: 0.5, signal: 0.3, histogram: 0.2 },
      bb:    { upper: 24700, middle: 24185, lower: 23670, width: 2.5 },
    },
    bbWidthHistory: [2.6, 2.55, 2.52, 2.5, 2.5],
    optionsChain: {
      underlyingValue: 24185,
      vix:             16.0,
      pcr:             1.05,
      maxCeOiStrike:   24500,
      maxPeOiStrike:   23900,
      atmStrike:       24200,
      strikeData: {
        24400: { ce: 80, pe: null },
        24600: { ce: 40, pe: null },
        23950: { ce: null, pe: 75 },
        23750: { ce: null, pe: 40 },
      },
    },
    sessionContext: {
      dayOpen:    24185,
      vixAtOpen:  16.0,
      vixCurrent: 16.0,
    },
    timestamp: new Date('2026-04-14T04:30:00.000Z').getTime(), // 10:00 IST
  };
}

test('T01 all 11 conditions pass → checkConditions returns eligible:true', () => {
  const result = IronCondor.checkConditions(passingSnapshot());
  assert.strictEqual(result.eligible, true, `eligible should be true, got: ${JSON.stringify(result.failedConditions)}`);
  assert.strictEqual(result.failedConditions.length, 0);
});

test('T02 strike selection: shortCe = maxCeOiStrike - 100', () => {
  const trade = IronCondor.buildTrade(passingSnapshot());
  const shortCe = trade.legs.find(l => l.type === 'CE' && l.action === 'SELL');
  assert.strictEqual(shortCe.strike, 24400);
});

test('T03 strike selection: shortPe exact hundred → shift +50 → 24050', () => {
  const trade = IronCondor.buildTrade(passingSnapshot());
  // maxPeOiStrike=23900, shortPe = 23900+100 = 24000, exact hundred → +50 → 24050
  const shortPe = trade.legs.find(l => l.type === 'PE' && l.action === 'SELL');
  assert.strictEqual(shortPe.strike, 24050, `Expected 24050, got ${shortPe.strike}`);
});

test('T04 strike selection: longCe = shortCe + 200', () => {
  const trade = IronCondor.buildTrade(passingSnapshot());
  const shortCe = trade.legs.find(l => l.type === 'CE' && l.action === 'SELL');
  const longCe  = trade.legs.find(l => l.type === 'CE' && l.action === 'BUY');
  assert.strictEqual(longCe.strike, shortCe.strike + 200);
});

test('T05 strike selection: longPe = shortPe - 200', () => {
  const trade = IronCondor.buildTrade(passingSnapshot());
  const shortPe = trade.legs.find(l => l.type === 'PE' && l.action === 'SELL');
  const longPe  = trade.legs.find(l => l.type === 'PE' && l.action === 'BUY');
  assert.strictEqual(longPe.strike, shortPe.strike - 200);
});

test('T06 near-miss: VIX = 23 (>22) → not eligible', () => {
  const snap = passingSnapshot();
  snap.optionsChain.vix = 23;
  snap.sessionContext.vixCurrent = 23;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('vix'));
});

test('T07 near-miss: BB width = 4.5% (>4) → not eligible', () => {
  const snap = passingSnapshot();
  snap.indicators.bb.width = 4.5;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('bbWidth'));
});

test('T08 near-miss: BB squeezing 5 consecutive candles → not eligible', () => {
  const snap = passingSnapshot();
  snap.bbWidthHistory = [3.0, 2.8, 2.6, 2.4, 2.2];
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('bbSqueeze'));
});

test('T09 near-miss: IV percentile proxy < 50 → not eligible', () => {
  const snap = passingSnapshot();
  snap.bbWidthHistory = [4.0, 3.8, 3.6, 3.4, 3.2]; // current (2.5) is at bottom = low percentile
  snap.indicators.bb.width = 2.5;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('ivPercentile'));
});

test('T10 near-miss: EMA spread = 0.3% (>0.2%) → not eligible', () => {
  const snap = passingSnapshot();
  snap.indicators.ema9  = 24185;
  snap.indicators.ema21 = 24112;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('emaSpread'));
});

test('T11 near-miss: RSI = 61 (>60) → not eligible', () => {
  const snap = passingSnapshot();
  snap.indicators.rsi = 61;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('rsi'));
});

test('T12 near-miss: MACD = 2.5 (>threshold 2.0) → not eligible', () => {
  const snap = passingSnapshot();
  snap.indicators.macd.macd = 2.5;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('macd'));
});

test('T13 near-miss: NIFTY 0.6% from day open → not eligible', () => {
  const snap = passingSnapshot();
  snap.sessionContext.dayOpen = 24040;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('niftyVsDayOpen'));
});

test('T14 near-miss: PCR = 1.3 (>1.2) → not eligible', () => {
  const snap = passingSnapshot();
  snap.optionsChain.pcr = 1.3;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('pcr'));
});

test('T15 near-miss: time = 14:15 IST (after window) → not eligible', () => {
  const snap = passingSnapshot();
  snap.timestamp = new Date('2026-04-14T08:45:00.000Z').getTime(); // 14:15 IST
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('timeWindow'));
});

test('T16 near-miss: holiday date → not eligible', () => {
  const snap = passingSnapshot();
  snap._isHolidayOverride = true;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('eventDay'));
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
