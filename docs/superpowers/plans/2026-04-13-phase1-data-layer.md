# Phase 1 — Data Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete data pipeline — tick stream, candle building, indicator computation, NSE option chain, and session context wiring — so Phase 2 has live market data to consume.

**Architecture:** Pure event chain. Dhan WebSocket → `TICK_RECEIVED` → CandleBuilder → `CANDLE_CLOSE_*` → IndicatorEngine → `INDICATORS_UPDATED`. OptionsChain runs independently on a 15m cron. SessionContext listens to all upstream events. IndicatorEngine may call `candleBuilder.getBuffer()` directly — both live in the `data/` domain, this is an intra-domain read, not a cross-domain command.

**Tech Stack:** `ws` (WebSocket), `axios` (HTTP), `dayjs` (time math), `technicalindicators` (RSI/EMA/MACD/BB/ATR/ADX), `black-scholes` (delta), `node-cron` (options chain polling)

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `config.js` | Modify | Add `STARTUP_CANDLE_COUNT: 50` |
| `data/candle-builder.js` | Create | Tick → OHLCV aggregation, rolling buffers |
| `data/indicator-engine.js` | Create | Candle buffers → RSI/EMA/MACD/BB/ATR/ADX/delta |
| `data/historical.js` | Create | Boot-time 15m candle fetch (NSE → Yahoo → cache) |
| `data/options-chain.js` | Create | NSE option chain cron, cookie refresh, PCR/OI parsing |
| `data/tick-stream.js` | Create | Dhan WebSocket, reconnect, proactive token renewal |
| `core/session-context.js` | Modify | Wire `_hookEvents()` + call it from constructor |
| `index.js` | Modify | Add Phase 1 boot steps |
| `test-phase1.js` | Create | 13 tests (T16–T28), synthetic data only |
| `data/cache/` | Create | Directory for local candle cache (git-ignored) |
| `.gitignore` | Modify | Add `data/cache/*.json` |
| `PHASE_1_COMPLETE.md` | Create | Phase deliverable doc |

---

## Task 1: Config additions and cache directory

**Files:**
- Modify: `config.js`
- Modify: `.gitignore`
- Create: `data/cache/.gitkeep`

- [ ] **Step 1: Add `STARTUP_CANDLE_COUNT` to config.js**

In `config.js`, find the `CANDLE_HISTORY_SIZE` line and add one line after it:

```js
  CANDLE_HISTORY_SIZE: 200,       // rolling candles kept in memory per timeframe
  STARTUP_CANDLE_COUNT: 50,       // candles fetched at boot; bump to 200 for deep scans
```

- [ ] **Step 2: Create `data/cache/` directory with a `.gitkeep`**

```bash
mkdir -p data/cache && touch data/cache/.gitkeep
```

- [ ] **Step 3: Add cache JSON files to `.gitignore`**

Add to `.gitignore` (create the file if it does not exist):

```
# local candle cache — rebuilt on every boot
data/cache/*.json
```

- [ ] **Step 4: Verify config loads**

```bash
node -e "const c = require('./config'); console.log('STARTUP_CANDLE_COUNT:', c.STARTUP_CANDLE_COUNT)"
```

Expected output: `STARTUP_CANDLE_COUNT: 50`

- [ ] **Step 5: Commit**

```bash
git add config.js .gitignore data/cache/.gitkeep
git commit -m "feat: add STARTUP_CANDLE_COUNT config and data/cache directory"
```

---

## Task 2: CandleBuilder + tests T16–T19

**Files:**
- Create: `data/candle-builder.js`
- Create: `test-phase1.js`

- [ ] **Step 1: Create `test-phase1.js` with harness and tests T16–T19**

```javascript
'use strict';

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}: ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

// Wipe a module from require cache so each test starts with a fresh instance.
// Also removes all eventBus listeners to prevent cross-test interference.
function resetModules(...paths) {
  const eventBus = require('./core/event-bus');
  eventBus.removeAllListeners();
  paths.forEach((p) => {
    const resolved = require.resolve(p);
    delete require.cache[resolved];
  });
}

// ── All tests run inside this async IIFE (top-level await not valid in CommonJS) ──
(async () => {

// ── T16: correct OHLCV from tick sequence ─────────────────────────────────────
await test('T16 CandleBuilder: tick sequence → correct 1m OHLCV', async () => {
  resetModules('./data/candle-builder');
  const cb = require('./data/candle-builder');
  const eventBus = require('./core/event-bus');
  const EVENTS = require('./core/events');

  const received = [];
  eventBus.on(EVENTS.CANDLE_CLOSE_1M, (c) => received.push(c));

  // All ticks inside the same UTC minute (09:15 IST = 03:45 UTC on 2025-04-13)
  const base = new Date('2025-04-13T03:45:00.000Z').getTime();
  cb._onTick({ ltp: 24100, volume: 100, timestamp: base });
  cb._onTick({ ltp: 24150, volume: 200, timestamp: base + 20000 });
  cb._onTick({ ltp: 24080, volume: 150, timestamp: base + 40000 });

  // Tick in next minute → closes the candle above
  cb._onTick({ ltp: 24200, volume: 50, timestamp: base + 60000 });

  assert(received.length === 1, `Expected 1 close, got ${received.length}`);
  const c = received[0];
  assert(c.open   === 24100, `open:   expected 24100, got ${c.open}`);
  assert(c.high   === 24150, `high:   expected 24150, got ${c.high}`);
  assert(c.low    === 24080, `low:    expected 24080, got ${c.low}`);
  assert(c.close  === 24080, `close:  expected 24080, got ${c.close}`);
  assert(c.volume === 450,   `volume: expected 450,   got ${c.volume}`);
});

// ── T17: event fires at minute boundary ───────────────────────────────────────
await test('T17 CandleBuilder: CANDLE_CLOSE_1M fires at each minute boundary', async () => {
  resetModules('./data/candle-builder');
  const cb = require('./data/candle-builder');
  const eventBus = require('./core/event-bus');
  const EVENTS = require('./core/events');

  let count = 0;
  eventBus.on(EVENTS.CANDLE_CLOSE_1M, () => count++);

  const base = new Date('2025-04-13T03:45:00.000Z').getTime();
  const min  = 60000;
  cb._onTick({ ltp: 24100, volume: 100, timestamp: base });           // opens candle
  cb._onTick({ ltp: 24110, volume: 100, timestamp: base + min });     // closes candle 0
  cb._onTick({ ltp: 24120, volume: 100, timestamp: base + 2 * min }); // closes candle 1

  assert(count === 2, `Expected 2 closes, got ${count}`);
});

// ── T18: 5m and 15m boundaries ────────────────────────────────────────────────
await test('T18 CandleBuilder: 5m and 15m candle boundaries align correctly', async () => {
  resetModules('./data/candle-builder');
  const cb = require('./data/candle-builder');
  const eventBus = require('./core/event-bus');
  const EVENTS = require('./core/events');

  let c5 = 0, c15 = 0;
  eventBus.on(EVENTS.CANDLE_CLOSE_5M,  () => c5++);
  eventBus.on(EVENTS.CANDLE_CLOSE_15M, () => c15++);

  // 09:15 IST = 03:45 UTC (aligns to 5m and 15m UTC boundaries)
  const base = new Date('2025-04-13T03:45:00.000Z').getTime();
  const min  = 60000;

  cb._onTick({ ltp: 24100, volume: 100, timestamp: base });              // 09:15 — open
  cb._onTick({ ltp: 24110, volume: 100, timestamp: base +  5 * min });   // 09:20 — closes 5m
  cb._onTick({ ltp: 24120, volume: 100, timestamp: base + 10 * min });   // 09:25 — closes 5m
  cb._onTick({ ltp: 24130, volume: 100, timestamp: base + 15 * min });   // 09:30 — closes 5m + 15m

  assert(c5  === 3, `Expected 3 5m closes, got ${c5}`);
  assert(c15 === 1, `Expected 1 15m close, got ${c15}`);
});

// ── T19: buffer capped at CANDLE_HISTORY_SIZE ─────────────────────────────────
await test('T19 CandleBuilder: buffer capped at 200, oldest entry dropped', async () => {
  resetModules('./data/candle-builder');
  const cb = require('./data/candle-builder');

  const candles = Array.from({ length: 205 }, (_, i) => ({
    open: 24000 + i, high: 24010 + i, low: 23990 + i,
    close: 24000 + i, volume: 1000,
    openTime: Date.now() + i * 60000,
  }));
  cb.seedBuffer(1, candles);

  const buf = cb.getBuffer(1);
  assert(buf.length === 200, `Expected 200, got ${buf.length}`);
  // Oldest 5 dropped → first surviving entry is index 5 (open = 24005)
  assert(buf[0].open   === 24005, `Expected oldest open 24005, got ${buf[0].open}`);
  assert(buf[199].open === 24204, `Expected newest open 24204, got ${buf[199].open}`);
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

})(); // end async IIFE
```

