/**
 * @file test-phase4-strategies.js
 * @description Unit tests for Phase 4 strategies: Bull Put Spread, Bear Call Spread, Straddle.
 *              Tests entry condition logic, strike selection, exit conditions, and
 *              partial fill behaviour. No network calls, no event bus side-effects.
 *
 * Run: node test-phase4-strategies.js
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

const NOW_IST_10AM = (() => {
  // Build a timestamp that resolves to ~10:00 IST
  const d = new Date();
  d.setUTCHours(4, 30, 0, 0); // 04:30 UTC = 10:00 IST
  return d.getTime();
})();

const NOW_IST_8AM = (() => {
  const d = new Date();
  d.setUTCHours(2, 30, 0, 0); // 02:30 UTC = 08:00 IST — before market
  return d.getTime();
})();

const NOW_IST_14_30 = (() => {
  const d = new Date();
  d.setUTCHours(9, 0, 0, 0); // 09:00 UTC = 14:30 IST — after cut
  return d.getTime();
})();

function makeBullishMarket(overrides = {}) {
  return {
    indicators: {
      ema9: 25300, ema21: 25250,   // ema9 > ema21 — bullish trend
      rsi:  56,                     // > 50 — bullish momentum
      macd: { macd: 1.2, signal: 0.9 },
      bb:   { upper: 25600, lower: 24900, width: 2.8 },
    },
    bbWidthHistory: [2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.0, 3.1, 3.2, 2.8],
    optionsChain: {
      vix:              16,
      pcr:              1.15,       // > 1.0 — put-heavy OI
      underlyingValue:  25310,      // above ema21
      maxCeOiStrike:    25600,
      maxPeOiStrike:    25000,
      atmStrike:        25300,
    },
    sessionContext: {
      dayOpen: 25200, tradesToday: 0, consecutiveLosses: 0,
    },
    timestamp: NOW_IST_10AM,
    _isHolidayOverride: false,
    ...overrides,
  };
}

function makeBearishMarket(overrides = {}) {
  return {
    indicators: {
      ema9: 25180, ema21: 25250,   // ema9 < ema21 — bearish trend
      rsi:  44,                     // < 50 — bearish momentum
      macd: { macd: -1.5, signal: -0.8 },
      bb:   { upper: 25600, lower: 24900, width: 2.8 },
    },
    bbWidthHistory: [2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.0, 3.1, 3.2, 2.8],
    optionsChain: {
      vix:              17,
      pcr:              0.85,       // < 1.0 — call-heavy OI
      underlyingValue:  25190,      // below ema21
      maxCeOiStrike:    25700,      // 25700 - 100 = 25600 (not a round-500 level, no shift)
      maxPeOiStrike:    25000,
      atmStrike:        25200,
    },
    sessionContext: {
      dayOpen: 25400, tradesToday: 0, consecutiveLosses: 0,
    },
    timestamp: NOW_IST_10AM,
    _isHolidayOverride: false,
    ...overrides,
  };
}

function makeHighIvMarket(overrides = {}) {
  return {
    indicators: {
      ema9: 25255, ema21: 25250,   // nearly flat — neutral
      rsi:  50,
      macd: { macd: 0.3, signal: 0.2 },
      bb:   { upper: 25800, lower: 24700, width: 4.2 },
    },
    // Wide BB widths — IV percentile will be high
    bbWidthHistory: [2.0, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.0, 3.5, 4.2],
    optionsChain: {
      vix:              21,
      pcr:              0.98,
      underlyingValue:  25260,
      maxCeOiStrike:    25600,
      maxPeOiStrike:    25000,
      atmStrike:        25250,
    },
    sessionContext: {
      dayOpen: 25200, tradesToday: 0, consecutiveLosses: 0,
    },
    timestamp: NOW_IST_10AM,
    _isHolidayOverride: false,
    ...overrides,
  };
}

// ── Load strategies (bypass event bus by accessing class methods directly) ────
// The exported singletons register event listeners — that's fine for tests.
// We call checkConditions() and buildTrade() as pure functions.

const bps = require('../strategies/bull-put-spread.strategy');
const bcs = require('../strategies/bear-call-spread.strategy');
const str = require('../strategies/straddle.strategy');

// ── Bull Put Spread ───────────────────────────────────────────────────────────

section('Bull Put Spread — identity');

ok('name is "Bull Put Spread"', bps.name === 'Bull Put Spread');
ok('regime includes A', bps.getAllowedRegimes().includes('A'));
ok('regime includes B', bps.getAllowedRegimes().includes('B'));
ok('claudeDescription is a non-empty string', typeof bps.claudeDescription === 'string' && bps.claudeDescription.length > 10);

section('Bull Put Spread — entry conditions PASS');

const bpsPass = bps.checkConditions(makeBullishMarket());
ok('eligible=true on bullish market', bpsPass.eligible, JSON.stringify(bpsPass.failedConditions));
ok('score > 80 on bullish market', bpsPass.score > 80, `score=${bpsPass.score}`);
ok('failedConditions is empty', bpsPass.failedConditions.length === 0, JSON.stringify(bpsPass.failedConditions));

section('Bull Put Spread — entry conditions FAIL');

const bpsFailRsi = bps.checkConditions(makeBullishMarket({ indicators: { ...makeBullishMarket().indicators, rsi: 45 } }));
ok('fails when RSI <= 50', !bpsFailRsi.eligible);
ok('failedConditions includes rsi', bpsFailRsi.failedConditions.includes('rsi'));

const bpsFailVix = bps.checkConditions(makeBullishMarket({
  optionsChain: { ...makeBullishMarket().optionsChain, vix: 21 },
}));
ok('fails when VIX >= 20', !bpsFailVix.eligible);
ok('failedConditions includes vix', bpsFailVix.failedConditions.includes('vix'));

const bpsFailTime = bps.checkConditions(makeBullishMarket({ timestamp: NOW_IST_8AM }));
ok('fails before 09:30 IST', !bpsFailTime.eligible);
ok('failedConditions includes timeWindow', bpsFailTime.failedConditions.includes('timeWindow'));

const bpsFailHoliday = bps.checkConditions(makeBullishMarket({ _isHolidayOverride: true }));
ok('fails on holiday', !bpsFailHoliday.eligible);
ok('failedConditions includes eventDay', bpsFailHoliday.failedConditions.includes('eventDay'));

section('Bull Put Spread — strike selection');

const bpsTrade = bps.buildTrade(makeBullishMarket());
ok('has shortPe and longPe strikes', 'shortPe' in bpsTrade.strikes && 'longPe' in bpsTrade.strikes);
ok('shortPe = maxPeOiStrike + 100 = 25100', bpsTrade.strikes.shortPe === 25100, `got ${bpsTrade.strikes.shortPe}`);
ok('longPe = shortPe - 200 = 24900', bpsTrade.strikes.longPe === 24900, `got ${bpsTrade.strikes.longPe}`);
ok('has SELL PE leg', bpsTrade.legs.some(l => l.type === 'PE' && l.action === 'SELL'));
ok('has BUY PE leg', bpsTrade.legs.some(l => l.type === 'PE' && l.action === 'BUY'));
ok('exactly 2 legs', bpsTrade.legs.length === 2);

section('Bull Put Spread — +50 shift on round strike');

const bpsRound = bps.buildTrade(makeBullishMarket({
  optionsChain: { ...makeBullishMarket().optionsChain, maxPeOiStrike: 24400 }, // +100 = 24500 (round)
}));
ok('+50 shift applied: shortPe = 24550', bpsRound.strikes.shortPe === 24550, `got ${bpsRound.strikes.shortPe}`);

section('Bull Put Spread — exit conditions');

const bpsExit = bps.getExitConditions(bpsTrade);
ok('exitIfNiftyClosesBelow is set', typeof bpsExit.exitIfNiftyClosesBelow === 'number');
ok('deltaPeThreshold = -0.40', bpsExit.deltaPeThreshold === -0.40);
ok('exitTimeframe = "15m"', bpsExit.exitTimeframe === '15m');

section('Bull Put Spread — partial fill');

ok('validatePartialFill returns false', bps.validatePartialFill([]) === false);

// ── Bear Call Spread ──────────────────────────────────────────────────────────

section('Bear Call Spread — identity');

ok('name is "Bear Call Spread"', bcs.name === 'Bear Call Spread');
ok('regime includes B', bcs.getAllowedRegimes().includes('B'));
ok('regime includes C', bcs.getAllowedRegimes().includes('C'));
ok('claudeDescription is a non-empty string', typeof bcs.claudeDescription === 'string' && bcs.claudeDescription.length > 10);

section('Bear Call Spread — entry conditions PASS');

const bcsPass = bcs.checkConditions(makeBearishMarket());
ok('eligible=true on bearish market', bcsPass.eligible, JSON.stringify(bcsPass.failedConditions));
ok('score > 80 on bearish market', bcsPass.score > 80, `score=${bcsPass.score}`);
ok('failedConditions is empty', bcsPass.failedConditions.length === 0, JSON.stringify(bcsPass.failedConditions));

section('Bear Call Spread — entry conditions FAIL');

const bcsFailRsi = bcs.checkConditions(makeBearishMarket({ indicators: { ...makeBearishMarket().indicators, rsi: 55 } }));
ok('fails when RSI >= 50', !bcsFailRsi.eligible);
ok('failedConditions includes rsi', bcsFailRsi.failedConditions.includes('rsi'));

const bcsFailVix = bcs.checkConditions(makeBearishMarket({
  optionsChain: { ...makeBearishMarket().optionsChain, vix: 22 },
}));
ok('fails when VIX >= 20', !bcsFailVix.eligible);

const bcsFailPcr = bcs.checkConditions(makeBearishMarket({
  optionsChain: { ...makeBearishMarket().optionsChain, pcr: 1.1 },
}));
ok('fails when PCR >= 1.0', !bcsFailPcr.eligible);
ok('failedConditions includes pcr', bcsFailPcr.failedConditions.includes('pcr'));

const bcsFailAfterCut = bcs.checkConditions(makeBearishMarket({ timestamp: NOW_IST_14_30 }));
ok('fails after 14:00 IST', !bcsFailAfterCut.eligible);

section('Bear Call Spread — strike selection');

const bcsTrade = bcs.buildTrade(makeBearishMarket());
ok('has shortCe and longCe strikes', 'shortCe' in bcsTrade.strikes && 'longCe' in bcsTrade.strikes);
ok('shortCe = maxCeOiStrike - 100 = 25600', bcsTrade.strikes.shortCe === 25600, `got ${bcsTrade.strikes.shortCe}`);
ok('longCe = shortCe + 200 = 25800', bcsTrade.strikes.longCe === 25800, `got ${bcsTrade.strikes.longCe}`);
ok('has SELL CE leg', bcsTrade.legs.some(l => l.type === 'CE' && l.action === 'SELL'));
ok('has BUY CE leg', bcsTrade.legs.some(l => l.type === 'CE' && l.action === 'BUY'));
ok('exactly 2 legs', bcsTrade.legs.length === 2);

section('Bear Call Spread — +50 shift on round strike');

const bcsRound = bcs.buildTrade(makeBearishMarket({
  optionsChain: { ...makeBearishMarket().optionsChain, maxCeOiStrike: 25600 }, // -100 = 25500 (round)
}));
ok('+50 shift applied: shortCe = 25550', bcsRound.strikes.shortCe === 25550, `got ${bcsRound.strikes.shortCe}`);

section('Bear Call Spread — exit conditions');

const bcsExit = bcs.getExitConditions(bcsTrade);
ok('exitIfNiftyClosesAbove is set', typeof bcsExit.exitIfNiftyClosesAbove === 'number');
ok('deltaCeThreshold = 0.40', bcsExit.deltaCeThreshold === 0.40);
ok('exitTimeframe = "15m"', bcsExit.exitTimeframe === '15m');

section('Bear Call Spread — partial fill');

ok('validatePartialFill returns false', bcs.validatePartialFill([]) === false);

// ── Straddle ──────────────────────────────────────────────────────────────────

section('Straddle — identity');

ok('name is "Straddle"', str.name === 'Straddle');
ok('regime includes B', str.getAllowedRegimes().includes('B'));
ok('claudeDescription is a non-empty string', typeof str.claudeDescription === 'string' && str.claudeDescription.length > 10);

section('Straddle — entry conditions PASS');

const strPass = str.checkConditions(makeHighIvMarket());
ok('eligible=true on high-IV neutral market', strPass.eligible, JSON.stringify(strPass.failedConditions));
ok('score > 80 on high-IV market', strPass.score > 80, `score=${strPass.score}`);
ok('failedConditions is empty', strPass.failedConditions.length === 0, JSON.stringify(strPass.failedConditions));

section('Straddle — entry conditions FAIL');

const strFailVixLow = str.checkConditions(makeHighIvMarket({
  optionsChain: { ...makeHighIvMarket().optionsChain, vix: 15 }, // below 18
}));
ok('fails when VIX < 18', !strFailVixLow.eligible);
ok('failedConditions includes vix', strFailVixLow.failedConditions.includes('vix'));

const strFailVixHigh = str.checkConditions(makeHighIvMarket({
  optionsChain: { ...makeHighIvMarket().optionsChain, vix: 28 }, // above 25
}));
ok('fails when VIX > 25', !strFailVixHigh.eligible);

const strFailRsi = str.checkConditions(makeHighIvMarket({ indicators: { ...makeHighIvMarket().indicators, rsi: 62 } }));
ok('fails when RSI > 55', !strFailRsi.eligible);
ok('failedConditions includes rsi', strFailRsi.failedConditions.includes('rsi'));

const strFailEma = str.checkConditions(makeHighIvMarket({
  indicators: { ...makeHighIvMarket().indicators, ema9: 25400, ema21: 25250 }, // spread > 0.3%
}));
ok('fails when EMA spread > 0.3%', !strFailEma.eligible);
ok('failedConditions includes emaSpread', strFailEma.failedConditions.includes('emaSpread'));

// Straddle time window is tighter: 09:30–13:00 IST
const strFailTime = str.checkConditions(makeHighIvMarket({ timestamp: NOW_IST_14_30 }));
ok('fails after 13:00 IST (tighter window)', !strFailTime.eligible);

section('Straddle — strike selection');

const strTrade = str.buildTrade(makeHighIvMarket());
ok('has atm strike', 'atm' in strTrade.strikes);
ok('atm = nearest 50 to spot 25260 = 25250', strTrade.strikes.atm === 25250, `got ${strTrade.strikes.atm}`);
ok('has SELL CE leg at ATM', strTrade.legs.some(l => l.type === 'CE' && l.action === 'SELL' && l.strike === 25250));
ok('has SELL PE leg at ATM', strTrade.legs.some(l => l.type === 'PE' && l.action === 'SELL' && l.strike === 25250));
ok('exactly 2 legs', strTrade.legs.length === 2);

section('Straddle — ATM rounding');

// spot = 25275 → nearest 50 = 25300
const strRound = str.buildTrade(makeHighIvMarket({
  optionsChain: { ...makeHighIvMarket().optionsChain, underlyingValue: 25275 },
}));
ok('ATM rounds to nearest 50: 25275 → 25300', strRound.strikes.atm === 25300, `got ${strRound.strikes.atm}`);

// spot = 25240 → 25240/50 = 504.8 → round down → 504 * 50 = 25200
const strRound2 = str.buildTrade(makeHighIvMarket({
  optionsChain: { ...makeHighIvMarket().optionsChain, underlyingValue: 25240 },
}));
ok('ATM rounds to nearest 50: 25240 → 25250', strRound2.strikes.atm === 25250, `got ${strRound2.strikes.atm}`);

section('Straddle — exit conditions');

const strExit = str.getExitConditions(strTrade);
ok('deltaCeThreshold = 0.45', strExit.deltaCeThreshold === 0.45);
ok('deltaPeThreshold = -0.45', strExit.deltaPeThreshold === -0.45);
ok('premiumErosionPct = 0.60', strExit.premiumErosionPct === 0.60);
ok('exitTimeframe = "15m"', strExit.exitTimeframe === '15m');

section('Straddle — partial fill');

ok('validatePartialFill returns false', str.validatePartialFill([]) === false);

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(58)}`);
console.log(`  Phase 4 Strategy Tests: ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(58)}\n`);

if (failed > 0) process.exit(1);
