# Phase 1 — Data Layer Design

**Date:** 2026-04-13  
**Project:** Drishti — Local AI-powered NIFTY options trading system  
**Phase:** 1 of 5  
**Status:** Approved, pending implementation

---

## Context

Phase 0 built the architectural skeleton: event bus, state machine, circuit breakers, session context, strategy registry. Phase 1 adds the data layer — everything needed to get live market data flowing through the event pipeline before any trading logic runs.

Phase 0 gate: 16/16 tests pass. Dhan API connectivity confirmed. Telegram two-way messaging confirmed.

---

## Decisions Made

| Question | Decision |
|----------|----------|
| Regime classification | Left `null` in Phase 1. Phase 2 rule engine sets it. |
| Startup historical depth | 50 candles of 15m data (`STARTUP_CANDLE_COUNT`), config-driven for future bump |
| Token renewal | Proactive cron 1h before expiry — no reactive retry loop |
| NSE cookie failure | Silent single retry, then `OPTIONS_CHAIN_STALE` + Telegram alert |
| Options chain source | NSE India primary, clean `_fetchFromNSE()` interface for future Dhan swap |
| Tick source | NSE LTP polling (Phase 1). `DATA_SOURCE` flag is independent of `EXECUTION_MODE` — enables paper trading with Dhan live data in Phase 3 pre-live validation. |
| Test strategy | Synthetic tick injection only — no live API mocks |

---

## Architecture

Pure event chain. No cross-module function calls. All coupling is through the event bus.

```
BOOT
 └─ historical.js ──────────────────────► HISTORICAL_DATA_LOADED
      NSE India → Yahoo Finance → local cache
      Fetches STARTUP_CANDLE_COUNT (50) × 15m candles
      Seeds CandleBuilder buffers before WebSocket connects
      Writes successful fetch to data/cache/nifty-15m.json

MARKET OPEN
 └─ tick-stream.js (factory — loads source from DATA_SOURCE config)
      │  DATA_SOURCE=NSE  → data/sources/nse-source.js  (Phase 1: polls NSE LTP every 3s)
      │  DATA_SOURCE=DHAN → data/sources/dhan-source.js (Phase 3: Dhan WebSocket)
      │  emits TICK_RECEIVED {symbol, ltp, timestamp, volume}
      │
      ▼
 candle-builder.js  (listens: TICK_RECEIVED)
      │  rolling buffers: 1m[200], 5m[200], 15m[200]
      │  emits CANDLE_CLOSE_1M / CANDLE_CLOSE_5M / CANDLE_CLOSE_15M
      │         {open, high, low, close, volume, timestamp}
      ▼
 indicator-engine.js  (listens: CANDLE_CLOSE_*)
      │  RSI(14), EMA9, EMA21, MACD(12,26,9), BB(20), ATR(14), ADX(14)
      │  emits INDICATORS_UPDATED {timeframe, indicators{}, timestamp}
      ▼
 session-context.js  (listens: TICK_RECEIVED, CANDLE_CLOSE_1M,
                               INDICATORS_UPDATED, OPTIONS_CHAIN_UPDATED)
      updates: dayOpen/High/Low, firstHourHigh/Low/Complete, vixAtOpen/Current

 options-chain.js  (independent cron — every 15m, market hours only)
      NSE cookie refresh: silent single retry on failure
      emits OPTIONS_CHAIN_UPDATED {pcr, maxCeOiStrike, maxPeOiStrike,
                                    atmStrike, vix, underlyingValue, timestamp}
      emits OPTIONS_CHAIN_STALE on double failure
```

---

## Files

### `data/tick-stream.js`

Factory module. Loads the correct source based on `DATA_SOURCE` config. Emits no events itself — delegates entirely to the source module.

```js
// tick-stream.js
if (config.DATA_SOURCE === 'DHAN') {
  module.exports = require('./sources/dhan-source'); // Phase 3
} else {
  module.exports = require('./sources/nse-source');  // Phase 1 default
}
```

**Emitted events (via source):** `TICK_RECEIVED`, `WEBSOCKET_CONNECTED`, `WEBSOCKET_DISCONNECTED`, `WEBSOCKET_RECONNECTED`, `WEBSOCKET_RECONNECT_FAILED`

---

### `data/sources/nse-source.js` (Phase 1)

Polls NSE for NIFTY LTP every 3 seconds during market hours (09:15–15:30 IST). Uses the same NSE session cookie mechanism as `options-chain.js`. Emits `TICK_RECEIVED` on each successful poll.

**Poll behavior:**
- `setInterval` at 3000ms, market hours only
- LTP sourced from NSE quote endpoint (`/api/quote-equity?symbol=NIFTY%2050`)
- Emits `WEBSOCKET_CONNECTED` on first successful poll (signals system is receiving data)
- On consecutive failures (>30s = 10 polls): emits `WEBSOCKET_RECONNECT_FAILED`
- Volume field set to `0` (not available from NSE quote endpoint)