- [ ] **Step 2: Run — confirm 4 FAILs (module not yet created)**

```bash
node test-phase1.js
```

Expected: `Cannot find module './data/candle-builder'`

- [ ] **Step 3: Create `data/candle-builder.js`**

```javascript
/**
 * @file candle-builder.js
 * @description Builds 1m/5m/15m OHLCV candles from raw TICK_RECEIVED events.
 *              Emits CANDLE_CLOSE_1M, CANDLE_CLOSE_5M, CANDLE_CLOSE_15M on close.
 *              Maintains a rolling buffer of CANDLE_HISTORY_SIZE candles per timeframe.
 */

'use strict';

const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const config   = require('../config');

const TIMEFRAMES   = config.CANDLE_TIMEFRAMES;   // [1, 5, 15]
const HISTORY_SIZE = config.CANDLE_HISTORY_SIZE; // 200

const CLOSE_EVENTS = {
  1:  EVENTS.CANDLE_CLOSE_1M,
  5:  EVENTS.CANDLE_CLOSE_5M,
  15: EVENTS.CANDLE_CLOSE_15M,
};

class CandleBuilder {
  constructor() {
    this._state = {};
    for (const tf of TIMEFRAMES) {
      this._state[tf] = { current: null, buffer: [] };
    }
    this._hookEvents();
  }

  _hookEvents() {
    eventBus.on(EVENTS.TICK_RECEIVED, (tick) => this._onTick(tick));
  }

  // Exposed for tests — allows injecting synthetic ticks without eventBus
  _onTick({ ltp, volume, timestamp }) {
    for (const tf of TIMEFRAMES) {
      this._processTick(tf, ltp, volume, timestamp);
    }
  }

  _processTick(tf, ltp, volume, timestamp) {
    const state    = this._state[tf];
    const boundary = this._getBoundary(tf, timestamp);

    if (!state.current) {
      state.current = { open: ltp, high: ltp, low: ltp, close: ltp, volume, openTime: boundary };
      return;
    }

    if (boundary > state.current.openTime) {
      this._closeCandle(tf, state.current);
      state.current = { open: ltp, high: ltp, low: ltp, close: ltp, volume, openTime: boundary };
    } else {
      if (ltp > state.current.high) state.current.high = ltp;
      if (ltp < state.current.low)  state.current.low  = ltp;
      state.current.close   = ltp;
      state.current.volume += volume;
    }
  }

  // Epoch-based boundary: timezone-independent, aligns IST market hours correctly
  // because IST = UTC+5:30 and 330 is divisible by both 5 and 15.
  _getBoundary(tf, timestamp) {
    const tfMs = tf * 60 * 1000;
    return Math.floor(timestamp / tfMs) * tfMs;
  }

  _closeCandle(tf, candle) {
    const state = this._state[tf];
    state.buffer.push({ ...candle });
    if (state.buffer.length > HISTORY_SIZE) state.buffer.shift();
    eventBus.emit(CLOSE_EVENTS[tf], { ...candle });
  }

  // Called by historical.js at boot to seed indicator history
  seedBuffer(timeframe, candles) {
    this._state[timeframe].buffer = candles.slice(-HISTORY_SIZE);
  }

  // Called by indicator-engine.js — intra-domain read, not a cross-domain call
  getBuffer(timeframe) {
    return [...this._state[timeframe].buffer];
  }
}

module.exports = new CandleBuilder();
```

- [ ] **Step 4: Run — confirm T16–T19 pass**

```bash
node test-phase1.js
```

Expected:
```
  PASS  T16 CandleBuilder: tick sequence → correct 1m OHLCV
  PASS  T17 CandleBuilder: CANDLE_CLOSE_1M fires at each minute boundary
  PASS  T18 CandleBuilder: 5m and 15m candle boundaries align correctly
  PASS  T19 CandleBuilder: buffer capped at 200, oldest entry dropped

4 tests — 4 passed, 0 failed
```

- [ ] **Step 5: Commit**

```bash
git add data/candle-builder.js test-phase1.js
git commit -m "feat: add CandleBuilder with T16-T19 passing"
```

---

## Task 3: IndicatorEngine + tests T20–T24

**Files:**
- Create: `data/indicator-engine.js`
- Modify: `test-phase1.js` (append T20–T24 before the summary block)

- [ ] **Step 1: Append T20–T24 to `test-phase1.js`**

In `test-phase1.js`, find the closing block and insert the tests before it:
```javascript
// ── Summary ...
console.log(...);
if (failed > 0) process.exit(1);
})(); // end async IIFE
```
Paste the tests below before that block, then keep the summary + `})()` at the very end:

