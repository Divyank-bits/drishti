# Phase 5 — Deep Scan / Watchlist: Complete

All 8 blocks implemented and verified. 56 tests passing across 3 test suites.

---

## What Was Built

### Block 1 — Config & Events Foundation
Four new config keys added for scan behaviour: `WATCHLIST_SYMBOLS`, `SCAN_INTERVAL_MINUTES`, `SCAN_MAX_SYMBOLS`, `DEEP_SCAN_CONFIDENCE_THRESHOLD`. Four new event constants added to `core/events.js`: `SCAN_STARTED`, `SCAN_RESULT`, `SCAN_SYMBOL_FLAGGED`, `WATCHLIST_UPDATED`.

### Block 2 — Data Layer Extensions
- `nse-source.js`: Added `subscribeSymbol(symbol)`. Polling loop now iterates a `Set` of subscribed symbols, demuxing prices from the single `getEquityStockIndices('NIFTY 50')` response via `INDEX_NAME_MAP`. On boot, auto-subscribes all `WATCHLIST_SYMBOLS`. Each tick carries the correct `symbol` field.
- `dhan-source.js`: Added `subscribeSymbol(symbol, securityId, segment)`. Maintains `_securityIdToSymbol` map and `_instruments` list. Subscription payload (`RequestCode: 15`) is rebuilt and re-sent on each (re)connect. Incoming binary packets demux by `securityId` bytes 4–7. Boot auto-subscribes watchlist symbols using built-in `SYMBOL_SECURITY_MAP`.
- `options-chain.js`: Added `fetchForSymbol(symbol)` — fetches NSE option chain for any index symbol on demand. Returns the same shape as `OPTIONS_CHAIN_UPDATED` without emitting events.
- `historical.js`: Added `fetchForSymbol(symbol)` with Dhan historical (`_fetchFromDhanSymbol`) and Yahoo Finance (`_fetchFromYahooSymbol`) backends. Returns candle array without emitting events or seeding candle builder.

### Block 3 — Deep Scan Engine
- `intelligence/symbol-scanner.js`: Fetches chain + candles in parallel, computes indicators using `technicalindicators` directly (no candle-builder dependency — avoids mutating NIFTY buffers), scores via `computeScanScore()` (5 weighted dimensions), calls `checkConditions()` on every registered strategy, emits `SCAN_RESULT` always and `SCAN_SYMBOL_FLAGGED` when score ≥ threshold.
- `intelligence/watchlist-manager.js`: Listens to `SCAN_RESULT`, maintains `Map<symbol, { score, timestamp }>`, enforces `SCAN_MAX_SYMBOLS` cap by evicting lowest scorer, evicts stale entries on each access using TTL = `SCAN_INTERVAL_MINUTES × 2`. Emits `WATCHLIST_UPDATED` only when a score actually changes.
- `intelligence/scan-scheduler.js`: node-cron fires every `SCAN_INTERVAL_MINUTES` on weekdays, iterates `WATCHLIST_SYMBOLS` sequentially with a 500ms pause between symbols, calls `symbolScanner.scan()`, writes result to snapshot store. Imports `watchlist-manager` to auto-wire its `SCAN_RESULT` listener.

### Block 4 — Claude Integration for Scan
Added `buildScanPrompt(scanResult)` to `intelligence/prompt-builder.js`. Assembles symbol name, composite score, chain data, indicator snapshot, and per-strategy scores into a structured prompt requesting `{ approved, confidence, reasoning }` JSON. Available for callers to use in AI/HYBRID mode before flagging.

### Block 5 — Telegram `/scan` and `/watchlist`
- `/scan SYMBOL`: triggers `symbolScanner.scan(symbol)` on demand, replies with composite score, chain data, indicators, and per-strategy eligibility. Marks ⚡ FLAGGED if above threshold.
- `/watchlist`: calls `watchlistManager.getRanked()`, returns numbered list sorted by score descending.

### Block 6 — Session Context & Journal
- `core/session-context.js`: Added `scanResults: {}` to default data. Hooks `SCAN_RESULT` event — updates `scanResults[symbol] = { score, timestamp }` within the trading day.
- `journal/trade-journal.js`: Added `hookScanEvents()` — registers `SCAN_RESULT` and `SCAN_SYMBOL_FLAGGED` listeners that write to the append-only journal. Called once from `index.js`.

