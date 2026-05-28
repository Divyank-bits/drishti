# Pre-Phase 5 — Critical Fixes: Task List

These must be completed and confirmed before Phase 5 begins.
They fix known correctness issues identified during the Phase 4 review.

---

## Block 1 — Dhan Basket Orders (Atomic Leg Placement)

**Problem:** `DhanExecutor` places 4 IC legs sequentially. If leg 3 fails, legs 1+2 are
already filled at market — rollback cancels them but Dhan may have already executed the
fill, making cancel a no-op. This is a real-money risk.

**Fix:** Replace sequential `_placeOneLeg()` calls with Dhan's basket order API, which
places all legs atomically in a single request.

| # | Task | File |
|---|------|------|
| 1 | Research Dhan basket/combo order API endpoint — confirm it supports NSE_FNO multi-leg in one request | — |
| 2 | Add `_placeBasket(legs)` method to `DhanExecutor` — single POST to basket endpoint, returns array of fill details | `execution/dhan-executor.js` |
| 3 | Replace the sequential leg loop in `placeOrder()` with `_placeBasket()` — keep `_placeOneLeg()` as fallback if basket API unavailable | `execution/dhan-executor.js` |
| 4 | Update `exitOrder()` similarly — exit all 4 legs as a basket | `execution/dhan-executor.js` |
| 5 | Update `test-phase3.js` — add basket order mock test | `test-phase3.js` |

---

## Block 2 — StateMachine Per-Position (Concurrent Position Support)

**Problem:** `StateMachine` is a singleton tracking one global position state. In
`ALL_PASSING` mode, the second strategy's signal finds the machine in `SIGNAL_DETECTED`
and is silently dropped. This is a correctness bug, not just a future enhancement.

**Fix:** Refactor `StateMachine` to be instantiated per-position. Each strategy gets its
own state machine instance.

| # | Task | File |
|---|------|------|
| 6 | Remove singleton export from `state-machine.js` — export the class, not `new StateMachine()` | `core/state-machine.js` |
| 7 | Update `strategy-allocator.js` — maintain a `Map<strategyName, StateMachine>` instance per strategy | `intelligence/strategy-allocator.js` |
| 8 | Update each strategy file (`iron-condor`, `bull-put-spread`, `bear-call-spread`, `straddle`) — receive their StateMachine instance from the allocator instead of creating their own | `strategies/*.strategy.js` |
| 9 | Update `index.js` boot sequence — instantiate one StateMachine per active strategy, pass to allocator | `index.js` |
| 10 | Update `test-phase4-allocator.js` — verify two strategies can hold simultaneous `SIGNAL_DETECTED` states without collision | `test-phase4-allocator.js` |

---

## Block 3 — Startup Order Reconciliation

**Problem:** If the app crashes mid-fill (between leg 2 and leg 3), orphaned open orders
exist on Dhan that the app has no record of. On next boot, the journal shows no open
position but Dhan has open legs — real-money exposure with no monitoring.

**Fix:** On boot (LIVE mode only), fetch all open orders from Dhan and compare against
journal state. Alert via Telegram if mismatch found.

| # | Task | File |
|---|------|------|
| 11 | Add `fetchOpenOrders()` to `DhanExecutor` — GET `/orders` from Dhan, filter for today's NSE_FNO orders in non-terminal states | `execution/dhan-executor.js` |
| 12 | Add `reconcile(journalState)` to `DhanExecutor` — compares open Dhan orders against journal's last known position. Returns `{ clean, orphanedOrders, missingOrders }` | `execution/dhan-executor.js` |
| 13 | Wire reconciliation into `index.js` boot sequence — only when `EXECUTION_MODE=LIVE`. If orphaned orders found: send Telegram alert with order details, block new entries until user responds `/resume` | `index.js` |

---

## Block 4 — Anti-Hunt Config Knobs

**Problem 1:** When `DATA_SOURCE=NSE`, `candle.volume` is always `0`. Rule 3 then treats
every breach as a hunt and never exits — the only exit path in NSE mode is the absolute
P&L stop (Rule 6). This is silently dangerous.

**Problem 2:** Dangerous windows (Rule 4) block ALL exits for ~75 minutes per day. If a
real trending move starts in a dangerous window, the position bleeds until the window ends.

**Fix:** Two config knobs to control this behaviour.