**Why NSE polling works for Iron Condor:**
- Candle close detection uses epoch math — accurate to the minute, 3s polling is sufficient
- Anti-hunt logic operates on 15m candle closes, not sub-second ticks
- No HFT precision required for paper trading

---

### `data/sources/dhan-source.js` (Phase 3 — stub only in Phase 1)

Connects to Dhan WebSocket feed. Requires active Dhan Data API subscription (₹499/month).

**Dhan WebSocket:**
- URL: `wss://api-feed.dhan.co`
- Auth params: `token`, `clientId`, `authType=2` in query string
- Subscribes to NIFTY index feed post-connect (SecurityId: 13, ExchangeSegment: IDX_I)
- Heartbeat ping every 30s

**Reconnect logic:**
- Exponential backoff: 1s → 2s → 4s → 8s → max 30s
- After 5 failed attempts: emit `WEBSOCKET_RECONNECT_FAILED`

**Token renewal:**
- `setTimeout` fires 22h after boot (Dhan token validity ~23h)
- Calls Dhan `/v2/RenewToken`, reconnects WebSocket with new token
- On renewal failure: log ERROR, emit `WEBSOCKET_RECONNECT_FAILED`

**Phase 1 stub:**
```js
// dhan-source.js — Phase 3 implementation pending
throw new Error('[TickStream] DATA_SOURCE=DHAN not yet implemented. Set DATA_SOURCE=NSE.');
```

---

### `data/candle-builder.js`

Aggregates ticks into 1m/5m/15m OHLCV candles. Time-based candle close detection (wall-clock minute boundary via `dayjs`).

**Internal state per timeframe:**
```js
{
  current: { open, high, low, close, volume, openTime },
  buffer: []  // max CANDLE_BUFFER_SIZE (200), oldest dropped
}
```

**Key behaviors:**
- Candle closes on minute/5-minute/15-minute boundary detected from tick timestamp
- No synthetic flat candles — only real tick data
- `seedBuffer(timeframe, candles[])` — called by `historical.js` at boot
- `getBuffer(timeframe)` — returns buffer copy for indicator-engine

**Emitted events:** `CANDLE_CLOSE_1M`, `CANDLE_CLOSE_5M`, `CANDLE_CLOSE_15M`

---

### `data/historical.js`

One-shot fetch at boot. Seeds `CandleBuilder` with `STARTUP_CANDLE_COUNT` (50) candles of 15m data before WebSocket connects.

**Fallback chain:**
1. NSE India (`/api/chart-databyindex`) — requires session cookie
2. Yahoo Finance (`/v8/finance/chart/^NSEI`) — no auth, 15m interval
3. Local cache (`data/cache/nifty-15m.json`) — stale warning logged

On all three failing: emit `STARTUP_DATA_FAILED`, log ERROR, app continues (indicators warm up from first live candles).

After successful fetch from sources 1 or 2: write to `data/cache/nifty-15m.json`.

**Emitted events:** `HISTORICAL_DATA_LOADED`, `STARTUP_DATA_FAILED`

---

### `data/options-chain.js`

Fetches NSE option chain every 15 minutes during market hours (09:15–15:30 IST) via `node-cron`.

**NSE fetch sequence:**
1. `GET https://www.nseindia.com` — grab session cookie
2. `GET https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY` — with cookie + headers

**Cookie failure handling:**
- On fail: re-fetch cookie, retry chain call once
- Second fail: emit `OPTIONS_CHAIN_STALE {reason, lastGoodTimestamp}`

**Source interface:** All NSE-specific logic isolated in `_fetchFromNSE()`. Future Dhan swap = add `_fetchFromDhan()`, change one line.

**`OPTIONS_CHAIN_UPDATED` payload:**
```js
{
  symbol: 'NIFTY',
  expiry: '2025-04-24',
  underlyingValue: 24185,
  vix: 14.3,
  pcr: 1.05,
  maxCeOiStrike: 24500,
  maxPeOiStrike: 23800,
  atmStrike: 24200,
  timestamp: '2025-04-13T09:30:00.000Z'
}
```

**Emitted events:** `OPTIONS_CHAIN_UPDATED`, `OPTIONS_CHAIN_STALE`

---

### `data/indicator-engine.js`

Listens to `CANDLE_CLOSE_*` and `OPTIONS_CHAIN_UPDATED`. Computes indicators from candle buffers via `technicalindicators`. Emits `INDICATORS_UPDATED`.

**Indicators by timeframe:**

| Indicator | Timeframe | Min candles needed |
|-----------|-----------|-------------------|
| RSI(14) | 5m, 15m | 14 |
| EMA9 | 5m, 15m | 9 |
| EMA21 | 5m, 15m | 21 |
| MACD(12,26,9) | 15m | 35 |
| BB(20, 2σ) | 15m | 20 |
| ATR(14) | 15m | 15 |
| ADX(14) | 15m | 28 |
| Delta (Black-Scholes) | options | requires OPTIONS_CHAIN_UPDATED + ATR |