```javascript
// ── T20: RSI correct from known series ────────────────────────────────────────
await test('T20 IndicatorEngine: RSI correct from known price series', async () => {
  resetModules('./data/candle-builder', './data/indicator-engine');
  const cb  = require('./data/candle-builder');
  require('./data/indicator-engine');       // wires its own listeners as side-effect
  const eventBus = require('./core/event-bus');
  const EVENTS   = require('./core/events');
  const { RSI }  = require('technicalindicators');

  const closes = [24000,24050,24020,24080,24060,24100,24090,24130,24110,24150,
                  24140,24160,24130,24170,24155,24180,24160,24200,24185,24210];
  const candles = closes.map((c, i) => ({
    open: c - 10, high: c + 10, low: c - 20, close: c,
    volume: 1000, openTime: Date.now() + i * 900000,
  }));
  cb.seedBuffer(15, candles);

  const expArr = RSI.calculate({ values: closes, period: 14 });
  const expected = expArr[expArr.length - 1];

  let received = null;
  eventBus.once(EVENTS.INDICATORS_UPDATED, (d) => { received = d; });
  eventBus.emit(EVENTS.CANDLE_CLOSE_15M, candles[candles.length - 1]);

  assert(received !== null, 'INDICATORS_UPDATED not emitted');
  assert(received.indicators.rsi !== null, 'RSI should not be null with 20 candles');
  assert(
    Math.abs(received.indicators.rsi - expected) < 0.01,
    `RSI: got ${received.indicators.rsi}, expected ${expected}`
  );
});

// ── T21: EMA9 and EMA21 correct ───────────────────────────────────────────────
await test('T21 IndicatorEngine: EMA9 and EMA21 correct from known series', async () => {
  resetModules('./data/candle-builder', './data/indicator-engine');
  const cb  = require('./data/candle-builder');
  require('./data/indicator-engine');
  const eventBus = require('./core/event-bus');
  const EVENTS   = require('./core/events');
  const { EMA }  = require('technicalindicators');

  const closes = [24000,24050,24020,24080,24060,24100,24090,24130,24110,24150,
                  24140,24160,24130,24170,24155,24180,24160,24200,24185,24210,
                  24220,24200,24240];
  const candles = closes.map((c, i) => ({
    open: c - 10, high: c + 10, low: c - 20, close: c,
    volume: 1000, openTime: Date.now() + i * 900000,
  }));
  cb.seedBuffer(15, candles);

  const exp9  = EMA.calculate({ values: closes, period: 9 });
  const exp21 = EMA.calculate({ values: closes, period: 21 });

  let received = null;
  eventBus.once(EVENTS.INDICATORS_UPDATED, (d) => { received = d; });
  eventBus.emit(EVENTS.CANDLE_CLOSE_15M, candles[candles.length - 1]);

  assert(received !== null, 'INDICATORS_UPDATED not emitted');
  assert(
    Math.abs(received.indicators.ema9 - exp9[exp9.length - 1]) < 0.01,
    `EMA9: got ${received.indicators.ema9}, expected ${exp9[exp9.length - 1]}`
  );
  assert(
    Math.abs(received.indicators.ema21 - exp21[exp21.length - 1]) < 0.01,
    `EMA21: got ${received.indicators.ema21}, expected ${exp21[exp21.length - 1]}`
  );
});

// ── T22: MACD correct ─────────────────────────────────────────────────────────
await test('T22 IndicatorEngine: MACD correct from known series', async () => {
  resetModules('./data/candle-builder', './data/indicator-engine');
  const cb  = require('./data/candle-builder');
  require('./data/indicator-engine');
  const eventBus = require('./core/event-bus');
  const EVENTS   = require('./core/events');
  const { MACD } = require('technicalindicators');

  // Need 35+ candles for MACD(12,26,9)
  const closes = Array.from({ length: 40 }, (_, i) =>
    24000 + Math.sin(i * 0.3) * 200 + i * 5
  );
  const candles = closes.map((c, i) => ({
    open: c - 10, high: c + 15, low: c - 20, close: c,
    volume: 1000, openTime: Date.now() + i * 900000,
  }));
  cb.seedBuffer(15, candles);

  const macdArr = MACD.calculate({
    values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  const exp = macdArr[macdArr.length - 1];

  let received = null;
  eventBus.once(EVENTS.INDICATORS_UPDATED, (d) => { received = d; });
  eventBus.emit(EVENTS.CANDLE_CLOSE_15M, candles[candles.length - 1]);

  assert(received !== null, 'INDICATORS_UPDATED not emitted');
  assert(received.indicators.macd !== null, 'MACD should not be null with 40 candles');
  assert(
    Math.abs(received.indicators.macd.macd - exp.MACD) < 0.01,
    `MACD line mismatch`
  );
  assert(
    Math.abs(received.indicators.macd.signal - exp.signal) < 0.01,
    `MACD signal mismatch`
  );
});

// ── T23: Bollinger Band width correct ─────────────────────────────────────────
await test('T23 IndicatorEngine: Bollinger Band width correct', async () => {
  resetModules('./data/candle-builder', './data/indicator-engine');
  const cb  = require('./data/candle-builder');
  require('./data/indicator-engine');
  const eventBus        = require('./core/event-bus');
  const EVENTS          = require('./core/events');
  const { BollingerBands } = require('technicalindicators');

  const closes = Array.from({ length: 25 }, (_, i) =>
    24000 + Math.sin(i * 0.5) * 150
  );
  const candles = closes.map((c, i) => ({
    open: c - 5, high: c + 10, low: c - 10, close: c,
    volume: 1000, openTime: Date.now() + i * 900000,
  }));
  cb.seedBuffer(15, candles);

  const bbArr = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
  const expBb = bbArr[bbArr.length - 1];
  const expWidth = ((expBb.upper - expBb.lower) / expBb.middle) * 100;

  let received = null;
  eventBus.once(EVENTS.INDICATORS_UPDATED, (d) => { received = d; });
  eventBus.emit(EVENTS.CANDLE_CLOSE_15M, candles[candles.length - 1]);

  assert(received !== null, 'INDICATORS_UPDATED not emitted');
  assert(received.indicators.bb !== null, 'BB should not be null with 25 candles');
  assert(
    Math.abs(received.indicators.bb.width - expWidth) < 0.01,
    `BB width: got ${received.indicators.bb.width}, expected ${expWidth}`
  );
});

// ── T24: null when buffer too small (warm-up) ─────────────────────────────────
await test('T24 IndicatorEngine: returns null for all indicators when buffer < minimum', async () => {
  resetModules('./data/candle-builder', './data/indicator-engine');
  const cb = require('./data/candle-builder');
  require('./data/indicator-engine');
  const eventBus = require('./core/event-bus');
  const EVENTS   = require('./core/events');

  // Only 5 candles — below every indicator's minimum
  const candles = Array.from({ length: 5 }, (_, i) => ({
    open: 24000 + i, high: 24010 + i, low: 23990 + i,
    close: 24000 + i, volume: 1000, openTime: Date.now() + i * 900000,
  }));
  cb.seedBuffer(15, candles);

  let received = null;
  eventBus.once(EVENTS.INDICATORS_UPDATED, (d) => { received = d; });
  eventBus.emit(EVENTS.CANDLE_CLOSE_15M, candles[candles.length - 1]);

  assert(received !== null, 'INDICATORS_UPDATED must still be emitted during warm-up');
  assert(received.indicators.rsi  === null, 'RSI should be null  (need 14, have 5)');
  assert(received.indicators.macd === null, 'MACD should be null (need 35, have 5)');
  assert(received.indicators.bb   === null, 'BB should be null   (need 20, have 5)');
  assert(received.indicators.atr  === null, 'ATR should be null  (need 15, have 5)');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 2: Run — T20–T24 fail (module not yet created)**

```bash
node test-phase1.js
```

Expected: T16–T19 pass, T20–T24 fail with `Cannot find module './data/indicator-engine'`

- [ ] **Step 3: Create `data/indicator-engine.js`**

```javascript
/**
 * @file indicator-engine.js
 * @description Computes RSI, EMA, MACD, BB, ATR, ADX from candle buffers on every
 *              CANDLE_CLOSE_5M / CANDLE_CLOSE_15M event. Also computes Black-Scholes
 *              delta on OPTIONS_CHAIN_UPDATED. Emits INDICATORS_UPDATED.
 */

'use strict';

const { RSI, EMA, MACD, BollingerBands, ATR, ADX } = require('technicalindicators');
const bs          = require('black-scholes');
const eventBus    = require('../core/event-bus');
const EVENTS      = require('../core/events');
const candleBuilder = require('./candle-builder');

class IndicatorEngine {
  constructor() {
    this._lastOptionsChain = null;
    this._lastAtr          = null;
    this._hookEvents();
  }