| # | Task | File |
|---|------|------|
| 14 | Add `ANTI_HUNT_VOLUME_REQUIRED: true` to config — when `false`, Rule 3 is skipped and exit is based on price + buffer alone. Default `true` for DHAN source, should be set to `false` when `DATA_SOURCE=NSE` | `config.js` |
| 15 | Add `ANTI_HUNT_DANGEROUS_WINDOW_MODE: "BLOCK_ALL"` to config — `"BLOCK_ALL"` is current behaviour. `"SUPPRESS_FIRST"` means: in a dangerous window, don't exit on first breach but if the *next* 15m candle also closes beyond buffer, exit | `config.js` |
| 16 | Update `anti-hunt.js` Rule 3 — check `config.ANTI_HUNT_VOLUME_REQUIRED` before applying volume gate. If `false`, skip volume check and proceed to exit decision | `monitoring/anti-hunt.js` |
| 17 | Update `anti-hunt.js` Rule 4 — implement `SUPPRESS_FIRST` mode. Track `_dangerousWindowBreach` flag on position. First breach in window sets flag, second consecutive breach (next candle still beyond buffer) triggers exit | `monitoring/anti-hunt.js` |
| 18 | Update `test-phase2-antihunt.js` — add tests for both new config modes | `test-phase2-antihunt.js` |

---

## Block 5 — Options Chain Snapshot Collection

**Problem:** No historical options data exists for backtesting (Phase 7). We need to start
collecting it now so data accumulates over time.

**Fix:** Save one options chain snapshot to disk on every `OPTIONS_CHAIN_UPDATED` event.

| # | Task | File |
|---|------|------|
| 19 | Create `data/snapshot-store.js` — appends options chain snapshots to a daily NDJSON file `snapshots/options-YYYY-MM-DD.ndjson`. Each entry: `{ timestamp, vix, pcr, atmStrike, underlyingValue, strikeData }` | `data/snapshot-store.js` |
| 20 | Wire `snapshot-store.js` into `index.js` boot — listen to `OPTIONS_CHAIN_UPDATED`, write snapshot. No event emission, no dependencies on other modules | `index.js` |
| 21 | Add `snapshots/` to `.gitignore` — data files should not be committed | `.gitignore` |

---

## Block 6 — Per-Strategy Signal Timeframe

**Problem:** All 4 strategies hardcode `CANDLE_CLOSE_15M` for signal checks. Directional
strategies (Bull Put Spread, Bear Call Spread, Straddle) benefit from faster 5m confirmation —
waiting 15m means late entry or missed move. Iron Condor correctly stays on 15m (needs
confirmed neutrality).

**Fix:** Each strategy declares its own `signalTimeframe` — strategy files listen to the
correct candle event. Anti-hunt in `position-tracker.js` stays on 15m regardless.

| # | Task | File |
|---|------|------|
| 22 | Add `get signalTimeframe()` to `base.strategy.js` — returns `15` by default | `strategies/base.strategy.js` |
| 23 | Override `signalTimeframe` to `5` in Bull Put Spread, Bear Call Spread, and Straddle | `strategies/*.strategy.js` |
| 24 | Update each strategy's `init()` — subscribe to `CANDLE_CLOSE_5M` or `CANDLE_CLOSE_15M` based on `this.signalTimeframe` instead of hardcoding 15M | `strategies/*.strategy.js` |
| 25 | Verify `position-tracker.js` anti-hunt still listens to `CANDLE_CLOSE_15M` only — do not change | `monitoring/position-tracker.js` |

---

## Verification Gates (all must pass before Phase 5 starts)

| Gate | What it tests |
|------|--------------|
| Gate 1 | Basket order places all 4 legs in a single API call — verified via Dhan sandbox |
| Gate 2 | Two strategies can simultaneously hold `SIGNAL_DETECTED` without state collision |
| Gate 3 | Boot reconciliation detects orphaned Dhan orders and sends Telegram alert |
| Gate 4 | `ANTI_HUNT_VOLUME_REQUIRED=false` exits correctly on price breach when volume=0 |
| Gate 5 | `DANGEROUS_WINDOW_MODE=SUPPRESS_FIRST` holds on first breach, exits on second consecutive breach |
| Gate 6 | Options chain snapshot file created and appended correctly on each chain update |
| Gate 7 | Bull Put Spread fires on 5m candle close; Iron Condor fires on 15m candle close — both verified via test |
