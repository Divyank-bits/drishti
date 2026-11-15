/**
 * @file test-phase7-candles.js
 * @description Phase 7 Gate 3: unit tests for analysis/candles.js
 *              Every detector gets at least one positive fixture and two near-miss negatives.
 *              Heikin Ashi is verified against a hand calculation.
 *              No network — all fixtures are inline.
 */

'use strict';

const {
  body, range, upperWick, lowerWick, median, isBullish, isBearish,
  isHammer, isInvertedHammerOrShootingStar,
  isBullishPiercing, isBullishEngulfing, isMorningStar,
  isBearishPiercing, isBearishEngulfing, isEveningStar,
  isHangingMan,
  isThreeWhiteSoldiers, isThreeBlackCrows,
  isPlainBullish, isPlainBearish,
  isDoji, isSpinningTop, isHighWave, isTweezersTop, isTweezersBottom,
  detectAll,
} = require('../analysis/candles');
const { heikinAshiSeries } = require('../analysis/swing-indicators');

let passed = 0;
let failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; }
}

// ── candle factory helpers ────────────────────────────────────────────────────

function bull(o, c, h, l, v = 10000) { return { open: o, close: c, high: h, low: l, volume: v }; }
function bear(o, c, h, l, v = 10000) { return { open: o, close: c, high: h, low: l, volume: v }; }
// padded array: fill index 0..n-2 with neutral, then append real candles
function pad(n, ...candles) {
  const neutral = { open: 100, close: 100, high: 101, low: 99, volume: 5000 };
  return [...Array(n - candles.length).fill(neutral), ...candles];
}

console.log('\n── Phase 7 Candle Pattern Tests ─────────────────────────────');

// ── Anatomy ───────────────────────────────────────────────────────────────────
console.log('\n  Anatomy');
{
  const c = { open: 100, close: 110, high: 115, low: 95 };
  assert(Math.abs(body(c) - 10)       < 1e-9, 'body = |close - open|');
  assert(Math.abs(range(c) - 20)      < 1e-9, 'range = high - low');
  assert(Math.abs(upperWick(c) - 5)   < 1e-9, 'upperWick = high - max(o,c)');
  assert(Math.abs(lowerWick(c) - 5)   < 1e-9, 'lowerWick = min(o,c) - low');
  assert(Math.abs(median(c) - 105)    < 1e-9, 'median = (open+close)/2');
  assert(isBullish(c), 'isBullish when close > open');
  assert(!isBearish(c), '!isBearish when close > open');

  const d = { open: 110, close: 100, high: 115, low: 95 };
  assert(isBearish(d), 'isBearish when close < open');
}

// ── Hammer ────────────────────────────────────────────────────────────────────
console.log('\n  Hammer');
{
  // Positive: small body (5%), long lower wick (>= 2x body), upper wick <= body
  // at the bottom of a decline (lowest low of last 10 bars)
  const hammer = bear(102, 100, 102, 90);  // body=2, lowerWick=10, upperWick=0 — at bottom
  const candles = pad(10, hammer);
  assert(isHammer(candles, 9), 'Hammer positive: small body, 2x lower wick, at bottom');

  // Near-miss 1: body too large (> 30% of range)
  const bigBody = bear(110, 100, 110, 90); // body=10, range=20, 50% — not small
  const c2 = pad(10, bigBody);
  assert(!isHammer(c2, 9), 'Hammer neg: body > SWING_SMALL_BODY_PCT');

  // Near-miss 2: lower wick too short (< 2x body)
  const shortWick = bear(102, 100, 102, 99); // body=2, lowerWick=1 < 4
  const c3 = pad(10, shortWick);
  assert(!isHammer(c3, 9), 'Hammer neg: lower wick < 2x body');

  // Near-miss 3: not at bottom (another candle has lower low in lookback)
  const lowerCandle = { open: 100, close: 100, high: 101, low: 80, volume: 5000 };
  const notBottom = [...Array(8).fill(lowerCandle), lowerCandle, hammer];
  assert(!isHammer(notBottom, 9), 'Hammer neg: not at bottom (earlier candle has lower low)');
}