  _hookEvents() {
    eventBus.on(EVENTS.CANDLE_CLOSE_5M,        () => this._compute(5));
    eventBus.on(EVENTS.CANDLE_CLOSE_15M,       () => this._compute(15));
    eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED,  (chain) => {
      this._lastOptionsChain = chain;
      this._computeDelta();
    });
  }

  _compute(timeframe) {
    const candles = candleBuilder.getBuffer(timeframe);
    const closes  = candles.map((c) => c.close);
    const highs   = candles.map((c) => c.high);
    const lows    = candles.map((c) => c.low);

    const indicators = {
      rsi:  this._rsi(closes),
      ema9: this._ema(closes, 9),
      ema21:this._ema(closes, 21),
      macd: null,
      bb:   null,
      atr:  null,
      adx:  null,
    };

    if (timeframe === 15) {
      indicators.macd = this._macd(closes);
      indicators.bb   = this._bb(closes);
      indicators.atr  = this._atr(highs, lows, closes);
      indicators.adx  = this._adx(highs, lows, closes);
      if (indicators.atr !== null) this._lastAtr = indicators.atr;
    }

    eventBus.emit(EVENTS.INDICATORS_UPDATED, {
      timeframe,
      timestamp: new Date().toISOString(),
      indicators,
    });
  }

  _rsi(closes) {
    if (closes.length < 14) return null;
    const r = RSI.calculate({ values: closes, period: 14 });
    return r.length ? r[r.length - 1] : null;
  }

  _ema(closes, period) {
    if (closes.length < period) return null;
    const r = EMA.calculate({ values: closes, period });
    return r.length ? r[r.length - 1] : null;
  }

  _macd(closes) {
    if (closes.length < 35) return null;
    const r = MACD.calculate({
      values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
    });
    if (!r.length) return null;
    const last = r[r.length - 1];
    return { macd: last.MACD, signal: last.signal, histogram: last.histogram };
  }

  _bb(closes) {
    if (closes.length < 20) return null;
    const r = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    if (!r.length) return null;
    const last  = r[r.length - 1];
    const width = last.middle > 0 ? ((last.upper - last.lower) / last.middle) * 100 : null;
    return { upper: last.upper, middle: last.middle, lower: last.lower, width };
  }

  _atr(highs, lows, closes) {
    if (closes.length < 15) return null;
    const r = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    return r.length ? r[r.length - 1] : null;
  }

  _adx(highs, lows, closes) {
    if (closes.length < 28) return null;
    const r = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    return r.length ? r[r.length - 1].adx : null;
  }

  _computeDelta() {
    const chain = this._lastOptionsChain;
    if (!chain || this._lastAtr === null) return;

    const S          = chain.underlyingValue;
    const r          = 0.065; // approximate Indian risk-free rate
    const msPerYear  = 365 * 24 * 60 * 60 * 1000;
    const T          = Math.max(
      (new Date(chain.expiry).getTime() - Date.now()) / msPerYear,
      0.001
    );
    // Annualised vol proxy: ATR/S × √(252 trading days × 25 bars/day at 15m)
    const sigma = (this._lastAtr / S) * Math.sqrt(252 * 25);

    // black-scholes package: bs.blackScholes(s,k,t,v,r,callPut) for price
    // Delta = dPrice/dS; approximate via finite difference if getDelta unavailable
    const callPrice = (strike) => bs.blackScholes(S, strike, T, sigma, r, 'call');
    const putPrice  = (strike) => bs.blackScholes(S, strike, T, sigma, r, 'put');
    const dS        = 1;
    const ceDelta   = (callPrice(chain.maxCeOiStrike) - bs.blackScholes(S - dS, chain.maxCeOiStrike, T, sigma, r, 'call')) / dS;
    const peDelta   = (putPrice(chain.maxPeOiStrike)  - bs.blackScholes(S - dS, chain.maxPeOiStrike,  T, sigma, r, 'put'))  / dS;

    eventBus.emit(EVENTS.INDICATORS_UPDATED, {
      timeframe:  'options',
      timestamp:  new Date().toISOString(),
      indicators: { ceDelta, peDelta },
    });
  }
}

module.exports = new IndicatorEngine();
```

- [ ] **Step 4: Run — T16–T24 all pass**

```bash
node test-phase1.js
```

Expected: `9 tests — 9 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add data/indicator-engine.js test-phase1.js
git commit -m "feat: add IndicatorEngine with T20-T24 passing"
```

---

## Task 4: SessionContext Phase 1 hooks + tests T25–T26

**Files:**
- Modify: `core/session-context.js`
- Modify: `test-phase1.js` (append T25–T26 before summary)

- [ ] **Step 1: Append T25–T26 to `test-phase1.js`** (insert before the summary block and `})()` at the end of the file)

```javascript
// ── T25: dayOpen set once, dayHigh/dayLow track running extremes ──────────────
await test('T25 SessionContext: dayOpen set on first tick only, high/low track all ticks', async () => {
  resetModules('./core/session-context');
  const eventBus = require('./core/event-bus');
  const EVENTS   = require('./core/events');
  const SessionContext = require('./core/session-context');
  const ctx = new SessionContext();

  eventBus.emit(EVENTS.TICK_RECEIVED, { ltp: 24100, volume: 100, timestamp: Date.now() });
  assert(ctx.snapshot().dayOpen === 24100, 'dayOpen should be 24100 after first tick');

  eventBus.emit(EVENTS.TICK_RECEIVED, { ltp: 24200, volume: 100, timestamp: Date.now() });
  assert(ctx.snapshot().dayOpen  === 24100, 'dayOpen must not change on second tick');
  assert(ctx.snapshot().dayHigh  === 24200, `dayHigh should be 24200, got ${ctx.snapshot().dayHigh}`);
  assert(ctx.snapshot().dayLow   === 24100, `dayLow should be 24100, got ${ctx.snapshot().dayLow}`);
});

// ── T26: firstHourComplete set at 10:15 IST candle ───────────────────────────
await test('T26 SessionContext: firstHourComplete set true at 10:15 IST candle close', async () => {
  resetModules('./core/session-context');
  const eventBus = require('./core/event-bus');
  const EVENTS   = require('./core/events');
  const SessionContext = require('./core/session-context');
  const ctx = new SessionContext();

  // 09:15 IST = 03:45 UTC
  const c0915 = {
    open: 24100, high: 24150, low: 24080, close: 24120, volume: 1000,
    openTime: new Date('2025-04-13T03:45:00.000Z').getTime(),
  };
  eventBus.emit(EVENTS.CANDLE_CLOSE_1M, c0915);
  assert(!ctx.snapshot().firstHourComplete, 'firstHourComplete must be false at 09:15');

  // 10:14 IST = 04:44 UTC
  const c1014 = {
    open: 24200, high: 24250, low: 24180, close: 24220, volume: 1000,
    openTime: new Date('2025-04-13T04:44:00.000Z').getTime(),
  };
  eventBus.emit(EVENTS.CANDLE_CLOSE_1M, c1014);
  assert(!ctx.snapshot().firstHourComplete, 'firstHourComplete must be false at 10:14');

  // 10:15 IST = 04:45 UTC — triggers completion
  const c1015 = {
    open: 24220, high: 24270, low: 24210, close: 24250, volume: 1000,
    openTime: new Date('2025-04-13T04:45:00.000Z').getTime(),
  };
  eventBus.emit(EVENTS.CANDLE_CLOSE_1M, c1015);
  assert(ctx.snapshot().firstHourComplete, 'firstHourComplete must be true at 10:15');

  // Verify firstHourHigh and firstHourLow were tracked
  const snap = ctx.snapshot();
  // c1015 is NOT in first-hour range (inFirstHour checks minute < 15, so 10:15 is excluded)
  // firstHourHigh = max(24150 from c0915, 24250 from c1014) = 24250
  assert(snap.firstHourHigh === 24250, `firstHourHigh: expected 24250, got ${snap.firstHourHigh}`);
  assert(snap.firstHourLow  === 24080, `firstHourLow: expected 24080, got ${snap.firstHourLow}`);
});
```

- [ ] **Step 2: Run — T25–T26 fail (hooks not yet wired)**

```bash
node test-phase1.js
```

Expected: T16–T24 pass, T25–T26 fail

- [ ] **Step 3: Wire `_hookEvents()` in `core/session-context.js`**

First, add `'use strict';` and the `dayjs` require at the top of the file after the existing `require` statements. Then replace the `_hookEvents()` stub and add `this._hookEvents()` to the constructor:

**Constructor change** (add the call):
```javascript
  constructor() {
    this._data = this._defaultData();
    this._hookEvents();
  }
