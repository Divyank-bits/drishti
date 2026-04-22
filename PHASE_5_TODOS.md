# Phase 5 — Deep Scan / Watchlist: Task List

## Build Order (implement in this sequence)

### Block 1 — Config & Events Foundation
| # | Task | File |
|---|------|------|
| 1 | Add `WATCHLIST_SYMBOLS`, `SCAN_INTERVAL_MINUTES`, `SCAN_MAX_SYMBOLS`, `DEEP_SCAN_CONFIDENCE_THRESHOLD` | `config.js` |
| 2 | Add `SCAN_STARTED`, `SCAN_RESULT`, `SCAN_SYMBOL_FLAGGED`, `WATCHLIST_UPDATED` event constants | `core/events.js` |

### Block 2 — Data Layer Extensions
| # | Task | File |
|---|------|------|
| 3 | Extend tick-stream factory to subscribe to multiple symbols simultaneously; emit `TICK_RECEIVED` with `symbol` field on each tick | `data/tick-stream.js` |
| 4 | Add `fetchForSymbol(symbol)` to options-chain — fetches OI, PCR, IV data for any NSE FO symbol | `data/options-chain.js` |
| 5 | Add `fetchForSymbol(symbol)` to historical — seeds candle history for watchlist symbols on boot | `data/historical.js` |

### Block 3 — Deep Scan Engine
| # | Task | File |
|---|------|------|
| 6 | Scan scheduler — runs every `SCAN_INTERVAL_MINUTES` via node-cron, iterates `WATCHLIST_SYMBOLS`, calls scanner for each | `intelligence/scan-scheduler.js` |
| 7 | Symbol scanner — fetches options chain + candles + indicators for a symbol, scores it against all active strategies, emits `SCAN_RESULT` | `intelligence/symbol-scanner.js` |
| 8 | Watchlist manager — maintains in-memory ranked list of symbols by scan score, emits `WATCHLIST_UPDATED` when ranking changes | `intelligence/watchlist-manager.js` |

### Block 4 — Claude Integration for Scan
| # | Task | File |
|---|------|------|
| 9 | Extend prompt-builder to assemble deep-scan prompts: symbol name, OI profile, IV rank, candle summary, strategy scores | `intelligence/prompt-builder.js` |
| 10 | In HYBRID/AI mode, pass top-N scan candidates to Claude for confirmation before flagging as `SCAN_SYMBOL_FLAGGED` | `intelligence/symbol-scanner.js` |

### Block 5 — Telegram `/scan` Command
| # | Task | File |
|---|------|------|
| 11 | Wire `/scan [SYMBOL]` command — triggers immediate single-symbol deep scan and returns result via Telegram | `notifications/telegram.js` |
| 12 | Wire `/watchlist` command — returns current ranked watchlist with scores | `notifications/telegram.js` |

### Block 6 — Session Context & Journal
| # | Task | File |
|---|------|------|
| 13 | Add `scanResults` map to session context — tracks latest scan score per symbol within the trading day | `core/session-context.js` |
| 14 | Write `SCAN_RESULT` and `SCAN_SYMBOL_FLAGGED` events to trade journal | `journal/trade-journal.js` |

### Block 7 — Multi-Symbol Snapshot Collection
| # | Task | File |
|---|------|------|
| 15 | Extend `data/snapshot-store.js` (built in Pre-Phase 5) to handle multiple symbols — keyed by symbol name in the NDJSON entry. One file per day per symbol: `snapshots/options-SYMBOL-YYYY-MM-DD.ndjson` | `data/snapshot-store.js` |
| 16 | Wire into scan-scheduler — after each symbol scan, write the options chain + scan score to the snapshot store | `intelligence/scan-scheduler.js` |

### Block 8 — Tests & Completion
| # | Task | File |
|---|------|------|
| 17 | Unit tests for symbol-scanner — scoring logic, Claude bypass in RULES mode, correct events emitted | `test-phase5-scanner.js` |
| 18 | Unit tests for watchlist-manager — ranking updates, eviction of stale scores, `WATCHLIST_UPDATED` emission | `test-phase5-watchlist.js` |
| 19 | Integration test — scan scheduler runs, top symbol flagged, Telegram `/scan` returns result, journal entry written | `test-phase5-integration.js` |
| 20 | Add `test:phase5` script; verify all Phase 5 tests pass | `package.json` |
| 21 | Phase deliverable doc | `PHASE_5_COMPLETE.md` |

---

## Scan Scoring Criteria (applied per symbol)

| Dimension | Weight | What is checked |
|-----------|--------|----------------|
| IV Rank | 25% | IV Percentile > 50% scores full weight |
| OI Profile | 25% | PCR 0.9–1.2, clear max pain level identifiable |
| Trend Neutrality | 20% | EMA9 and EMA21 within 0.3%, RSI 40–60 |
| Volatility Regime | 20% | BB Width 2–4%, not squeezing |
| Liquidity | 10% | Bid-ask spread < 2% of premium, OI > 5000 contracts |

Score threshold for `SCAN_SYMBOL_FLAGGED`: `DEEP_SCAN_CONFIDENCE_THRESHOLD` (default 70%)

---

## Watchlist Behaviour

- Symbols ranked by scan score descending
- Scores expire after `SCAN_INTERVAL_MINUTES × 2` — stale symbols drop from ranking
- Max `SCAN_MAX_SYMBOLS` symbols tracked simultaneously (default 10)
- On `SCAN_SYMBOL_FLAGGED`: strategy-selector checks if a position is already open on that symbol before allowing entry

---

## Gates (all must pass before PHASE_5_COMPLETE.md)

| Gate | What it tests |
|------|--------------|
| Gate 1 | Tick stream subscribes to multiple symbols, each tick carries correct `symbol` field |
| Gate 2 | `options-chain.fetchForSymbol()` returns valid OI + IV data for a non-NIFTY symbol |
| Gate 3 | Symbol scanner scores a fixture symbol correctly against all 3 active strategies |
| Gate 4 | In RULES mode, Claude is never called during scan |
| Gate 5 | Watchlist manager ranks symbols correctly and evicts stale scores |
| Gate 6 | `/scan BANKNIFTY` Telegram command triggers scan and returns result within 30s |
| Gate 7 | `/watchlist` returns ranked list sorted by score descending |
| Gate 8 | `SCAN_SYMBOL_FLAGGED` event is written to trade journal with full scan payload |