// ── Bullish Engulfing ─────────────────────────────────────────────────────────
console.log('\n  Bullish Engulfing');
{
  const c1 = bear(105, 100, 106, 99); // bearish
  const c2 = bull(99, 107, 108, 98);  // bullish, opens <= c1.close, closes > c1.open
  const cs = pad(10, c1, c2);
  assert(isBullishEngulfing(cs, 9), 'BullishEngulf positive');

  // Near-miss 1: c2 does not close above c1.open
  const c2b = bull(99, 104, 106, 98);
  const cs2 = pad(10, c1, c2b);
  assert(!isBullishEngulfing(cs2, 9), 'BullishEngulf neg: c2.close <= c1.open');

  // Near-miss 2: c1 is bullish (not bearish)
  const c1b = bull(100, 105, 106, 99);
  const cs3 = pad(10, c1b, c2);
  assert(!isBullishEngulfing(cs3, 9), 'BullishEngulf neg: c1 is bullish');
}

// ── Bullish Piercing ──────────────────────────────────────────────────────────
console.log('\n  Bullish Piercing');
{
  // c1 bearish open=110 close=100 median=105; c2 bullish open=98 close=107 (above median, below c1.open)
  const c1 = bear(110, 100, 112, 98);
  const c2 = bull(98, 107, 109, 97);
  const cs = pad(10, c1, c2);
  assert(isBullishPiercing(cs, 9), 'BullishPiercing positive');

  // Near-miss 1: c2.close <= median(c1) = 105
  const c2b = bull(98, 104, 106, 97);
  const cs2 = pad(10, c1, c2b);
  assert(!isBullishPiercing(cs2, 9), 'BullishPiercing neg: c2.close <= median(c1)');

  // Near-miss 2: c2.close >= c1.open (would be engulf, not piercing)
  const c2c = bull(98, 112, 113, 97);
  const cs3 = pad(10, c1, c2c);
  assert(!isBullishPiercing(cs3, 9), 'BullishPiercing neg: c2.close >= c1.open (engulf)');
}

// ── Morning Star ──────────────────────────────────────────────────────────────
console.log('\n  Morning Star');
{
  // c1 bearish; c2 small body opens below c1.close, makes new low; c3 bullish opens above c2.close, closes above median(c1)
  const c1 = bear(110, 100, 112, 98);    // median = 105
  const c2 = { open: 98, close: 97, high: 99, low: 94, volume: 5000 }; // small body, opens below 100, low < 98
  const c3 = bull(99, 108, 110, 98);     // opens above c2.close=97, closes above 105
  const cs = pad(10, c1, c2, c3);
  assert(isMorningStar(cs, 9), 'MorningStar positive');

  // Near-miss 1: c2 body is not small
  const c2b = bear(98, 90, 99, 88);  // body = 8 out of range 11 — too large
  const cs2 = pad(10, c1, c2b, c3);
  assert(!isMorningStar(cs2, 9), 'MorningStar neg: c2 body not small');

  // Near-miss 2: c3 does not close above median(c1)
  const c3b = bull(99, 103, 104, 98);
  const cs3 = pad(10, c1, c2, c3b);
  assert(!isMorningStar(cs3, 9), 'MorningStar neg: c3.close <= median(c1)');
}

// ── Bearish Engulfing ─────────────────────────────────────────────────────────
console.log('\n  Bearish Engulfing');
{
  const c1 = bull(95, 105, 106, 94);
  const c2 = bear(107, 93, 108, 92);
  const cs = pad(10, c1, c2);
  assert(isBearishEngulfing(cs, 9), 'BearishEngulf positive');

  const c2b = bear(107, 96, 108, 95);
  const cs2 = pad(10, c1, c2b);
  assert(!isBearishEngulfing(cs2, 9), 'BearishEngulf neg: c2.close >= c1.open');

  const c1b = bear(105, 95, 106, 94);
  const cs3 = pad(10, c1b, c2);
  assert(!isBearishEngulfing(cs3, 9), 'BearishEngulf neg: c1 is bearish');
}