```

**`_hookEvents()` implementation** (replace the stub body):
```javascript
  _hookEvents() {
    // IST offset helper — avoids timezone dependency on host machine
    const toIST = (ts) => {
      const istMs = ts + 5.5 * 60 * 60 * 1000;
      return {
        hour:   Math.floor((istMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)),
        minute: Math.floor((istMs % (60 * 60 * 1000))      / (60 * 1000)),
      };
    };

    eventBus.on(EVENTS.TICK_RECEIVED, ({ ltp }) => {
      if (this._data.dayOpen === null)                         this._data.dayOpen = ltp;
      if (this._data.dayHigh === null || ltp > this._data.dayHigh) this._data.dayHigh = ltp;
      if (this._data.dayLow  === null || ltp < this._data.dayLow)  this._data.dayLow  = ltp;
    });

    eventBus.on(EVENTS.CANDLE_CLOSE_1M, ({ openTime, high, low }) => {
      const { hour, minute } = toIST(openTime);
      // Track first-hour highs/lows for candles starting at 09:15–10:14 IST
      const inFirstHour = (hour === 9 && minute >= 15) || (hour === 10 && minute < 15);
      if (inFirstHour) {
        if (this._data.firstHourHigh === null || high > this._data.firstHourHigh)
          this._data.firstHourHigh = high;
        if (this._data.firstHourLow  === null || low  < this._data.firstHourLow)
          this._data.firstHourLow  = low;
      }
      // Mark first hour complete when the 10:15 IST candle closes
      if (hour === 10 && minute === 15) this._data.firstHourComplete = true;
    });

    eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED, ({ vix }) => {
      if (this._data.vixAtOpen === null) this._data.vixAtOpen = vix;
      this._data.vixCurrent = vix;
    });
  }
```

- [ ] **Step 4: Run — T16–T26 all pass**

```bash
node test-phase1.js
```

Expected: `11 tests — 11 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add core/session-context.js test-phase1.js
git commit -m "feat: wire SessionContext Phase 1 hooks with T25-T26 passing"
```

---

## Task 5: Historical fetch + test T27

**Files:**
- Create: `data/historical.js`
- Modify: `test-phase1.js` (append T27 before summary)

- [ ] **Step 1: Append T27 to `test-phase1.js`** (insert before the summary block and `})()` at the end of the file)

```javascript
// ── T27: Historical falls back to cache when HTTP sources fail ────────────────
await test('T27 Historical: seeds CandleBuilder from cache when HTTP sources fail', async () => {
  const fs   = require('fs');
  const path = require('path');

  resetModules('./data/historical', './data/candle-builder');
  const eventBus = require('./core/event-bus');
  const EVENTS   = require('./core/events');
  const cb       = require('./data/candle-builder');

  // Write a known fake cache file
  const cachePath = path.join(__dirname, 'data/cache/nifty-15m.json');
  const fakeCandles = Array.from({ length: 10 }, (_, i) => ({
    open: 24000 + i, high: 24010 + i, low: 23990 + i,
    close: 24000 + i, volume: 1000,
    openTime: Date.now() - (10 - i) * 900000,
  }));
  fs.writeFileSync(cachePath, JSON.stringify(fakeCandles));

  // Load historical with a fake HTTP client that always rejects
  const historical = require('./data/historical');
  historical._http = { get: () => Promise.reject(new Error('Simulated network failure')) };

  let seeded = 0;
  const origSeed = cb.seedBuffer.bind(cb);
  cb.seedBuffer = (tf, candles) => {
    if (tf === 15) seeded = candles.length;
    origSeed(tf, candles);
  };

  await historical.fetch();

  cb.seedBuffer = origSeed;
  fs.unlinkSync(cachePath);

  assert(seeded === 10, `Expected 10 candles seeded from cache, got ${seeded}`);
});
```

- [ ] **Step 2: Run — T27 fails (module not yet created)**

```bash
node test-phase1.js
```

Expected: T16–T26 pass, T27 fails with `Cannot find module './data/historical'`

- [ ] **Step 3: Create `data/historical.js`**

```javascript
/**
 * @file historical.js
 * @description Fetches STARTUP_CANDLE_COUNT candles of 15m NIFTY data at boot.
 *              Tries NSE India → Yahoo Finance → local cache in order.
 *              Seeds CandleBuilder buffers before the WebSocket starts.
 *              Emits HISTORICAL_DATA_LOADED on success, STARTUP_DATA_FAILED if all fail.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const config   = require('../config');

const CACHE_PATH = path.join(__dirname, 'cache/nifty-15m.json');
const COUNT      = config.STARTUP_CANDLE_COUNT; // 50

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [Historical] [${level}] ${msg}`);
}

class Historical {
  constructor() {
    // Injected in tests to simulate HTTP failures without live network calls
    this._http = axios;
  }

  async fetch() {
    let candles = null;

    // Source 1: NSE India
    try {
      candles = await this._fetchFromNSE();
      log('INFO', `Loaded ${candles.length} candles from NSE India`);
      this._writeCache(candles);
    } catch (err) {
      log('WARN', `NSE India failed: ${err.message}`);
    }

    // Source 2: Yahoo Finance
    if (!candles) {
      try {
        candles = await this._fetchFromYahoo();
        log('INFO', `Loaded ${candles.length} candles from Yahoo Finance`);
        this._writeCache(candles);
      } catch (err) {
        log('WARN', `Yahoo Finance failed: ${err.message}`);
      }
    }

    // Source 3: local cache
    if (!candles) {
      try {
        candles = this._readCache();
        log('WARN', `Using stale local cache (${candles.length} candles) — live sources unavailable`);
      } catch (err) {
        log('ERROR', `Local cache unavailable: ${err.message}`);
      }
    }

    if (!candles) {
      log('ERROR', 'All historical sources failed — indicators will warm up from live candles');
      eventBus.emit(EVENTS.STARTUP_DATA_FAILED, { reason: 'all sources unavailable' });
      return;
    }

    // Seed the candle builder with 15m history
    const candleBuilder = require('./candle-builder');
    candleBuilder.seedBuffer(15, candles.slice(-COUNT));
    eventBus.emit(EVENTS.HISTORICAL_DATA_LOADED, { count: candles.length, timeframe: 15 });
  }

  async _fetchFromNSE() {
    // Step 1: acquire session cookie
    await this._http.get('https://www.nseindia.com', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
      timeout: 10000,
    });

    // Step 2: fetch chart data
    const res = await this._http.get(
      'https://www.nseindia.com/api/chart-databyindex?index=NIFTY50&indices=true',
      {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer':    'https://www.nseindia.com',
        },
        timeout: 10000,
      }
    );

    // NSE chart response: { grapthData: [[timestamp_ms, close], ...] }
    const raw = res.data.grapthData || res.data.data;
    if (!Array.isArray(raw) || raw.length === 0) throw new Error('Empty NSE response');

    return this._resampleTo15m(raw.map(([ts, close]) => ({
      open: close, high: close, low: close, close, volume: 0, openTime: ts,
    })));
  }

  async _fetchFromYahoo() {
    const res = await this._http.get(
      'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=15m&range=2d',
      { timeout: 10000 }
    );

    const chart = res.data.chart.result[0];
    const timestamps = chart.timestamp;
    const ohlcv      = chart.indicators.quote[0];

    return timestamps.map((ts, i) => ({
      open:     ohlcv.open[i]   || ohlcv.close[i],
      high:     ohlcv.high[i]   || ohlcv.close[i],
      low:      ohlcv.low[i]    || ohlcv.close[i],
      close:    ohlcv.close[i],
      volume:   ohlcv.volume[i] || 0,
      openTime: ts * 1000,
    })).filter((c) => c.close != null);
  }

  _readCache() {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const candles = JSON.parse(raw);
    if (!Array.isArray(candles) || candles.length === 0) throw new Error('Empty cache');
    return candles;
  }

  _writeCache(candles) {
    try {
      fs.writeFileSync(CACHE_PATH, JSON.stringify(candles));
    } catch (err) {
      log('WARN', `Cache write failed: ${err.message}`);
    }
  }

  // Converts 1m-resolution NSE data into 15m candles
  _resampleTo15m(candles1m) {
    const buckets = {};
    for (const c of candles1m) {
      const key = Math.floor(c.openTime / (15 * 60 * 1000)) * (15 * 60 * 1000);
      if (!buckets[key]) {
        buckets[key] = { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, openTime: key };
      } else {
        if (c.high  > buckets[key].high) buckets[key].high  = c.high;
        if (c.low   < buckets[key].low)  buckets[key].low   = c.low;
        buckets[key].close   = c.close;
        buckets[key].volume += c.volume;
      }
    }
    return Object.values(buckets).sort((a, b) => a.openTime - b.openTime);
  }
}

module.exports = new Historical();
```

- [ ] **Step 4: Run — T16–T27 all pass**

```bash
node test-phase1.js
```

Expected: `12 tests — 12 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add data/historical.js test-phase1.js
git commit -m "feat: add Historical with NSE/Yahoo/cache fallback and T27 passing"
```

---

## Task 6: OptionsChain + test T28

**Files:**
- Create: `data/options-chain.js`
- Modify: `test-phase1.js` (append T28 before summary)

- [ ] **Step 1: Append T28 to `test-phase1.js`** (insert before the summary block and `})()` at the end of the file)

```javascript
// ── T28: OptionsChain parser produces correct shape from fake NSE response ────
await test('T28 OptionsChain: _parseOptionChain() produces correct shape from fake NSE JSON', async () => {
  resetModules('./data/options-chain');
  const oc = require('./data/options-chain');

  // Minimal fake NSE option chain response
  const fakeNSE = {
    records: {
      underlyingValue: 24185.3,
      expiryDates: ['24-Apr-2025', '01-May-2025'],
      data: [
        { expiryDate: '24-Apr-2025', strikePrice: 24000, CE: { openInterest: 50000, impliedVolatility: 12 }, PE: { openInterest: 30000, impliedVolatility: 11 } },
        { expiryDate: '24-Apr-2025', strikePrice: 24500, CE: { openInterest: 120000, impliedVolatility: 10 }, PE: { openInterest: 20000, impliedVolatility: 10 } },
        { expiryDate: '24-Apr-2025', strikePrice: 23800, CE: { openInterest: 15000, impliedVolatility: 13 }, PE: { openInterest: 110000, impliedVolatility: 12 } },
        { expiryDate: '01-May-2025', strikePrice: 24500, CE: { openInterest: 80000, impliedVolatility: 11 }, PE: { openInterest: 60000, impliedVolatility: 11 } },
      ],
    },
    filtered: {
      CE: { totOI: 185000 },
      PE: { totOI: 160000 },
    },
  };

  const result = oc._parseOptionChain(fakeNSE);

  assert(result.symbol          === 'NIFTY',     'symbol should be NIFTY');
  assert(result.expiry          === '24-Apr-2025','expiry should be nearest weekly');
  assert(result.underlyingValue === 24185.3,      'underlyingValue should match');
  assert(result.maxCeOiStrike   === 24500,        `maxCeOiStrike: expected 24500, got ${result.maxCeOiStrike}`);
  assert(result.maxPeOiStrike   === 23800,        `maxPeOiStrike: expected 23800, got ${result.maxPeOiStrike}`);
  assert(typeof result.pcr      === 'number',     'pcr should be a number');
  assert(result.pcr > 0,                          'pcr should be positive');
  assert(typeof result.timestamp === 'string',    'timestamp should be a string');
});
```

- [ ] **Step 2: Run — T28 fails (module not yet created)**

```bash
node test-phase1.js
```

Expected: T16–T27 pass, T28 fails with `Cannot find module './data/options-chain'`

- [ ] **Step 3: Create `data/options-chain.js`**

```javascript
/**
 * @file options-chain.js
 * @description Fetches NSE NIFTY option chain every OPTIONS_CHAIN_INTERVAL minutes
 *              during market hours. Handles cookie refresh with one silent retry.
 *              Emits OPTIONS_CHAIN_UPDATED on success, OPTIONS_CHAIN_STALE on double failure.
 */