Returns `null` for any indicator with insufficient buffer. Phase 2 callers handle `null` as "warming up."

**`INDICATORS_UPDATED` payload (candles):**
```js
{
  timeframe: 15,
  timestamp: '2025-04-13T09:45:00.000Z',
  indicators: {
    rsi: 54.2,
    ema9: 24183.4,
    ema21: 24177.1,
    macd: { macd: 2.3, signal: 1.8, histogram: 0.5 },
    bb: { upper: 24310, middle: 24185, lower: 24060, width: 1.03 },
    atr: 45.2,
    adx: 18.7
  }
}
```

**`INDICATORS_UPDATED` payload (options/delta):**
```js
{
  timeframe: 'options',
  timestamp: '...',
  indicators: {
    ceDelta: 0.28,
    peDelta: -0.22
  }
}
```

**Emitted events:** `INDICATORS_UPDATED`

---

### `core/session-context.js` — Phase 1 Hooks

Wire `_hookEvents()`. No other changes to existing Phase 0 methods.

| Event | Field | Rule |
|-------|-------|------|
| `TICK_RECEIVED` | `dayOpen` | Set once on first tick, never overwrite |
| `TICK_RECEIVED` | `dayHigh`, `dayLow` | Running max/min of `ltp` |
| `CANDLE_CLOSE_1M` | `firstHourHigh`, `firstHourLow` | Track during 09:15–10:15 only |
| `CANDLE_CLOSE_1M` | `firstHourComplete` | Set `true` at 10:15 |
| `OPTIONS_CHAIN_UPDATED` | `vixAtOpen` | Set once on first chain fetch of the day |
| `OPTIONS_CHAIN_UPDATED` | `vixCurrent` | Updated on every chain fetch (same event as `vixAtOpen`, different rule: always overwrite) |

`currentRegime` remains `null` — set by Phase 2 rule engine.

---

## Config Additions

Two new keys to add to `config.js`:

```js
STARTUP_CANDLE_COUNT: 50,        // candles fetched at boot (bump to 200 for deep scans)
CANDLE_BUFFER_SIZE: 200,         // rolling buffer size per timeframe (already in config.js)
```

Cache directory: `data/cache/` (git-ignored).

---

## Test Plan — `test-phase1.js`

13 new tests. Synthetic tick injection only. No live API calls.

| ID | Module | What it verifies |
|----|--------|-----------------|
| T16 | CandleBuilder | Tick sequence produces correct 1m OHLCV |
| T17 | CandleBuilder | `CANDLE_CLOSE_1M` emitted at minute boundary |
| T18 | CandleBuilder | 5m and 15m candle boundaries correct |
| T19 | CandleBuilder | Buffer capped at 200, oldest entry dropped |
| T20 | IndicatorEngine | RSI correct from known price series |
| T21 | IndicatorEngine | EMA9/21 correct from known series |
| T22 | IndicatorEngine | MACD correct from known series |
| T23 | IndicatorEngine | BB width correct from known series |
| T24 | IndicatorEngine | Returns `null` when buffer too small (warm-up) |
| T25 | SessionContext | `dayOpen` set on first tick only, not overwritten |
| T26 | SessionContext | `firstHourComplete` set at 10:15 boundary |
| T27 | Historical | Falls back to cache when sources 1 and 2 fail |
| T28 | OptionsChain | Parsed shape matches expected schema from fake NSE JSON |

**Cumulative: 29 tests (T01–T28, Phase 0 T15 remains T15)**

---

## What Phase 1 Does NOT Include

- Regime classification (Phase 2 rule engine)
- Trade signal generation
- Claude API calls
- Order execution
- Telegram commands
- Dashboard
- Position tracker

---

## Known Fragility Points

1. **NSE cookie** — most brittle piece. Cookie expires 30–60 min. Silent retry covers normal rotation. If NSE changes their endpoint or adds bot detection, options chain will stale.
2. **Yahoo Finance** — unofficial API, no SLA. Used only as historical fallback at boot.
3. **NSE LTP polling** — same cookie fragility as options chain. If NSE rate-limits or changes the quote endpoint, tick stream stalls. For Phase 3, switching to `DATA_SOURCE=DHAN` eliminates this.
4. **Dhan token** (Phase 3 only) — expires 24h. Proactive renewal cron mitigates. If renewal API changes, WebSocket feed dies silently until restart.

---

## Phase 2 Preview

Phase 2 will consume the events from Phase 1:
- `INDICATORS_UPDATED` → rule engine Layer 1 (regime) + Layer 2 (IC scorer)
- `OPTIONS_CHAIN_UPDATED` → strike selection
- `CANDLE_CLOSE_15M` → exit condition monitoring