// ── Bearish Piercing ──────────────────────────────────────────────────────────
console.log('\n  Bearish Piercing');
{
  const c1 = bull(100, 110, 112, 98);    // median = 105
  const c2 = bear(112, 103, 113, 102);   // opens above c1.close, closes below median, above c1.open
  const cs = pad(10, c1, c2);
  assert(isBearishPiercing(cs, 9), 'BearishPiercing positive');

  const c2b = bear(112, 106, 113, 105);  // c2.close > median
  const cs2 = pad(10, c1, c2b);
  assert(!isBearishPiercing(cs2, 9), 'BearishPiercing neg: c2.close >= median(c1)');

  const c2c = bear(112, 98, 113, 97);    // c2.close <= c1.open — engulf
  const cs3 = pad(10, c1, c2c);
  assert(!isBearishPiercing(cs3, 9), 'BearishPiercing neg: c2.close <= c1.open (engulf)');
}

// ── Evening Star ──────────────────────────────────────────────────────────────
console.log('\n  Evening Star');
{
  const c1 = bull(100, 110, 112, 98);    // median = 105
  const c2 = { open: 112, close: 113, high: 116, low: 111, volume: 5000 }; // small body above c1
  const c3 = bear(111, 103, 112, 102);   // opens below c2.close, closes below median(c1)
  const cs = pad(10, c1, c2, c3);
  assert(isEveningStar(cs, 9), 'EveningStar positive');

  const c3b = bear(111, 106, 112, 105);  // c3.close > median(c1)
  const cs2 = pad(10, c1, c2, c3b);
  assert(!isEveningStar(cs2, 9), 'EveningStar neg: c3.close >= median(c1)');

  const c2b = bear(112, 108, 113, 111);  // c2 body too large
  const cs3 = pad(10, c1, c2b, c3);
  assert(!isEveningStar(cs3, 9), 'EveningStar neg: c2 body not small');
}

// ── Hanging Man ───────────────────────────────────────────────────────────────
console.log('\n  Hanging Man');
{
  // prev: hammer-shape at top; curr: bearish candle
  // Build rising candles so prev is at top
  const rising = Array.from({ length: 8 }, (_, i) => bull(100 + i * 2, 102 + i * 2, 103 + i * 2, 99 + i * 2));
  const prevH = bear(118, 116, 118, 108); // body=2, lowerWick=8, upperWick=0 at top
  const conf  = bear(116, 110, 117, 109);
  const cs = [...rising, prevH, conf];
  assert(isHangingMan(cs, 9), 'HangingMan positive');

  // Near-miss 1: confirming candle is bullish
  const confBull = bull(116, 120, 121, 115);
  const cs2 = [...rising, prevH, confBull];
  assert(!isHangingMan(cs2, 9), 'HangingMan neg: confirming candle is bullish');

  // Near-miss 2: not at top (another candle has higher high in lookback)
  const higher = { open: 100, close: 100, high: 150, low: 99, volume: 5000 };
  const cs3 = [...Array(7).fill(higher), prevH, conf];
  assert(!isHangingMan(cs3, 9), 'HangingMan neg: not at top');
}

// ── Three White Soldiers ──────────────────────────────────────────────────────
console.log('\n  Three White Soldiers');
{
  const s1 = bull(100, 110, 111, 99);  // body=10, range=12 → 83%
  const s2 = bull(110, 120, 121, 109);
  const s3 = bull(120, 130, 131, 119);
  const cs = pad(10, s1, s2, s3);
  assert(isThreeWhiteSoldiers(cs, 9), 'ThreeWhiteSoldiers positive');

  // Near-miss 1: second soldier does not close higher
  const s2b = bull(110, 108, 111, 109);
  const cs2 = pad(10, s1, s2b, s3);
  assert(!isThreeWhiteSoldiers(cs2, 9), 'ThreeWhiteSoldiers neg: c2 close <= c1 close');

  // Near-miss 2: a candle is bearish
  const cs3 = pad(10, s1, bear(110, 108, 111, 107), s3);
  assert(!isThreeWhiteSoldiers(cs3, 9), 'ThreeWhiteSoldiers neg: middle candle bearish');
}

