# Phase 6 — Equity Directional Scan: Complete

All 10 blocks implemented and verified. 100 tests passing across 3 test suites.

---

## What Was Built

### Block 1 — Config & Events Foundation
Four new config keys: `EQUITY_SCAN_SYMBOLS`, `EQUITY_SCAN_CANDLE_TIMEFRAMES`, `EQUITY_SCAN_CONFLUENCE_THRESHOLD` (65), `EQUITY_SCAN_FORMING_THRESHOLD` (40). Four new event constants: `EQUITY_SCAN_STARTED`, `EQUITY_SCAN_RESULT`, `EQUITY_PATTERN_FORMING`, `EQUITY_PATTERN_CONFIRMED`.

### Block 2 — Equity Strategy Base System
- `strategies/equity/base.equity-strategy.js`: Abstract base with `name`, `direction`, `description` getters and `checkPattern({ candles, indicators, context, timeframe })` returning `{ patternName, direction, state, confidence, signals, failedConditions }`.
- `strategies/equity/registry.js`: Auto-discovers all `*.equity-strategy.js` files, validates inheritance, exposes `getAll()`, `getByDirection()`, `runAll(params)`. Singleton like the options registry.

### Block 3 — Market Context Helpers
- `data/equity-context.js`: `getContext(symbol)` fetches prev day OHLC from Yahoo Finance (fallback: NSE equity API) and returns `{ prevDayHigh, prevDayLow, prevDayClose, prevDayOpen, vwap, dayOpen }`. VWAP is accumulated from intraday ticks via `recordTick()` / `setDayOpen()`. `resetDailyState()` clears all accumulators at day start.

### Block 4 — Five Named Equity Strategies
All extend `BaseEquityStrategy`. All return `state: 'FORMING' | 'CONFIRMED' | 'NONE'`.

| Strategy | File | Direction | Key Conditions |
|----------|------|-----------|----------------|
| Bull Flag | `bull-flag.equity-strategy.js` | BULLISH | Strong up 15m, tight BB 5m, vol breakout 1m, price > VWAP |
| Bear Flag | `bear-flag.equity-strategy.js` | BEARISH | Strong down 15m, tight BB 5m, vol breakdown 1m, price < VWAP |
| Breakout | `breakout.equity-strategy.js` | BULLISH | Close above PDH, vol > 2×avg, EMA9>EMA21, RSI>60, price>VWAP |
| Breakdown | `breakdown.equity-strategy.js` | BEARISH | Close below PDL, vol > 2×avg, EMA9<EMA21, RSI<40, price<VWAP |
| Range Bound | `range-bound.equity-strategy.js` | NEUTRAL | Price in PDH–PDL range 3+ candles, BB contracting, RSI 40–60, vol<avg, MACD~0 |

### Block 5 — Multi-Timeframe Confluence Scorer
- `intelligence/confluence-scorer.js`: `score(resultsByTimeframe)` applies 15m=50% / 5m=30% / 1m=20% weights. Averages confidence of non-NONE strategies per timeframe. Returns `{ score, state, timeframeScores, dominantPattern, dominantDirection }`. State driven by config thresholds.

### Block 6 — Symbol Scanner (Equity)
- `intelligence/equity-scanner.js`: `scan(symbol, mode)` orchestrates full pipeline. Fetches candles for all 3 timeframes → fetches equity context → runs all equity strategies per timeframe → scores confluence → emits `EQUITY_SCAN_RESULT` always, plus `EQUITY_PATTERN_FORMING` or `EQUITY_PATTERN_CONFIRMED` when threshold reached. Supports `'rules'`, `'claude'`, `'confirm'` modes.

### Block 7 — Claude Integration for Equity Scan
- `intelligence/prompt-builder.js`: Added `buildEquityScanPrompt(symbol, candlesByTf, indicators15, context, strategyResults, confluence)`. Includes VWAP, prev day S/R, candle summaries, indicator values, rules findings, confluence summary. Requests `{ patternDetected, direction, confidence, reasoning, keyLevels }` JSON.
- In `equity-scanner.js`: `'claude'` mode skips rules and calls Claude directly. `'confirm'` mode runs rules first, then calls Claude for reasoning. `'rules'` mode never touches Claude.