'use strict';

const cron     = require('node-cron');
const axios    = require('axios');
const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const config   = require('../config');

const NSE_BASE     = 'https://www.nseindia.com';
const NSE_CHAIN    = `${NSE_BASE}/api/option-chain-indices?symbol=NIFTY`;
const UA           = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Market hours in UTC (IST - 5:30)
const MARKET_OPEN_UTC_H  = 3;  // 09:15 IST
const MARKET_OPEN_UTC_M  = 45;
const MARKET_CLOSE_UTC_H = 10; // 15:30 IST
const MARKET_CLOSE_UTC_M = 0;

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [OptionsChain] [${level}] ${msg}`);
}

class OptionsChain {
  constructor() {
    this._cookie           = null;
    this._lastGoodResult   = null;
    this._lastGoodAt       = null;
  }

  start() {
    // Run every 15 minutes on weekdays; handler checks market hours internally
    cron.schedule(`*/${config.OPTIONS_CHAIN_INTERVAL} * * * 1-5`, () => this._tick());
    log('INFO', `Polling every ${config.OPTIONS_CHAIN_INTERVAL}m on weekdays`);
  }

  async _tick() {
    if (!this._isDuringMarketHours()) return;
    await this._fetchWithRetry();
  }

  _isDuringMarketHours() {
    const now = new Date();
    const h   = now.getUTCHours();
    const m   = now.getUTCMinutes();
    const after  = h > MARKET_OPEN_UTC_H  || (h === MARKET_OPEN_UTC_H  && m >= MARKET_OPEN_UTC_M);
    const before = h < MARKET_CLOSE_UTC_H || (h === MARKET_CLOSE_UTC_H && m <= MARKET_CLOSE_UTC_M);
    return after && before;
  }

  async _fetchWithRetry() {
    try {
      const raw    = await this._fetchFromNSE();
      const result = this._parseOptionChain(raw);
      this._lastGoodResult = result;
      this._lastGoodAt     = Date.now();
      eventBus.emit(EVENTS.OPTIONS_CHAIN_UPDATED, result);
    } catch (firstErr) {
      log('WARN', `First attempt failed (${firstErr.message}), refreshing cookie and retrying`);
      this._cookie = null; // force cookie refresh on retry
      try {
        const raw    = await this._fetchFromNSE();
        const result = this._parseOptionChain(raw);
        this._lastGoodResult = result;
        this._lastGoodAt     = Date.now();
        eventBus.emit(EVENTS.OPTIONS_CHAIN_UPDATED, result);
      } catch (secondErr) {
        log('ERROR', `Both attempts failed: ${secondErr.message}`);
        eventBus.emit(EVENTS.OPTIONS_CHAIN_STALE, {
          reason:            secondErr.message,
          lastGoodTimestamp: this._lastGoodAt,
        });
      }
    }
  }

  async _fetchFromNSE() {
    if (!this._cookie) {
      const r = await axios.get(NSE_BASE, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        timeout: 8000,
      });
      this._cookie = (r.headers['set-cookie'] || []).join('; ');
    }

    const res = await axios.get(NSE_CHAIN, {
      headers: {
        'User-Agent': UA,
        'Referer':    NSE_BASE,
        'Cookie':     this._cookie,
      },
      timeout: 10000,
    });

    if (!res.data || !res.data.records) throw new Error('Malformed NSE response');
    return res.data;
  }

  // Pure parser — testable without any HTTP calls
  _parseOptionChain(raw) {
    const records = raw.records;
    const expiry  = records.expiryDates[0]; // nearest expiry

    const legs = records.data.filter((d) => d.expiryDate === expiry);

    let maxCeOI = 0, maxCeStrike = 0;
    let maxPeOI = 0, maxPeStrike = 0;

    for (const leg of legs) {
      if (leg.CE && leg.CE.openInterest > maxCeOI) {
        maxCeOI = leg.CE.openInterest; maxCeStrike = leg.strikePrice;
      }
      if (leg.PE && leg.PE.openInterest > maxPeOI) {
        maxPeOI = leg.PE.openInterest; maxPeStrike = leg.strikePrice;
      }
    }

    const totalCeOI = raw.filtered.CE.totOI || 1;
    const totalPeOI = raw.filtered.PE.totOI || 0;
    const pcr       = totalPeOI / totalCeOI;

    // ATM = nearest strike to underlying
    const underlying = records.underlyingValue;
    const strikes    = [...new Set(legs.map((l) => l.strikePrice))].sort((a, b) => a - b);
    const atmStrike  = strikes.reduce((prev, curr) =>
      Math.abs(curr - underlying) < Math.abs(prev - underlying) ? curr : prev
    );

    return {
      symbol:          'NIFTY',
      expiry,
      underlyingValue: underlying,
      vix:             records.vix || null,
      pcr:             Math.round(pcr * 1000) / 1000,
      maxCeOiStrike:   maxCeStrike,
      maxPeOiStrike:   maxPeStrike,
      atmStrike,
      timestamp:       new Date().toISOString(),
    };
  }
}

module.exports = new OptionsChain();
```