### Block 7 — Multi-Symbol Snapshot Collection
`data/snapshot-store.js` extended: `write(payload)` now checks `payload.symbol` — NIFTY writes to `options-YYYY-MM-DD.ndjson` (backwards compatible), all other symbols write to `options-SYMBOL-YYYY-MM-DD.ndjson`. Entry shape extended to include `symbol`, `scanScore`, and `strategyScores` fields. `scan-scheduler.js` calls `snapshotStore.write()` after each symbol scan.

### Block 8 — Tests
Three test suites: scanner unit tests (17), watchlist unit tests (13), integration gate tests (26).

---

## Files Changed

| File | What Changed |
|------|-------------|
| `config.js` | Added `WATCHLIST_SYMBOLS`, `SCAN_INTERVAL_MINUTES`, `SCAN_MAX_SYMBOLS`, `DEEP_SCAN_CONFIDENCE_THRESHOLD` |
| `core/events.js` | Added `SCAN_STARTED`, `SCAN_RESULT`, `SCAN_SYMBOL_FLAGGED`, `WATCHLIST_UPDATED` |
| `data/sources/nse-source.js` | Multi-symbol polling via `subscribeSymbol()`, `INDEX_NAME_MAP`, auto-subscribe watchlist on boot |
| `data/sources/dhan-source.js` | Multi-symbol subscription via `subscribeSymbol()`, `_instruments` list, binary packet demux by securityId |
| `data/options-chain.js` | Added `fetchForSymbol(symbol)` |
| `data/historical.js` | Added `fetchForSymbol(symbol)`, `_fetchFromYahooSymbol()`, `_fetchFromDhanSymbol()` |
| `data/snapshot-store.js` | Per-symbol file routing, extended entry shape with `symbol`, `scanScore`, `strategyScores` |
| `intelligence/symbol-scanner.js` | **New file.** Scan scoring engine |
| `intelligence/watchlist-manager.js` | **New file.** Ranked in-memory watchlist with TTL eviction |
| `intelligence/scan-scheduler.js` | **New file.** node-cron scan cycle driver |
| `intelligence/prompt-builder.js` | Added `buildScanPrompt(scanResult)` |
| `notifications/telegram.js` | Added `/scan SYMBOL` and `/watchlist` command handlers |
| `core/session-context.js` | Added `scanResults` map to default data, hooks `SCAN_RESULT` |
| `journal/trade-journal.js` | Added `hookScanEvents()` for `SCAN_RESULT` + `SCAN_SYMBOL_FLAGGED` journal writes |
| `index.js` | Wires `journal.hookScanEvents()` and `scanScheduler.start()` in boot sequence |
| `package.json` | Added `test:phase5` script |

---

## How to Run Tests

```bash
node tests/test-phase5-scanner.js      # 17 tests — symbol scanner scoring, events, error handling
node tests/test-phase5-watchlist.js    # 13 tests — ranking, TTL eviction, cap enforcement
node tests/test-phase5-integration.js  # 26 tests — gates: config, events, interfaces, pipeline
```

All 3 suites together: **56 tests, 56 passed, 0 failed**

---

## Known Limitations

- `fetchForSymbol()` in options-chain uses `stock-nse-india` which only supports index chains (NIFTY, BANKNIFTY, FINNIFTY) — equity symbols like RELIANCE are not supported via this path
- `_fetchFromYahooSymbol()` uses hardcoded Yahoo ticker mappings (`BANKNIFTY → %5ENSEBANK`); unmapped symbols fall back to `SYMBOL.NS` which may not exist for all FO indices
- Dhan `SYMBOL_SECURITY_MAP` in dhan-source.js covers the four most common indices; adding a new symbol requires knowing its Dhan security ID
- `buildScanPrompt()` is not yet called automatically by `symbol-scanner.js` — the hook for AI/HYBRID mode confirmation before `SCAN_SYMBOL_FLAGGED` is structurally in place but not wired (Phase 6 or operator can add it)
- scan-scheduler 500ms inter-symbol delay is hardcoded; with many symbols in `WATCHLIST_SYMBOLS` a full cycle may slightly exceed `SCAN_INTERVAL_MINUTES`
