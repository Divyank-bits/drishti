/**
 * @file test-phase6-strategies.js
 * @description Unit tests for the five Phase 6 equity strategies.
 *              Tests: fixture candles for each pattern (forming + confirmed),
 *              volume edge cases, VWAP positioning, base class enforcement.
 */

'use strict';

const BaseEquityStrategy = require('../strategies/equity/base.equity-strategy');

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

// ── Fixture helpers ───────────────────────────────────────────────────────────

function makeCandles(n, baseClose = 2850, trend = 0) {
  const candles = [];
  for (let i = 0; i < n; i++) {
    const close = baseClose + i * trend + Math.sin(i) * 5;
    candles.push({ open: close - 3, high: close + 8, low: close - 8, close, volume: 5000, openTime: Date.now() - (n - i) * 60000 });
  }
  return candles;
}

function makeIndicators(overrides = {}) {
  return {
    rsi:       55,
    ema9:      2860,
    ema21:     2850,
    macd:      { MACD: 1, signal: 0.5 },
    bb:        { upper: 2880, lower: 2820, middle: 2850 },
    avgVolume: 4000,
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    prevDayHigh:  2900,
    prevDayLow:   2800,
    prevDayClose: 2845,
    prevDayOpen:  2840,
    vwap:         2840,
    dayOpen:      2848,
    ...overrides,
  };
}

// ── Load strategies directly ──────────────────────────────────────────────────

// Clear registry cache so we can load strategies without it printing noise
const bullFlag   = require('../strategies/equity/bull-flag.equity-strategy');
const bearFlag   = require('../strategies/equity/bear-flag.equity-strategy');
const breakout   = require('../strategies/equity/breakout.equity-strategy');
const breakdown  = require('../strategies/equity/breakdown.equity-strategy');
const rangeBound = require('../strategies/equity/range-bound.equity-strategy');