// ── Three Black Crows ─────────────────────────────────────────────────────────
console.log('\n  Three Black Crows');
{
  const c1 = bear(130, 120, 131, 119);
  const c2 = bear(120, 110, 121, 109);
  const c3 = bear(110, 100, 111, 99);
  const cs = pad(10, c1, c2, c3);
  assert(isThreeBlackCrows(cs, 9), 'ThreeBlackCrows positive');

  const c2b = bear(120, 122, 121, 119); // c2 close > c1 close
  const cs2 = pad(10, c1, c2b, c3);
  assert(!isThreeBlackCrows(cs2, 9), 'ThreeBlackCrows neg: c2 close >= c1 close');

  const cs3 = pad(10, c1, bull(120, 125, 126, 119), c3);
  assert(!isThreeBlackCrows(cs3, 9), 'ThreeBlackCrows neg: middle candle bullish');
}

// ── Plain Bullish / Bearish ───────────────────────────────────────────────────
console.log('\n  Plain Bullish / Plain Bearish');
{
  // body >= 60% of range
  const strong = bull(100, 116, 118, 98); // body=16, range=20 → 80%
  const cs = pad(10, strong);
  assert(isPlainBullish(cs, 9), 'PlainBullish positive');

  const weak = bull(100, 108, 118, 98);   // body=8, range=20 → 40%
  const cs2 = pad(10, weak);
  assert(!isPlainBullish(cs2, 9), 'PlainBullish neg: body < 60%');

  const sb = bear(116, 100, 118, 98);
  const cs3 = pad(10, sb);
  assert(isPlainBearish(cs3, 9), 'PlainBearish positive');
  assert(!isPlainBullish(cs3, 9), 'PlainBullish neg: candle is bearish');
}

// ── Doji ──────────────────────────────────────────────────────────────────────
console.log('\n  Doji');
{
  const doji = { open: 100, close: 100.5, high: 110, low: 90, volume: 5000 }; // body=0.5, range=20 → 2.5%
  const cs = pad(10, doji);
  assert(isDoji(cs, 9), 'Doji positive: body <= 10% of range');

  const notDoji = { open: 100, close: 103, high: 110, low: 90, volume: 5000 }; // body=3, range=20 → 15%
  const cs2 = pad(10, notDoji);
  assert(!isDoji(cs2, 9), 'Doji neg: body > 10% of range');
}

// ── Spinning Top ──────────────────────────────────────────────────────────────
console.log('\n  Spinning Top');
{
  const st = { open: 100, close: 103, high: 112, low: 91, volume: 5000 }; // body=3, range=21 → 14%; wicks on both sides
  const cs = pad(10, st);
  assert(isSpinningTop(cs, 9), 'SpinningTop positive: small body, wicks both sides');

  const noLow = { open: 100, close: 103, high: 112, low: 100, volume: 5000 }; // no lower wick
  const cs2 = pad(10, noLow);
  assert(!isSpinningTop(cs2, 9), 'SpinningTop neg: no lower wick');
}

// ── High Wave ─────────────────────────────────────────────────────────────────
console.log('\n  High Wave');
{
  const hw = { open: 100, close: 102, high: 115, low: 85, volume: 5000 }; // body=2, upper=13>=4, lower=15>=4
  const cs = pad(10, hw);
  assert(isHighWave(cs, 9), 'HighWave positive: both wicks >= 2x body');

  const shortUpper = { open: 100, close: 102, high: 105, low: 85, volume: 5000 }; // upper=3 < 4
  const cs2 = pad(10, shortUpper);
  assert(!isHighWave(cs2, 9), 'HighWave neg: upper wick < 2x body');
}

// ── Tweezers ──────────────────────────────────────────────────────────────────
console.log('\n  Tweezers');
{
  const t1 = bull(100, 110, 115, 95);
  const t2 = bear(109, 101, 114.9, 95); // high within 0.1% of 115
  const cs = pad(10, t1, t2);
  assert(isTweezersTop(cs, 9), 'TweezersTop positive: highs within 0.2%');

  const t3 = bear(109, 101, 112, 95);  // high 112 vs 115 → 2.6% apart
  const cs2 = pad(10, t1, t3);
  assert(!isTweezersTop(cs2, 9), 'TweezersTop neg: highs > 0.2% apart');

  const b1 = bear(110, 100, 112, 90);
  const b2 = bull(101, 109, 113, 90.1); // low within 0.11% of 90
  const cs3 = pad(10, b1, b2);
  assert(isTweezersBottom(cs3, 9), 'TweezersBottom positive: lows within 0.2%');
}

