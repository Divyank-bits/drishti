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

// ── T27: Historical falls back to cache when HTTP sources fail ────────────────
await test('T27 Historical: seeds CandleBuilder from cache when HTTP sources fail', async () => {
  const fs   = require('fs');
  const path = require('path');

  resetModules('./data/historical', './data/candle-builder');
  const cb = require('./data/candle-builder');

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

// ── T28: OptionsChain parser produces correct shape from fake NSE response ────
await test('T28 OptionsChain: _parseOptionChain() produces correct shape from fake NSE JSON', async () => {
  resetModules('./data/options-chain');
  const oc = require('./data/options-chain');

  // Fake NSE response matching stock-nse-india library shape:
  // filtered.data = pre-filtered legs for the nearest expiry
  const fakeNSE = {
    records: {
      underlyingValue: 24185.3,
      expiryDates: ['24-Apr-2025', '01-May-2025'],
    },
    filtered: {
      data: [
        { strikePrice: 24000, CE: { openInterest: 50000, impliedVolatility: 12, lastPrice: 150.5 }, PE: { openInterest: 30000, impliedVolatility: 11, lastPrice: 120.3 } },
        { strikePrice: 24500, CE: { openInterest: 120000, impliedVolatility: 10, lastPrice: 85.0 }, PE: { openInterest: 20000, impliedVolatility: 10, lastPrice: 200.0 } },
        { strikePrice: 23800, CE: { openInterest: 15000, impliedVolatility: 13, lastPrice: 210.0 }, PE: { openInterest: 110000, impliedVolatility: 12, lastPrice: 75.5 } },
      ],
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
  assert(typeof result.strikeData === 'object', 'strikeData is object');
  assert(result.strikeData[24000] !== undefined, 'strikeData has strike 24000');
  assert(result.strikeData[24000].ce === 150.5, 'strikeData CE price correct');
  assert(result.strikeData[24000].pe === 120.3, 'strikeData PE price correct');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

})(); // end async IIFE
