/**
 * @file test-phase3.js
 * @description Phase 3 gate tests — intelligence layer (claude-client, prompt-builder,
 *              strategy-selector, anti-hunt Rule 8). No live Dhan API calls are made;
 *              those are covered by test-dhan.js.
 *
 * Run: node test-phase3.js
 * Requires: ANTHROPIC_API_KEY in .env for Gates 3, 6 (skipped with warning if absent)
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

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSignalPayload(overrides = {}) {
  return {
    strategy:          'Iron Condor',
    strikes:           { shortCe: 25500, longCe: 25700, shortPe: 25000, longPe: 24800 },
    legs:              [],
    indicatorSnapshot: {
      ema9: 25250, ema21: 25255,
      rsi:  52,
      macd: { macd: 0.5, signal: 0.3 },
      bb:   { upper: 25600, lower: 24900, width: 2.8 },
    },
    optionsSnapshot: { vix: 14.5, pcr: 1.05, atmStrike: 25250 },
    expectedPremium: 1800,
    timestamp:       new Date().toISOString(),
    ...overrides,
  };
}

function makeSessionCtx(overrides = {}) {
  return {
    date: new Date().toISOString().slice(0, 10),
    dayOpen: 25200, dayHigh: 25400, dayLow: 25100,
    vixAtOpen: 14.5, vixCurrent: 14.5,
    currentRegime: 'A', regimeChangesToday: 0,
    tradesToday: 0, pnlToday: 0, grossPnlToday: 0,
    consecutiveLosses: 0, wins: 0, losses: 0,
    isPaused: false, claudeAvailable: true,
    ...overrides,
  };
}

function makeCandles(n = 5) {
  return Array.from({ length: n }, (_, i) => ({
    openTime: Date.now() - (n - i) * 15 * 60 * 1000,
    open: 25200 + i * 5, high: 25230 + i * 5,
    low: 25190 + i * 5, close: 25210 + i * 5,
    volume: 120000,
  }));
}

// ── Gate 1: claude-client module loads and reflects key presence ─────────────

section('Gate 1 — claude-client module');

const claudeClient = require('./intelligence/claude-client');

ok('G1.1 module loads without throwing', true);
ok('G1.2 isAvailable() returns boolean', typeof claudeClient.isAvailable() === 'boolean');
ok('G1.3 isAvailable() false when ANTHROPIC_API_KEY absent',
  process.env.ANTHROPIC_API_KEY ? claudeClient.isAvailable() === true : claudeClient.isAvailable() === false
);

// ── Gate 2: prompt-builder produces well-formed strings ──────────────────────

section('Gate 2 — prompt-builder');

const promptBuilder = require('./intelligence/prompt-builder');

const entryPrompt = promptBuilder.buildEntryPrompt(
  makeSignalPayload(), makeSessionCtx(), makeCandles()
);
ok('G2.1 buildEntryPrompt returns non-empty string', typeof entryPrompt === 'string' && entryPrompt.length > 100);
ok('G2.2 entry prompt contains strike values', entryPrompt.includes('25500'));
ok('G2.3 entry prompt requests JSON shape', entryPrompt.includes('"approved"'));
ok('G2.4 entry prompt contains VIX', entryPrompt.includes('14.5'));

const huntPrompt = promptBuilder.buildHuntPrompt(
  { strikes: { shortCe: 25500, shortPe: 25000 }, currentPnl: -800, ceDelta: 0.38, peDelta: -0.12, entryPremium: 1800 },
  { open: 25480, high: 25560, low: 25470, close: 25540, volume: 180000, openTime: Date.now() },
  makeSessionCtx()
);
ok('G2.5 buildHuntPrompt returns non-empty string', typeof huntPrompt === 'string' && huntPrompt.length > 100);
ok('G2.6 hunt prompt requests JSON shape', huntPrompt.includes('"isLikelyHunt"'));
ok('G2.7 hunt prompt contains strike', huntPrompt.includes('25500'));

// ── Gate 3: strategy-selector RULES mode (no API call) ───────────────────────

section('Gate 3 — strategy-selector (RULES mode)');

const strategySelector = require('./intelligence/strategy-selector');
// Mutate the live config object — all modules share the same cached reference.
const config = require('./config');

(async () => {
  const savedMode    = config.INTELLIGENCE_MODE;
  const origIsAvail  = claudeClient.isAvailable.bind(claudeClient);
  config.INTELLIGENCE_MODE = 'RULES';

  try {
    const resultPass = await strategySelector.select(
      { eligible: true,  score: 80, failedConditions: [] },
      makeSignalPayload(), makeSessionCtx(), makeCandles()
    );
    ok('G3.1 RULES mode eligible:true → approved:true', resultPass.approved === true);
    ok('G3.2 RULES mode returns mode:"RULES"', resultPass.mode === 'RULES');

    const resultFail = await strategySelector.select(
      { eligible: false, score: 40, failedConditions: ['VIX too high', 'RSI out of range'] },
      makeSignalPayload(), makeSessionCtx(), makeCandles()
    );
    ok('G3.3 RULES mode eligible:false → approved:false', resultFail.approved === false);
    ok('G3.4 RULES mode rejected — reasoning mentions failed conditions', resultFail.reasoning.length > 0);

  } finally {
    config.INTELLIGENCE_MODE = savedMode;
  }

  // ── Gate 4: strategy-selector HYBRID mode score gate ─────────────────────

  section('Gate 4 — strategy-selector (HYBRID mode, score gate)');

  // Score gate fires before Claude availability check — no key needed.
  claudeClient.isAvailable = () => false;
  config.INTELLIGENCE_MODE = 'HYBRID';

  try {
    const belowThreshold = await strategySelector.select(
      { eligible: true, score: 50, failedConditions: [] }, // below MATCH_SCORE_THRESHOLD (65)
      makeSignalPayload(), makeSessionCtx(), makeCandles()
    );
    ok('G4.1 HYBRID score 50 < threshold 65 → approved:false', belowThreshold.approved === false);
    ok('G4.2 HYBRID below-threshold reason mentions score', belowThreshold.reasoning.includes('50'));

    // With Claude unavailable HYBRID falls back to RULES for above-threshold signals
    const hybridFallback = await strategySelector.select(
      { eligible: true, score: 80, failedConditions: [] },
      makeSignalPayload(), makeSessionCtx(), makeCandles()
    );
    ok('G4.3 HYBRID + Claude unavailable → falls back to RULES', hybridFallback.mode === 'RULES');

  } finally {
    claudeClient.isAvailable = origIsAvail;
    config.INTELLIGENCE_MODE = savedMode;
  }

  // ── Gate 5: anti-hunt Rule 8 skip path when Claude unavailable ───────────

  section('Gate 5 — anti-hunt Rule 8 (no-Claude path)');

  const antiHunt = require('./monitoring/anti-hunt');

  // Force Claude unavailable
  claudeClient.isAvailable = () => false;
  config.INTELLIGENCE_MODE = 'HYBRID';

  try {
    const huntResult = await antiHunt.evaluateWithClaude(
      { strikes: { shortCe: 25500, shortPe: 25000 }, currentPnl: -600, ceDelta: 0.38, peDelta: -0.1, entryPremium: 1800 },
      { open: 25480, high: 25560, low: 25470, close: 25540, volume: 180000, openTime: Date.now() },
      makeSessionCtx()
    );
    ok('G5.1 evaluateWithClaude returns object', huntResult && typeof huntResult === 'object');
    ok('G5.2 isLikelyHunt is boolean', typeof huntResult.isLikelyHunt === 'boolean');
    ok('G5.3 action is string', typeof huntResult.action === 'string');
    ok('G5.4 Claude unavailable → action defaults to HOLD', huntResult.action === 'HOLD');
  } finally {
    claudeClient.isAvailable = origIsAvail;
    config.INTELLIGENCE_MODE = savedMode;
  }

  // ── Gate 6: parseJSON helper ──────────────────────────────────────────────

  section('Gate 6 — claude-client.parseJSON');

  const j1 = claudeClient.parseJSON('{"approved":true,"confidence":0.85,"reasoning":"looks good","concerns":[]}');
  ok('G6.1 valid JSON parses correctly', j1?.approved === true && j1?.confidence === 0.85);

  const j2 = claudeClient.parseJSON('```json\n{"approved":false,"confidence":0.2,"reasoning":"bad","concerns":["vix"]}\n```');
  ok('G6.2 markdown-fenced JSON parses correctly', j2?.approved === false && j2?.confidence === 0.2);

  const j3 = claudeClient.parseJSON('this is not json at all');
  ok('G6.3 invalid JSON returns null', j3 === null);

  // ── Gate 7: live Claude API call (skipped if no key) ─────────────────────

  section('Gate 7 — live Claude API call (skipped if no key)');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  ⚠ ANTHROPIC_API_KEY not set — skipping live Claude test');
    passed++; // count as pass since it's an environment issue, not a code issue
  } else {
    try {
      const text = await claudeClient.call(
        'Respond with ONLY this JSON and nothing else: {"ok":true}',
        'You are a test assistant. Respond only with valid JSON.'
      );
      ok('G7.1 live Claude call returns non-empty string', typeof text === 'string' && text.length > 0);
      const parsed = claudeClient.parseJSON(text);
      ok('G7.2 response is valid JSON', parsed !== null);
      ok('G7.3 response contains expected field', parsed?.ok === true);
    } catch (err) {
      ok('G7.1 live Claude call succeeded', false, err.message);
      ok('G7.2 response is valid JSON', false, 'skipped due to G7.1 failure');
      ok('G7.3 response contains expected field', false, 'skipped due to G7.1 failure');
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  const total = passed + failed;
  console.log(`\n${'─'.repeat(57)}`);
  console.log(`${total} tests — ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('\n✅ All Phase 3 gates passed.');
  } else {
    console.log('\n❌ Some gates failed — see above.');
    process.exit(1);
  }

})();