- [ ] **Step 4: Run — all 13 tests pass**

```bash
node test-phase1.js
```

Expected: `13 tests — 13 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add data/options-chain.js test-phase1.js
git commit -m "feat: add OptionsChain with NSE parser and T28 passing"
```

---

## Task 7: TickStream (Dhan WebSocket + token renewal)

No automated tests — verified manually when the Dhan WebSocket is live.

**Files:**
- Create: `data/tick-stream.js`

- [ ] **Step 1: Create `data/tick-stream.js`**

```javascript
/**
 * @file tick-stream.js
 * @description Connects to Dhan WebSocket feed for NIFTY live ticks.
 *              Emits TICK_RECEIVED on every price update.
 *              Handles reconnects with exponential backoff.
 *              Renews Dhan access token proactively 1 hour before expiry.
 *
 * NOTE: Dhan WebSocket binary packet format — verify byte offsets against
 * https://dhanhq.co/docs/v2/live-market-feed/ if ticks appear malformed.
 */

'use strict';

const WebSocket = require('ws');
const axios     = require('axios');
const eventBus  = require('../core/event-bus');
const EVENTS    = require('../core/events');
const config    = require('../config');

// NIFTY 50 index on Dhan: ExchangeSegment IDX_I, SecurityId 13
const NIFTY_SECURITY_ID  = '13';
const NIFTY_EXCHANGE_SEG = 'IDX_I';
const WS_URL             = 'wss://api-feed.dhan.co';
const DHAN_RENEW_URL     = 'https://api.dhan.co/v2/RenewToken';

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]; // exponential backoff
const HEARTBEAT_INTERVAL  = 30000; // 30s
const MAX_RECONNECT_TRIES = 5;

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [TickStream] [${level}] ${msg}`);
}

class TickStream {
  constructor() {
    this._ws              = null;
    this._reconnectCount  = 0;
    this._heartbeatTimer  = null;
    this._renewalTimer    = null;
    this._accessToken     = config.DHAN_ACCESS_TOKEN;
  }

  start() {
    this._scheduleTokenRenewal();
    this._connect();
  }

  stop() {
    clearTimeout(this._renewalTimer);
    clearInterval(this._heartbeatTimer);
    if (this._ws) this._ws.terminate();
  }

  _connect() {
    const url = `${WS_URL}?version=2&token=${this._accessToken}&clientId=${config.DHAN_CLIENT_ID}&authType=2`;
    this._ws  = new WebSocket(url);

    this._ws.on('open',    ()      => this._onOpen());
    this._ws.on('message', (data)  => this._onMessage(data));
    this._ws.on('close',   (code)  => this._onClose(code));
    this._ws.on('error',   (err)   => log('ERROR', `WebSocket error: ${err.message}`));
  }

  _onOpen() {
    log('INFO', 'WebSocket connected');
    this._reconnectCount = 0;
    this._startHeartbeat();
    this._subscribe();
    eventBus.emit(EVENTS.WEBSOCKET_CONNECTED, { timestamp: Date.now() });
  }

  _subscribe() {
    const msg = JSON.stringify({
      RequestCode:     15,
      InstrumentCount: 1,
      InstrumentList:  [{ ExchangeSegment: NIFTY_EXCHANGE_SEG, SecurityId: NIFTY_SECURITY_ID }],
    });
    this._ws.send(msg);
    log('INFO', 'Subscribed to NIFTY feed');
  }

  _onMessage(data) {
    // Dhan sends binary packets for market data.
    // Packet layout (LTP mode, RequestCode 15):
    //   Byte  0:     Feed Request Code (uint8)
    //   Byte  1:     Message Length    (uint8)
    //   Bytes 2–5:   Security ID       (uint32 BE)
    //   Bytes 6–9:   LTP × 100         (uint32 BE — divide by 100 to get price)
    //   Bytes 10–13: Volume            (uint32 BE)
    //   Bytes 14–17: Unix timestamp    (uint32 BE — seconds)
    // Verify against Dhan API docs if prices appear incorrect.
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length < 18) return; // skip handshake/auth frames

      const ltp       = buf.readUInt32BE(6) / 100;
      const volume    = buf.readUInt32BE(10);
      const timestamp = buf.readUInt32BE(14) * 1000; // convert to ms

      if (ltp <= 0) return; // filter invalid frames

      eventBus.emit(EVENTS.TICK_RECEIVED, {
        symbol: 'NIFTY',
        ltp,
        volume,
        timestamp,
      });
    } catch (err) {
      log('WARN', `Failed to parse tick: ${err.message}`);
    }
  }

  _onClose(code) {
    clearInterval(this._heartbeatTimer);
    log('WARN', `WebSocket closed (code ${code})`);
    eventBus.emit(EVENTS.WEBSOCKET_DISCONNECTED, { code, timestamp: Date.now() });
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectCount >= MAX_RECONNECT_TRIES) {
      log('ERROR', `Failed to reconnect after ${MAX_RECONNECT_TRIES} attempts`);
      eventBus.emit(EVENTS.WEBSOCKET_RECONNECT_FAILED, { timestamp: Date.now() });
      return;
    }
    const delayMs = RECONNECT_DELAYS_MS[this._reconnectCount] || 30000;
    log('INFO', `Reconnecting in ${delayMs / 1000}s (attempt ${this._reconnectCount + 1})`);
    setTimeout(() => {
      this._reconnectCount++;
      this._connect();
    }, delayMs);
  }

  _startHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.ping();
      }
    }, HEARTBEAT_INTERVAL);
  }

  _scheduleTokenRenewal() {
    // Dhan token expiry is not returned in any field — assume 23h validity
    // and renew 1h before that (i.e., 22h after start or last renewal).
    const renewAfterMs = 22 * 60 * 60 * 1000;
    this._renewalTimer = setTimeout(() => this._renewToken(), renewAfterMs);
    log('INFO', 'Token renewal scheduled in 22h');
  }

  async _renewToken() {
    try {
      const res = await axios.post(
        DHAN_RENEW_URL,
        { token: this._accessToken },
        { headers: { 'access-token': this._accessToken, 'dhan-client-id': config.DHAN_CLIENT_ID } }
      );
      this._accessToken = res.data.accessToken || res.data.token || this._accessToken;
      log('INFO', 'Access token renewed successfully');
      // Reconnect WebSocket with new token
      if (this._ws) this._ws.terminate();
      this._connect();
      // Schedule next renewal
      this._scheduleTokenRenewal();
    } catch (err) {
      log('ERROR', `Token renewal failed: ${err.message} — WebSocket will use current token`);
      eventBus.emit(EVENTS.WEBSOCKET_RECONNECT_FAILED, {
        reason: `token renewal failed: ${err.message}`,
        timestamp: Date.now(),
      });
    }
  }
}

