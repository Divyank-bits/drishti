/**
 * @file test-phase7-lookahead.js
 * @description Phase 7 Gate 4: for a fixture of 300+ bars, for every setup and several
 *              values of i, evaluate(full) equals evaluate(truncated at i).
 *              Same check for tideAt.
 *
 * Run: node tests/test-phase7-lookahead.js
 */

'use strict';

require('dotenv').config();

const { buildFeatures }   = require('../analysis/features');
const { tideAt }          = require('../analysis/features');
const { getAll }          = require('../strategies/swing/registry');

// ── Minimal test harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { passed++; }
  else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function section(name) { console.log(`\n── ${name} ──`); }

// ── Fixture: 350 bars ─────────────────────────────────────────────────────────

function buildFixture(n = 350) {
  const candles = [];
  let price = 200;
  for (let i = 0; i < n; i++) {
    const d = new Date('2019-01-01');
    d.setDate(d.getDate() + i);

    // Pseudo-random price movement (deterministic)
    const change = ((i * 7 + 13) % 11) - 5;   // -5 to +5
    price = Math.max(50, price + change);

    candles.push({
      date:   d.toISOString().slice(0, 10),
      open:   price,
      high:   price + 3 + (i % 4),
      low:    price - 3 - (i % 3),
      close:  price + ((i % 5) - 2),
      volume: 1000 + (i * 17 % 500),
    });
  }
  return candles;
}

// ── tideAt lookahead test ─────────────────────────────────────────────────────

section('tideAt — no lookahead');

{
  const full = buildFixture(350);
  const testPoints = [60, 100, 150, 200, 250, 300];

  for (const i of testPoints) {
    const tFull      = tideAt(full, i);
    const truncated  = full.slice(0, i + 1);
    const tTruncated = tideAt(truncated, i);

    assert(tFull === tTruncated,
      `tideAt(i=${i}): full='${tFull}' truncated='${tTruncated}'`);
  }
}

// ── Setup lookahead tests ─────────────────────────────────────────────────────

section('All setups — evaluate is lookahead-free');

const setups     = getAll();
const fullCandles = buildFixture(350);
const fullFeatures = buildFeatures(fullCandles);
const testPoints = [70, 100, 130, 160, 200, 250];

for (const setup of setups) {
  for (const i of testPoints) {
    for (const direction of ['LONG', 'SHORT']) {
      // Evaluate on the full array
      const rFull = setup.evaluate({ daily: fullCandles, features: fullFeatures, i, direction });

      // Evaluate on the truncated array (only bars 0..i)
      const truncCandles  = fullCandles.slice(0, i + 1);
      const truncFeatures = buildFeatures(truncCandles);
      const rTrunc = setup.evaluate({ daily: truncCandles, features: truncFeatures, i, direction });

      // The two must agree on state
      assert(rFull.state === rTrunc.state,
        `${setup.id} ${direction} i=${i}: state full='${rFull.state}' vs truncated='${rTrunc.state}'`);

      // And on stopLoss (if present)
      if (rFull.state !== 'NONE') {
        const slMatch = rFull.stopLoss === rTrunc.stopLoss ||
          (rFull.stopLoss !== null && rTrunc.stopLoss !== null &&
            Math.abs(rFull.stopLoss - rTrunc.stopLoss) < 0.001);
        assert(slMatch,
          `${setup.id} ${direction} i=${i}: stopLoss full=${rFull.stopLoss} vs truncated=${rTrunc.stopLoss}`);
      }
    }
  }
}

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`Lookahead tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
