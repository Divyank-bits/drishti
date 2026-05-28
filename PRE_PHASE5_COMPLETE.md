# Pre-Phase 5 — Critical Fixes: Complete

All 6 blocks implemented and verified. 169 tests passing across 4 test suites.

---

## What Was Built

### Block 1 — Dhan Basket Orders
Replaced sequential leg placement with Dhan's basket order API so all legs are placed atomically in a single request. Sequential `_placeOneLeg()` loop is kept as an automatic fallback if the basket endpoint returns 404/422.

### Block 2 — Per-Position StateMachine
Removed the module-level `new StateMachine()` from all 4 strategy files. The allocator now owns one `StateMachine` instance per active strategy, created at boot and injected via `setStateMachine()`. Two strategies can simultaneously hold `SIGNAL_DETECTED` without collision.

### Block 3 — Startup Order Reconciliation
On boot in LIVE mode, the system fetches all open Dhan orders and compares them against today's journal. If orphaned orders are found (crash mid-fill), new entries are blocked via `PAUSE_REQUESTED` and a Telegram alert is sent listing every orphaned order. The operator resolves them manually then sends `/resume`.

### Block 4 — Anti-Hunt Config Knobs
Two new config flags fix silent dangerous behaviour in NSE mode and dangerous windows:
- `ANTI_HUNT_VOLUME_REQUIRED=false` — disables Rule 3 volume gate; required when `DATA_SOURCE=NSE` since volume is always 0
- `ANTI_HUNT_DANGEROUS_WINDOW_MODE=SUPPRESS_FIRST` — holds on first breach within a dangerous window, exits on second consecutive breach instead of blocking all exits for ~75 min/day

### Block 5 — Options Chain Snapshot Collection
Every `OPTIONS_CHAIN_UPDATED` event is now persisted to `snapshots/options-YYYY-MM-DD.ndjson`. Accumulates historical options data for Phase 7 backtesting. Runs silently alongside trading — a disk error is logged but never interrupts trading.

### Block 6 — Per-Strategy Signal Timeframe
Each strategy declares its own `signalTimeframe` (minutes). Iron Condor stays on 15m (needs confirmed neutrality). Bull Put Spread, Bear Call Spread, and Straddle override to 5m for faster directional entry. Anti-hunt in `position-tracker.js` remains on 15m regardless.

---

## Files Changed

| File | What Changed |
|------|-------------|
| `execution/dhan-executor.js` | Added `_placeBasket()`, `_placeSequential()` (extracted from old loop), `fetchOpenOrders()`, `reconcile()`. `placeOrder()` and `exitOrder()` now use basket-first with sequential fallback |
| `strategies/base.strategy.js` | Added `get signalTimeframe()` (returns 15), `setStateMachine(sm)`, `getStateMachine()` |
| `strategies/iron-condor.strategy.js` | Removed module-level StateMachine; uses `this.getStateMachine()`. Candle subscription driven by `this.signalTimeframe` |
| `strategies/bull-put-spread.strategy.js` | Same SM refactor. Added `get signalTimeframe() { return 5; }`. Subscribes to `CANDLE_CLOSE_5M` |
| `strategies/bear-call-spread.strategy.js` | Same SM refactor. Added `get signalTimeframe() { return 5; }`. Subscribes to `CANDLE_CLOSE_5M` |
| `strategies/straddle.strategy.js` | Same SM refactor. Added `get signalTimeframe() { return 5; }`. Subscribes to `CANDLE_CLOSE_5M` |
| `intelligence/strategy-allocator.js` | Added `_stateMachines: Map`, `injectStateMachines(strategies)`, `getStateMachine(name)` |
| `monitoring/anti-hunt.js` | Rule 3: respects `ANTI_HUNT_VOLUME_REQUIRED`. Rule 4: implements `SUPPRESS_FIRST` mode with `position._dangerousWindowBreach` flag |
| `notifications/telegram.js` | Added public `sendAlert(text)` for boot-time alerts |
| `journal/trade-journal.js` | Added `getOpenOrderIds()` — returns Dhan order IDs filled today but not yet closed |
| `data/snapshot-store.js` | **New file.** Appends OPTIONS_CHAIN_UPDATED payloads to `snapshots/options-YYYY-MM-DD.ndjson` |
| `config.js` | Added `ANTI_HUNT_VOLUME_REQUIRED`, `ANTI_HUNT_DANGEROUS_WINDOW_MODE` |
| `index.js` | Wires allocator StateMachine injection, snapshot store listener, boot reconciliation (LIVE only), moved `telegram.start()` before reconciliation |
| `.gitignore` | Added `snapshots/` |

---

## How to Run Tests

```bash
node tests/test-phase2-antihunt.js    # 20 tests — anti-hunt rules + Block 4 config knobs
node tests/test-phase3.js             # 34 tests — intelligence layer + Block 1 basket order mocks
node tests/test-phase4-allocator.js   # 35 tests — allocator + Block 2 concurrent StateMachine
node tests/test-phase4-strategies.js  # 80 tests — strategies + Block 6 signal timeframe
```

All 4 suites together: **169 tests, 169 passed, 0 failed**

---

## Known Limitations

- `_placeBasket()` uses the Dhan v2 `/orders/basket` endpoint — the response shape (`res.data.orders` vs `res.data`) is assumed from documentation and may need adjustment against the live sandbox
- `fetchOpenOrders()` includes `TRADED` orders in its response for reconciliation completeness; the filter logic in `reconcile()` uses a broad definition of "open" that may need tightening once tested against real Dhan responses
- `position._dangerousWindowBreach` flag for `SUPPRESS_FIRST` mode is stored directly on the position object passed by `position-tracker.js` — this is a mutable side effect; position-tracker must pass the same object reference on each candle evaluation (which it does)
- Snapshot store creates the `snapshots/` directory on first write — no pre-creation needed at boot
