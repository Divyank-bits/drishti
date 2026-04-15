# Phase 2 Complete — Rules-Based Iron Condor Paper Trading

## What Was Built

A complete paper trading loop on top of Phase 1's data stream. Iron Condor signals are
detected by a 11-condition rule engine, sent to Telegram for approval, filled with simulated
slippage, monitored every 15m candle via anti-hunt rules, and exited cleanly with full
journal writes. State machine and circuit breakers from Phase 0 are wired for real here.
Intelligence mode is RULES-only; Claude integration is deferred to a future phase.

---

## Files Created

### execution/
| File | What it does |
|------|-------------|
| `order-executor.js` | Abstract interface contract for all executors. |
| `paper-executor.js` | Simulated fills with fixed per-lot slippage. Tracks open orders, computes unrealised P&L from live strike data, exits at current market prices. |

### journal/
| File | What it does |
|------|-------------|
| `trade-journal.js` | Append-only NDJSON writer. Never modifies existing entries. Provides `restoreFromJournal()` to rebuild `pnlToday` and `tradesToday` on boot after a restart. |
| `.gitkeep` | Keeps the `journal/` directory in git; `trades.ndjson` is git-ignored. |

### strategies/
| File | What it does |
|------|-------------|
| `iron-condor.strategy.js` | 11-condition entry filter (VIX, BB width, BB squeeze, IV percentile proxy, EMA spread, RSI, MACD, NIFTY vs day open, PCR, time window, holiday check). Strike selection with non-obvious shift (+50 if short strike lands on exact hundred). |

### monitoring/
| File | What it does |
|------|-------------|
| `anti-hunt.js` | Pure function — no event bus. Evaluates 7 rules in strict order (6→4→1+2→3→5). Returns `{ shouldExit, flagged, rule, reason }`. |
| `position-tracker.js` | Wires event bus to anti-hunt. Tracks rolling candle volume for Rule 3 avg. Manages full exit lifecycle: `EXITING → CLOSED → IDLE`. |

### notifications/
| File | What it does |
|------|-------------|
| `telegram.js` | Two-direction bot. Outbound: trade approval keyboard, risk alerts, circuit breaker alerts, trade close summary. Inbound: `/pause`, `/resume`, `/squareoff`, `/mode`, `/status`. 3-minute approval timeout with auto-reject. |

### Modified
| File | What changed |
|------|-------------|
| `core/events.js` | Added `ORDER_EXITED`, `POSITION_UPDATED`. |
| `config.js` | Added `SLIPPAGE_PER_LOT`, `MACD_ZERO_THRESHOLD`, `IV_PERCENTILE_PROXY_MIN`, `TRADE_APPROVAL_TIMEOUT_MS`. |
| `data/options-chain.js` | Added `strikeData` to `OPTIONS_CHAIN_UPDATED` payload (strike → `{ ce, pe }` price lookup). |
| `index.js` | Phase 2 boot: journal restore, paper executor, iron condor strategy, position tracker, Telegram bot. |

---

## How to Run

```bash
# Run Phase 2 tests only
npm run test:phase2

# Run all phases
node test-phase0.js && node test-phase1.js && npm run test:phase2

# Boot full app (requires .env with TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
npm start
```

---

## Test Results

```
16 tests — 16 passed, 0 failed  ← Phase 0 unchanged
13 tests — 13 passed, 0 failed  ← Phase 1 unchanged

 6 tests —  6 passed, 0 failed  ← Paper executor (Gate 1)
 6 tests —  6 passed, 0 failed  ← Trade journal (Gate 2)
16 tests — 16 passed, 0 failed  ← Iron Condor strategy (Gate 3)
13 tests — 13 passed, 0 failed  ← Anti-hunt rules (Gate 4)
 7 tests —  7 passed, 0 failed  ← Telegram bot (Gate 5)
 5 tests —  5 passed, 0 failed  ← Integration (Gate 6)
```

---

## Known Limitations

- **RULES mode only** — Claude integration (Rule 8 hunt detection, HYBRID/AI modes) is deferred.
- **NSE source has no volume data** — `candle.volume` is always `0` from the NSE LTP poller, so anti-hunt Rule 3 (volume confirmation) always skips and treats the move as a likely hunt. This is intentional and safe: it makes exits more conservative. Rule 3 will activate automatically when switching to `DATA_SOURCE=DHAN` (Phase 3).
- **No dashboard** — position P&L is visible in logs and Telegram only. Dashboard server is Phase 3.
- **Single position** — the state machine supports one open Iron Condor at a time. Multi-leg or multi-strategy support is Phase 4+.
