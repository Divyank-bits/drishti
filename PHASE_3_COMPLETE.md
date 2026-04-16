# Phase 3 Complete — Live Dhan Execution

## What Was Built

Phase 3 adds real-money execution capability via the Dhan broker API, replaces the NSE
polling data source with a Dhan WebSocket binary feed, and wires Claude AI into the
entry-signal and anti-hunt decision paths. Paper trading (Phase 2) continues to work
unchanged — switching to live requires only two `.env` changes.

---

## What Each File Does

### Block 1 — Data Source Replacement

| File | Role |
|------|------|
| `data/sources/dhan-source.js` | Dhan WebSocket tick feed. Connects with `authType=2`, parses binary packets (ResponseCode byte 0, LTP FloatLE @ offset 8, LTT Int32LE @ offset 12). Auto-reconnects up to 5 times. Trips circuit breaker 4 if WS stays down > `WEBSOCKET_RECONNECT_TIMEOUT` seconds with an open position. |
| `config.js` | Added `DHAN_WS_URL`, `DHAN_REST_URL`, `DHAN_SECURITY_ID`, `DHAN_EXCHANGE_SEGMENT`. `DATA_SOURCE` config axis (`NSE` \| `DHAN`) is independent of `EXECUTION_MODE`. |
| `data/historical.js` | Added `_fetchFromDhan()`: POST `/v2/charts/historical` with `interval:'15'` for 15m candles. Fallback chain: Dhan → NSE → Yahoo → cache. |
| `data/options-chain.js` | Added `_fetchFromDhan()`: calls expiry list endpoint first (`POST /v2/optionchain/expirylist`, `UnderlyingScrip: 13` int), then fetches chain (`POST /v2/optionchain`). `_parseDhanOptionChain()` reads `data.oc` keyed by `"25650.000000"` strike strings. `strikeData` now includes `ceSecurityId` / `peSecurityId` needed for live order placement. |

### Block 2 — Live Order Execution

| File | Role |
|------|------|
| `execution/dhan-executor.js` | Real Dhan REST executor. Implements the same `placeOrder / exitOrder / computeUnrealisedPnl` interface as `PaperExecutor`. Places each IC leg as a separate `MARKET` order on `NSE_FNO`, polls `/orders/{id}` until `TRADED` or terminal state. Full rollback (`DELETE /orders/{id}`) if any leg fails. |
| `execution/paper-executor.js` | Unchanged from Phase 2. |
| `monitoring/position-tracker.js` | Updated to load executor based on `EXECUTION_MODE` (`LIVE` → DhanExecutor, `PAPER` → PaperExecutor). |
| `index.js` | Boot sequence selects executor by config flag. |

### Block 3 — Intelligence Layer

| File | Role |
|------|------|
| `intelligence/claude-client.js` | Anthropic SDK wrapper. Races API call against `CLAUDE_TIMEOUT_MS`. Logs slow responses > `CLAUDE_SLOW_LOG_MS`. On any failure: flips `_available = false`, emits `CIRCUIT_BREAKER_HIT` with `breakerName:'claude_api'`. `parseJSON()` strips markdown fences before parsing. |
| `intelligence/prompt-builder.js` | Two prompt factories: `buildEntryPrompt()` (asks Claude to approve/reject IC signal, returns `{approved, confidence, reasoning, concerns}`) and `buildHuntPrompt()` (asks Claude whether a breach is a stop-hunt, returns `{isLikelyHunt, confidence, reasoning, action}`). |
| `intelligence/strategy-selector.js` | Routes signals through the configured intelligence mode. HYBRID score gate fires before Claude availability check — low-score signals are rejected without any API call. Falls back to RULES automatically when `claudeClient.isAvailable()` is false. Confidence must clear `CONFIDENCE_THRESHOLD` (0.70) even if Claude says approved. |
| `monitoring/anti-hunt.js` | Added `evaluateWithClaude()` — Rule 8. Async, skipped silently in RULES mode or when Claude is unavailable. Position-tracker calls it when Rule 5 flags a position; honours `action:'EXIT'` recommendation. |
| `strategies/iron-condor.strategy.js` | Now caches 15m candles for Claude prompt context. Calls `strategySelector.select()` before emitting `SIGNAL_GENERATED`. Emits `SIGNAL_DISCARDED` when rejected. Signal payload now includes `intelligenceMode` and `confidence` fields. |

### Block 4 — Integration

| File | Role |
|------|------|
| `index.js` | Boot validates Dhan credentials only when `EXECUTION_MODE=LIVE`, `ANTHROPIC_API_KEY` only when `INTELLIGENCE_MODE=AI\|HYBRID`. Phase 3 boot step checks `claudeClient.isAvailable()` and logs `online` or `offline (RULES fallback)`. |
| `test-phase3.js` | 27 gate tests covering all 3 intelligence modes, prompt output shape, `parseJSON`, and a live Claude API call (skipped gracefully if key absent). |

---

## How to Run

### Paper trading with NSE polling (default — no broker subscription)
```
EXECUTION_MODE=PAPER
DATA_SOURCE=NSE
INTELLIGENCE_MODE=HYBRID   # or RULES (no key needed) or AI
```
```bash
node index.js
```

### Paper trading with live Dhan data (pre-live validation)
```
EXECUTION_MODE=PAPER
DATA_SOURCE=DHAN
DHAN_CLIENT_ID=...
DHAN_ACCESS_TOKEN=...
```

### Live trading
```
EXECUTION_MODE=LIVE
DATA_SOURCE=DHAN
DHAN_CLIENT_ID=...
DHAN_ACCESS_TOKEN=...
```

### Run all tests
```bash
node test-phase2-strategy.js      # 16 tests
node test-phase2-executor.js      # 6 tests
node test-phase2-antihunt.js      # 13 tests
node test-phase2-journal.js       # 6 tests
node test-phase2-integration.js   # 5 tests
node test-phase3.js               # 27 tests
node test-dhan.js                 # live Dhan API smoke test (requires credentials)
```

---

## Configuration Axes

`DATA_SOURCE` and `EXECUTION_MODE` are fully independent:

| DATA_SOURCE | EXECUTION_MODE | Use case |
|-------------|----------------|----------|
| NSE | PAPER | Development, no subscriptions needed |
| DHAN | PAPER | Pre-live validation with real market data |
| DHAN | LIVE | Production |
| NSE | LIVE | Not recommended (stale prices) |

`INTELLIGENCE_MODE` is independent of both:

| Mode | Behaviour |
|------|-----------|
| `RULES` | Pure rule engine, no Claude API calls |
| `HYBRID` | Rules score > 65 required, then Claude decides |
| `AI` | Claude decides (rules result is context only) |

---

## Known Limitations

- **Live order fills**: Dhan `MARKET` orders on NSE FNO may experience partial fills during low-liquidity periods — the executor polls until `TRADED` or timeout, then rolls back. Manual reconciliation may be needed if rollback cancels fail on already-filled legs.
- **Dhan historical candles**: API returns limited history for current trading day; the startup fallback chain (NSE → Yahoo → cache) covers this.
- **Claude latency**: HYBRID/AI mode adds ~1–6s per entry signal evaluation. Circuit breaker 5 trips on sustained outage and the system continues in RULES mode for the rest of the session.
- **Dashboard deferred**: No web dashboard in Phase 3. Position state is observable via Telegram commands (`/status`, `/mode`, etc.) and the trade journal (`journal/trades-*.ndjson`).