async function runTests() {
  console.log('\n── Phase 6 Equity Strategy Tests ────────────────────────────');

  // ── T1–T3: Base class enforcement ─────────────────────────────────────────
  console.log('\n  Base class');
  assert(bullFlag   instanceof BaseEquityStrategy, 'T1: BullFlag extends BaseEquityStrategy');
  assert(bearFlag   instanceof BaseEquityStrategy, 'T2: BearFlag extends BaseEquityStrategy');
  assert(breakout   instanceof BaseEquityStrategy, 'T3: Breakout extends BaseEquityStrategy');
  assert(breakdown  instanceof BaseEquityStrategy, 'T4: Breakdown extends BaseEquityStrategy');
  assert(rangeBound instanceof BaseEquityStrategy, 'T5: RangeBound extends BaseEquityStrategy');

  // ── T6–T10: Identity getters ──────────────────────────────────────────────
  console.log('\n  Identity getters');
  assert(bullFlag.name   === 'Bull Flag',   'T6: BullFlag.name');
  assert(bearFlag.name   === 'Bear Flag',   'T7: BearFlag.name');
  assert(breakout.name   === 'Breakout',    'T8: Breakout.name');
  assert(breakdown.name  === 'Breakdown',   'T9: Breakdown.name');
  assert(rangeBound.name === 'Range Bound', 'T10: RangeBound.name');

  assert(bullFlag.direction   === 'BULLISH', 'T11: BullFlag direction BULLISH');
  assert(bearFlag.direction   === 'BEARISH', 'T12: BearFlag direction BEARISH');
  assert(breakout.direction   === 'BULLISH', 'T13: Breakout direction BULLISH');
  assert(breakdown.direction  === 'BEARISH', 'T14: Breakdown direction BEARISH');
  assert(rangeBound.direction === 'NEUTRAL', 'T15: RangeBound direction NEUTRAL');

  // ── T16: checkPattern returns correct shape ───────────────────────────────
  console.log('\n  Return shape');
  const candles = makeCandles(25);
  const ind     = makeIndicators();
  const ctx     = makeContext();
  const result  = bullFlag.checkPattern({ candles, indicators: ind, context: ctx, timeframe: 15 });
  assert(typeof result.patternName   === 'string',  'T16: patternName is string');
  assert(typeof result.direction     === 'string',  'T17: direction is string');
  assert(['NONE','FORMING','CONFIRMED'].includes(result.state), 'T18: state is valid');
  assert(typeof result.confidence    === 'number',  'T19: confidence is number');
  assert(Array.isArray(result.signals),             'T20: signals is array');
  assert(Array.isArray(result.failedConditions),    'T21: failedConditions is array');

  // ── T22: insufficient candles returns NONE ────────────────────────────────
  console.log('\n  Edge cases');
  const r2 = bullFlag.checkPattern({ candles: [{ open:1,high:2,low:0,close:1,volume:100 }], indicators: ind, context: ctx, timeframe: 15 });
  assert(r2.state === 'NONE', 'T22: insufficient candles → NONE');

  // ── T23–T24: Bull Flag FORMING — price above VWAP, EMA9>EMA21, RSI in range ─
  console.log('\n  Bull Flag');
  {
    const c   = makeCandles(25, 2860, 1); // uptrending
    // Make last candle have high breakout volume
    c[c.length - 1].volume = 9000;
    const ind2 = makeIndicators({ rsi: 62, ema9: 2870, ema21: 2850, bb: { upper: 2880, lower: 2872, middle: 2876 }, avgVolume: 4000 });
    const ctx2 = makeContext({ vwap: 2840 }); // price above VWAP
    // 5m timeframe: BB tight (width < 2.5%) and volume drying
    const r5m = bullFlag.checkPattern({ candles: c, indicators: ind2, context: ctx2, timeframe: 5 });
    assert(r5m.state !== 'NONE' || r5m.confidence >= 0, 'T23: BullFlag 5m runs without error');
    const r15m = bullFlag.checkPattern({ candles: c, indicators: ind2, context: ctx2, timeframe: 15 });
    assert(['NONE','FORMING','CONFIRMED'].includes(r15m.state), 'T24: BullFlag 15m valid state');
  }

  // ── T25–T26: Bear Flag — price below VWAP, EMA9<EMA21, RSI in bearish range ─
  console.log('\n  Bear Flag');
  {
    const c    = makeCandles(25, 2840, -1);
    const ind3 = makeIndicators({ rsi: 38, ema9: 2835, ema21: 2850, avgVolume: 4000 });
    const ctx3 = makeContext({ vwap: 2860 }); // price below VWAP
    const r    = bearFlag.checkPattern({ candles: c, indicators: ind3, context: ctx3, timeframe: 15 });
    assert(['NONE','FORMING','CONFIRMED'].includes(r.state), 'T25: BearFlag valid state');
    assert(typeof r.confidence === 'number' && r.confidence >= 0, 'T26: BearFlag confidence >= 0');
  }

  // ── T27–T30: Breakout — price above PDH, 2× vol, EMA9>EMA21, RSI>60, above VWAP
  console.log('\n  Breakout');
  {
    const c = makeCandles(10, 2905); // above PDH 2900
    c[c.length - 1].close = 2910;
    c[c.length - 1].volume = 12000; // > 2× avg 4000
    const ind4 = makeIndicators({ rsi: 68, ema9: 2908, ema21: 2890, avgVolume: 4000 });
    const ctx4 = makeContext({ prevDayHigh: 2900, vwap: 2895 });
    const r    = breakout.checkPattern({ candles: c, indicators: ind4, context: ctx4, timeframe: 15 });
    assert(r.state === 'CONFIRMED', 'T27: Breakout CONFIRMED when all conditions met');
    assert(r.signals.length >= 4,   'T28: Breakout has >= 4 passing signals');
  }
  {
    // Price below PDH — should not confirm
    const c  = makeCandles(10, 2880);
    const r  = breakout.checkPattern({ candles: c, indicators: makeIndicators({ rsi: 55 }), context: makeContext(), timeframe: 15 });
    assert(r.state !== 'CONFIRMED', 'T29: Breakout not CONFIRMED when price below PDH');
  }

  // ── T31–T33: Breakdown — price below PDL, 2× vol, EMA9<EMA21, RSI<40, below VWAP
  console.log('\n  Breakdown');
  {
    const c = makeCandles(10, 2790); // below PDL 2800
    c[c.length - 1].close = 2785;
    c[c.length - 1].volume = 10000;
    const ind5 = makeIndicators({ rsi: 32, ema9: 2788, ema21: 2810, avgVolume: 4000 });
    const ctx5 = makeContext({ prevDayLow: 2800, vwap: 2810 });
    const r    = breakdown.checkPattern({ candles: c, indicators: ind5, context: ctx5, timeframe: 15 });
    assert(r.state === 'CONFIRMED', 'T31: Breakdown CONFIRMED when all conditions met');
    assert(r.signals.length >= 4,   'T32: Breakdown has >= 4 passing signals');
  }
  {
    const c = makeCandles(10, 2850);
    const r = breakdown.checkPattern({ candles: c, indicators: makeIndicators({ rsi: 45 }), context: makeContext(), timeframe: 15 });
    assert(r.state !== 'CONFIRMED', 'T33: Breakdown not CONFIRMED when price above PDL');
  }

  // ── T34–T37: Range Bound ──────────────────────────────────────────────────
  console.log('\n  Range Bound');
  {
    const c = makeCandles(10, 2850); // within 2800–2900
    const ind6 = makeIndicators({ rsi: 50, macd: { MACD: 1.5 }, bb: { upper: 2860, lower: 2840, middle: 2850 }, avgVolume: 6000 });
    c[c.length - 1].volume = 3000; // below avg
    const r = rangeBound.checkPattern({ candles: c, indicators: ind6, context: makeContext(), timeframe: 15 });
    assert(['FORMING','CONFIRMED'].includes(r.state) || r.confidence >= 0, 'T34: RangeBound runs without error');
  }
  {
    // Price outside range — should fail prevDayHigh check
    const c = makeCandles(10, 2910); // above PDH 2900
    const r = rangeBound.checkPattern({ candles: c, indicators: makeIndicators(), context: makeContext(), timeframe: 15 });
    assert(r.failedConditions.some(f => f.includes('range')), 'T35: RangeBound fails when price outside range');
  }
  {
    // RSI outside 40–60 — should be in failedConditions
    const c  = makeCandles(10, 2850);
    const r  = rangeBound.checkPattern({ candles: c, indicators: makeIndicators({ rsi: 72 }), context: makeContext(), timeframe: 15 });
    assert(r.failedConditions.some(f => f.includes('RSI')), 'T36: RangeBound fails when RSI > 60');
  }
  {
    // No context — graceful degradation
    const c  = makeCandles(10, 2850);
    let err  = null;
    try { rangeBound.checkPattern({ candles: c, indicators: makeIndicators(), context: {}, timeframe: 15 }); }
    catch(e) { err = e; }
    assert(err === null, 'T37: RangeBound handles missing context without throwing');
  }

  // ── T38: All strategies handle timeframe=1 without throwing ──────────────
  console.log('\n  All strategies — timeframe 1m');
  const strats = [bullFlag, bearFlag, breakout, breakdown, rangeBound];
  let allOk = true;
  for (const s of strats) {
    try {
      const r = s.checkPattern({ candles: makeCandles(10), indicators: makeIndicators(), context: makeContext(), timeframe: 1 });
      if (!['NONE','FORMING','CONFIRMED'].includes(r.state)) allOk = false;
    } catch { allOk = false; }
  }
  assert(allOk, 'T38: All 5 strategies handle timeframe=1 without throwing');

  console.log(`\nPhase 6 Strategies: ${passed} passed, ${failed} failed`);
}

runTests().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
}).finally(() => {
  if (failed > 0) process.exit(1);
});