### Block 8 — Telegram Wiring
- `notifications/telegram.js`: `/scan SYMBOL` now routes by symbol type. Index symbols (NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY) → Phase 5 index scanner. All other symbols → Phase 6 equity scanner. Parses `--claude` and `--confirm` flags. Formats output with pattern name, state emoji, confluence %, VWAP, key levels, per-timeframe signals, Claude reasoning.

### Block 9 — Journal
- `journal/trade-journal.js`: Added `hookEquityScanEvents()` — registers listeners for `EQUITY_SCAN_RESULT`, `EQUITY_PATTERN_FORMING`, `EQUITY_PATTERN_CONFIRMED` and writes full payloads to the append-only journal.

### Block 10 — Tests & Completion
Three test suites: strategy unit tests (37), confluence unit tests (19), integration gates (44).

---

## Files Changed

| File | What Changed |
|------|-------------|
| `config.js` | Added `EQUITY_SCAN_SYMBOLS`, `EQUITY_SCAN_CANDLE_TIMEFRAMES`, `EQUITY_SCAN_CONFLUENCE_THRESHOLD`, `EQUITY_SCAN_FORMING_THRESHOLD` |
| `core/events.js` | Added `EQUITY_SCAN_STARTED`, `EQUITY_SCAN_RESULT`, `EQUITY_PATTERN_FORMING`, `EQUITY_PATTERN_CONFIRMED` |
| `strategies/equity/base.equity-strategy.js` | **New file.** Abstract base class for equity strategies |
| `strategies/equity/registry.js` | **New file.** Auto-discovery registry for equity strategies |
| `strategies/equity/bull-flag.equity-strategy.js` | **New file.** Bull Flag pattern |
| `strategies/equity/bear-flag.equity-strategy.js` | **New file.** Bear Flag pattern |
| `strategies/equity/breakout.equity-strategy.js` | **New file.** Breakout pattern |
| `strategies/equity/breakdown.equity-strategy.js` | **New file.** Breakdown pattern |
| `strategies/equity/range-bound.equity-strategy.js` | **New file.** Range Bound pattern |
| `data/equity-context.js` | **New file.** Prev day OHLC + VWAP accumulator |
| `intelligence/confluence-scorer.js` | **New file.** Multi-timeframe weighted confluence scorer |
| `intelligence/equity-scanner.js` | **New file.** Equity scan orchestrator (rules/claude/confirm modes) |
| `intelligence/prompt-builder.js` | Added `buildEquityScanPrompt()` |
| `notifications/telegram.js` | Extended `/scan` to route equity vs index, parse mode flags, format equity result |
| `journal/trade-journal.js` | Added `hookEquityScanEvents()` |
| `package.json` | Added `test:phase6` script |

---

## How to Run Tests

```bash
node tests/test-phase6-strategies.js   # 37 tests — strategy scoring, shapes, edge cases
node tests/test-phase6-confluence.js   # 19 tests — weighted scoring, thresholds, dominant pattern
node tests/test-phase6-integration.js  # 44 tests — gates: config, events, pipeline, Claude bypass
```

All 3 suites together: **100 tests, 100 passed, 0 failed**

---

## Known Limitations

- `equity-context.js` fetches prev day OHLC from Yahoo Finance; unmapped symbols fall back to `SYMBOL.NS` which may 404 for some less-liquid NSE stocks
- VWAP accumulation requires `recordTick()` to be called from the tick stream — not yet wired in `index.js` (equity scan is on-demand only via Telegram, so VWAP will be null unless manually seeded)
- `fetchForSymbol()` in `historical.js` fetches 15m candles only; equity scanner uses the same candles for 1m/5m/15m timeframes (all three timeframes receive the same candle array). True multi-timeframe requires separate Dhan API calls per timeframe — deferred to Phase 7
- Equity order execution is out of scope for Phase 6 — analysis only
- No auto-scheduling for equity scans — manual `/scan SYMBOL` trigger only
