# Phase 3 — Live Dhan Execution: Task List

## Build Order (implement in this sequence)

### Block 1 — Data Source Replacement (do first, test independently)
| # | Task | File |
|---|------|------|
| 1 | Dhan WebSocket tick feed with binary packet parser | `data/sources/dhan-source.js` |
| 2 | Add Dhan constants to config, switch DATA_SOURCE to DHAN | `config.js` |
| 3 | `_fetchFromDhan()` for boot-time candle seed | `data/historical.js` |
| 4 | `_fetchFromDhan()` for option chain | `data/options-chain.js` |

### Block 2 — Live Order Execution
| # | Task | File |
|---|------|------|
| 5 | Dhan REST order placement, modification, cancellation | `execution/dhan-executor.js` |

### Block 3 — Intelligence Layer (enables HYBRID / AI modes)
| # | Task | File |
|---|------|------|
| 6 | Anthropic SDK wrapper + circuit breaker 5 integration | `intelligence/claude-client.js` |
| 7 | Assemble Claude prompts from session context + candles | `intelligence/prompt-builder.js` |
| 8 | Route AI vs RULES vs HYBRID execution path | `intelligence/strategy-selector.js` |
| 9 | Wire anti-hunt Rule 8 (Claude hunt detection) | `monitoring/anti-hunt.js` |

### Block 4 — Integration & Completion
| # | Task | File |
|---|------|------|
| 10 | Phase 3 boot sequence | `index.js` |
| 11 | All Phase 3 gates pass | `test-phase3.js` |
| 12 | Phase deliverable doc | `PHASE_3_COMPLETE.md` |

> Dashboard (Express SSE + frontend) deferred — not in scope for Phase 3.

---

## Dhan API Reference (from working test)

- **WebSocket URL:** `wss://api-feed.dhan.co?version=2&token=TOKEN&clientId=CLIENT_ID&authType=2`
- **REST base:** `https://api.dhan.co/v2/`
- **NIFTY 50 index:** `ExchangeSegment: "IDX_I"`, `SecurityId: "13"`
- **Binary packet format:**
  - Byte 0 = Response Code
  - Code 2 (Ticker): LTP at offset 8 (FloatLE), LTT at offset 12 (Int32LE)
  - Code 6 (Prev Close): prevClose at offset 8 (FloatLE)
  - Code 50 (Disconnect): reason code at offset 8 (Int16LE)

## Credentials Location
- `DHAN_CLIENT_ID` and `DHAN_ACCESS_TOKEN` must be in `.env` (never hardcoded)
- `ANTHROPIC_API_KEY` must be in `.env` for Block 3

---

## Gates (all must pass before PHASE_3_COMPLETE.md)

| Gate | What it tests |
|------|--------------|
| Gate 1 | Dhan WebSocket connects, receives TICK_RECEIVED events |
| Gate 2 | Dhan executor places/cancels paper orders via REST |
| Gate 3 | Claude client calls API, handles outage (circuit breaker 5) |
| Gate 4 | Strategy selector routes correctly for all 3 INTELLIGENCE_MODEs |
| Gate 5 | Full integration: strategy selector routes all 3 modes correctly |
| Gate 6 | Claude hunt detection (Rule 8) returns valid JSON response |