module.exports = new TickStream();
```

- [ ] **Step 2: Verify module loads without error**

```bash
node -e "require('./data/tick-stream'); console.log('tick-stream loaded OK')"
```

Expected: `tick-stream loaded OK` (no errors)

- [ ] **Step 3: Run full test suite — still 13 passing**

```bash
node test-phase1.js
```

Expected: `13 tests — 13 passed, 0 failed`

- [ ] **Step 4: Commit**

```bash
git add data/tick-stream.js
git commit -m "feat: add TickStream with Dhan WebSocket reconnect and proactive token renewal"
```

---

## Task 8: index.js Phase 1 boot integration

**Files:**
- Modify: `index.js`

- [ ] **Step 1: Add Phase 1 boot steps to `index.js`**

Find the comment `// Phase 1: init tick stream, historical fetch, options chain, indicator engine` and replace the entire comment block with actual boot steps:

```javascript
  // ── Phase 1: Data layer ───────────────────────────────────────────────────
  const historical    = require('./data/historical');
  const optionsChain  = require('./data/options-chain');
  const tickStream    = require('./data/tick-stream');
  require('./data/candle-builder');   // wires TICK_RECEIVED listener
  require('./data/indicator-engine'); // wires CANDLE_CLOSE_* listeners

  // Step 6a: Fetch startup candle history (seeds CandleBuilder before WebSocket opens)
  await historical.fetch();
  log('INFO', 'Historical', 'Startup candles loaded');

  // Step 6b: Start options chain polling
  optionsChain.start();
  log('INFO', 'OptionsChain', `Polling every ${config.OPTIONS_CHAIN_INTERVAL}m`);

  // Step 6c: Connect to Dhan WebSocket (starts emitting TICK_RECEIVED)
  tickStream.start();
  log('INFO', 'TickStream', 'Dhan WebSocket connecting...');
```

Also renumber the SYSTEM_READY step comment from `Step 6` to `Step 7`:
```javascript
  // ── Step 7: System ready ──────────────────────────────────────────────────
```

- [ ] **Step 2: Run the test suite — all 13 still pass**

```bash
node test-phase1.js
```

Expected: `13 tests — 13 passed, 0 failed`

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: wire Phase 1 data layer into index.js boot sequence"
```

---

## Task 9: Final verification and PHASE_1_COMPLETE.md

**Files:**
- Create: `PHASE_1_COMPLETE.md`

- [ ] **Step 1: Run complete test suite (Phase 0 + Phase 1)**

```bash
node test-phase0.js && node test-phase1.js
```

Expected:
```
16 tests — 16 passed, 0 failed   ← Phase 0 unchanged
13 tests — 13 passed, 0 failed   ← Phase 1 new
```

- [ ] **Step 2: Create `PHASE_1_COMPLETE.md`**

```markdown
# Phase 1 Complete — Data Layer

## What Was Built

The full data pipeline. Live NIFTY ticks flow from the Dhan WebSocket into candle
buffers, indicator computation, and session context. NSE option chain polls every
15 minutes. All Phase 2 rule engine inputs are available via event bus.

---

## Files Created

### data/
| File | What it does |
|------|-------------|
| `tick-stream.js` | Dhan WebSocket feed. Emits TICK_RECEIVED. Reconnects with backoff. Renews token proactively every 22h. |
| `candle-builder.js` | Aggregates ticks → 1m/5m/15m OHLCV. Rolling buffer of 200 candles. Epoch-based boundaries (timezone-safe). |
| `indicator-engine.js` | RSI(14), EMA9/21, MACD(12,26,9), BB(20), ATR(14), ADX(14) via technicalindicators. Black-Scholes delta via finite diff. Returns null during warm-up. |
| `historical.js` | Boot-time 15m candle fetch: NSE India → Yahoo Finance → local cache. Seeds CandleBuilder before WebSocket starts. |
| `options-chain.js` | NSE option chain every 15m. Cookie auto-refresh with one silent retry. Parses PCR, max OI strikes, ATM strike. |
| `cache/.gitkeep` | Cache directory for nifty-15m.json (git-ignored). |

### Modified
| File | What changed |
|------|-------------|
| `core/session-context.js` | `_hookEvents()` wired: dayOpen/High/Low from ticks, firstHour from 1m candles, VIX from options chain. Constructor now calls `_hookEvents()`. |
| `config.js` | Added `STARTUP_CANDLE_COUNT: 50`. |
| `index.js` | Phase 1 boot steps: historical.fetch(), optionsChain.start(), tickStream.start(). |

---

## How to Run

```bash
# Run Phase 1 tests (no live APIs needed)
npm run test:phase1

# Run all tests
node test-phase0.js && node test-phase1.js

# Boot full app (requires .env with Dhan + Telegram + Anthropic keys)
npm start
```

---

## Test Results

```
13 tests — 13 passed, 0 failed

T16  CandleBuilder: tick sequence → correct 1m OHLCV
T17  CandleBuilder: CANDLE_CLOSE_1M fires at each minute boundary
T18  CandleBuilder: 5m and 15m candle boundaries align correctly
T19  CandleBuilder: buffer capped at 200, oldest entry dropped
T20  IndicatorEngine: RSI correct from known price series
T21  IndicatorEngine: EMA9 and EMA21 correct from known series
T22  IndicatorEngine: MACD correct from known series
T23  IndicatorEngine: Bollinger Band width correct
T24  IndicatorEngine: returns null for all indicators when buffer < minimum
T25  SessionContext: dayOpen set on first tick only, high/low track all ticks
T26  SessionContext: firstHourComplete set true at 10:15 IST candle close
T27  Historical: seeds CandleBuilder from cache when HTTP sources fail
T28  OptionsChain: _parseOptionChain() produces correct shape from fake NSE JSON
```

---

## Known Limitations (By Design)

- `tick-stream.js` Dhan binary packet offsets need live verification against actual feed
- NSE option chain `vix` field may be null (NSE sometimes omits it — Phase 2 can fall back to VIX index API)
- `currentRegime` stays null — Phase 2 rule engine sets it from indicators
- Token expiry timestamp not returned by Dhan — renewal scheduled at fixed 22h interval
- No crash recovery yet — pnlToday/tradesToday reset to 0 on restart (Phase 2 reads journal on boot)

---

## What Phase 2 Will Add

- `strategies/iron-condor.strategy.js` — full IC strategy consuming Phase 1 events
- `intelligence/` — Claude client, prompt builder, strategy selector
- `execution/paper-executor.js` — simulated fills with slippage
- `monitoring/` — position tracker, anti-hunt rules
- `notifications/telegram.js` — Telegram bot commands + trade approvals
- `journal/trade-journal.js` — append-only NDJSON writer
- `dashboard/` — Express + SSE live dashboard
```

- [ ] **Step 3: Add `test:phase1` script to `package.json` if not present**

Check `package.json` scripts. If `"test:phase1"` is missing, add it:
```json
"test:phase1": "node test-phase1.js"
```

- [ ] **Step 4: Final commit**

```bash
git add PHASE_1_COMPLETE.md package.json
git commit -m "feat: Phase 1 complete — data layer with 13/13 tests passing"
```