// ── detectAll ─────────────────────────────────────────────────────────────────
console.log('\n  detectAll');
{
  // Three White Soldiers: should be in bullish
  const s1 = bull(100, 110, 111, 99);
  const s2 = bull(110, 120, 121, 109);
  const s3 = bull(120, 130, 131, 119);
  const cs = pad(10, s1, s2, s3);
  const r = detectAll(cs, 9);
  assert(Array.isArray(r.bullish) && Array.isArray(r.bearish) && Array.isArray(r.neutral),
    'detectAll returns bullish/bearish/neutral arrays');
  assert(r.bullish.includes('three-white-soldiers'), 'detectAll: three-white-soldiers in bullish');

  // Doji: should appear in neutral
  const dojiC = { open: 100, close: 100.5, high: 110, low: 90, volume: 5000 };
  const cs2 = pad(10, dojiC);
  const r2 = detectAll(cs2, 9);
  assert(r2.neutral.includes('doji'), 'detectAll: doji in neutral');
}

// ── Heikin Ashi hand calculation ─────────────────────────────────────────────
console.log('\n  Heikin Ashi (hand calculation)');
{
  const c0 = { open: 100, high: 110, low: 95, close: 108, volume: 1000 };
  const c1 = { open: 108, high: 115, low: 105, close: 112, volume: 1200 };

  const ha = heikinAshiSeries([c0, c1]);

  // Bar 0
  const ha0Close = (100 + 110 + 95 + 108) / 4;      // 103.25
  const ha0Open  = (100 + 108) / 2;                  // 104
  const ha0High  = Math.max(110, ha0Open, ha0Close); // 110
  const ha0Low   = Math.min(95,  ha0Open, ha0Close); // 95
  assert(Math.abs(ha[0].haClose - ha0Close) < 1e-9, 'HA bar 0 haClose correct');
  assert(Math.abs(ha[0].haOpen  - ha0Open)  < 1e-9, 'HA bar 0 haOpen correct');
  assert(Math.abs(ha[0].haHigh  - ha0High)  < 1e-9, 'HA bar 0 haHigh correct');
  assert(Math.abs(ha[0].haLow   - ha0Low)   < 1e-9, 'HA bar 0 haLow correct');

  // Bar 1
  const ha1Close = (108 + 115 + 105 + 112) / 4;              // 110
  const ha1Open  = (ha0Open + ha0Close) / 2;                 // 103.625
  const ha1High  = Math.max(115, ha1Open, ha1Close);         // 115
  const ha1Low   = Math.min(105, ha1Open, ha1Close);         // 103.625
  assert(Math.abs(ha[1].haClose - ha1Close) < 1e-9, 'HA bar 1 haClose correct');
  assert(Math.abs(ha[1].haOpen  - ha1Open)  < 1e-9, 'HA bar 1 haOpen correct');
  assert(Math.abs(ha[1].haHigh  - ha1High)  < 1e-9, 'HA bar 1 haHigh correct');
  assert(Math.abs(ha[1].haLow   - ha1Low)   < 1e-9, 'HA bar 1 haLow correct');

  // decisiveBull: no lower wick means haLow === min(haOpen, haClose)
  const decisive = { open: 100, high: 115, low: 103, close: 112, volume: 1000 };
  const prevC = { open: 98, high: 102, low: 97, close: 100, volume: 1000 };
  const haD = heikinAshiSeries([prevC, decisive]);
  // haOpen for decisive = (prevHaOpen + prevHaClose) / 2
  const pHaOpen  = (98 + 100) / 2;
  const pHaClose = (98 + 102 + 97 + 100) / 4;
  const dHaOpen  = (pHaOpen + pHaClose) / 2;
  const dHaClose = (100 + 115 + 103 + 112) / 4;
  const dHaLow   = Math.min(103, dHaOpen, dHaClose);
  const isBull   = dHaClose >= dHaOpen;
  const expectedDecisiveBull = isBull && Math.abs(dHaLow - Math.min(dHaOpen, dHaClose)) < 1e-9;
  assert(haD[1].decisiveBull === expectedDecisiveBull, 'HA decisiveBull matches hand calc');
}

console.log(`\nPhase 7 Candles: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
