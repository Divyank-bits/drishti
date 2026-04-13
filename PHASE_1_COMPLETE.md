# Phase 1 Complete — Data Layer

## What Was Built

The full data pipeline. Live NIFTY ticks flow from NSE LTP polling into candle
buffers, indicator computation, and session context. NSE option chain polls every
15 minutes. All Phase 2 rule engine inputs are available via event bus.

---

## Files Created

### data/
| File | What it does |
|------|-------------|
| `tick-stream.js` | Factory: loads `nse-source.js` or `dhan-source.js` based on `DATA_SOURCE` config. |
| `sources/nse-source.js` | Polls NSE LTP every 3s during market hours. Emits `TICK_RECEIVED`. Emits `WEBSOCKET_CONNECTED` on first successful poll. Resets after 10 consecutive failures. |
| `sources/dhan-source.js` | Phase 3 stub — throws if `DATA_SOURCE=DHAN` is used. |
| `candle-builder.js` | Aggregates ticks → 1m/5m/15m OHLCV. Rolling buffer of 200 candles. Epoch-based boundaries (timezone-safe). |
| `indicator-engine.js` | RSI(14), EMA9/21, MACD(12,26,9), BB(20), ATR(14), ADX(14) via `technicalindicators`. Black-Scholes delta via finite diff. Returns null during warm-up. |
| `historical.js` | Boot-time 15m candle fetch: NSE India → Yahoo Finance → local cache. Seeds CandleBuilder before tick stream starts. |
| `options-chain.js` | NSE option chain every 15m. Cookie auto-refresh with one silent retry. Parses PCR, max OI strikes, ATM strike. |
| `cache/.gitkeep` | Cache directory for `nifty-15m.json` (git-ignored). |

### Modified
| File | What changed |
|------|-------------|
| `core/session-context.js` | `_hookEvents()` wired: dayOpen/High/Low from ticks, firstHour from 1m candles, VIX from options chain. Constructor now calls `_hookEvents()`. |
| `config.js` | Added `STARTUP_CANDLE_COUNT: 50`, `DATA_SOURCE: 'NSE'`. |
| `index.js` | Phase 1 boot steps: `historical.fetch()`, `optionsChain.start()`, `tickStream.start()`. |
| `.gitignore` | Added `data/cache/*.json`. |

---

## How to Run

```bash
# Run Phase 1 tests (no live APIs needed)
npm run test:phase1

# Run all tests
node test-phase0.js && node test-phase1.js

# Boot full app (requires .env with Telegram + Anthropic keys)
npm start
```

---

## Test Results

```
16 tests — 16 passed, 0 failed  ← Phase 0 unchanged

13 tests — 13 passed, 0 failed  ← Phase 1

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

- `DATA_SOURCE=NSE` volume field is always 0 — NSE quote endpoint doesn't return volume. Phase 2 anti-hunt volume rules fall back to candle-level volume.
- NSE option chain `vix` field may be null — NSE sometimes omits it. Phase 2 can fall back to VIX index API.
- `currentRegime` stays null — Phase 2 rule engine sets it from indicators.
- No crash recovery yet — pnlToday/tradesToday reset to 0 on restart. Phase 2 reads journal on boot.
- `DATA_SOURCE=DHAN` throws — Phase 3 implementation pending.

---

## What Phase 2 Will Add

- `strategies/iron-condor.strategy.js` — full IC strategy consuming Phase 1 events
- `intelligence/` — Claude client, prompt builder, strategy selector
- `execution/paper-executor.js` — simulated fills with slippage
- `monitoring/` — position tracker, anti-hunt rules
- `notifications/telegram.js` — Telegram bot commands + trade approvals
- `journal/trade-journal.js` — append-only NDJSON writer
- `dashboard/` — Express + SSE live dashboard
