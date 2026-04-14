# Phase 2 — Rules-Based Iron Condor Paper Trading

**Date:** 2026-04-14
**Project:** Drishti — Local AI-powered NIFTY options trading system
**Phase:** 2 of 5
**Status:** Approved, pending implementation

---

## Context

Phase 1 built the full data pipeline: live NIFTY ticks → candle buffers → indicators → session context → options chain. Phase 2 wires trading logic on top of that event stream: entry signal detection, paper execution, anti-hunt monitoring, Telegram approvals, and trade journaling.

Phase 1 gate: 29/29 tests pass. `stock-nse-india` library handles NSE session cookies automatically.

---

## Decisions Made

| Question | Decision |
|----------|----------|
| Intelligence mode | RULES only — AI/HYBRID deferred to later phase |
| Dashboard/frontend | Removed from Phase 2 scope entirely |
| Telegram | Both directions fully working (outbound alerts + inbound commands) |
| Paper executor slippage | Fixed (₹/lot) — designed for spread-based swap in Phase 3 |
| Lot size | Config-driven (`LOT_SIZE: 75`) |
| Test structure | Independent file per subsystem + one integration test |
| Trade journal | Mechanical entries + `reasoning: null` (forward-compatible for AI mode) |
| Anti-hunt Rule 8 | Skipped silently in RULES mode — no warning |
| Volume unavailable | Rule 3 returns neutral/skip when `candle.volume === 0` |
| Delta breach (Rule 5) | Telegram "High Risk Alert" — flag only, not exit |

---

## Architecture

Phase 2 adds new listeners and emitters to the Phase 1 event bus. No Phase 1 files are modified.

```
Phase 1 events (inputs to Phase 2)
  INDICATORS_UPDATED    ──► iron-condor.strategy.js
  OPTIONS_CHAIN_UPDATED ──► iron-condor.strategy.js
  CANDLE_CLOSE_15M      ──► position-tracker.js (exit monitoring)
  TICK_RECEIVED         ──► position-tracker.js (P&L updates)

Phase 2 new events
  TRADE_SIGNAL        ← strategy emits when all 11 conditions pass
  TRADE_APPROVED      ← telegram emits after user says YES
  TRADE_REJECTED      ← telegram emits on NO or 3-min timeout
  ORDER_FILLED        ← paper-executor emits with actual fill prices
  POSITION_UPDATED    ← position-tracker emits on each P&L recalc
  POSITION_FLAGGED    ← anti-hunt emits when Rule 5 delta threshold breached
  EXIT_SIGNAL         ← anti-hunt or position-tracker emits exit decision
  ORDER_EXITED        ← paper-executor emits after exit fill
  TRADE_CLOSED        ← journal writes, state machine → CLOSED
  CIRCUIT_BREAKER_HIT ← Phase 0 breakers now fully wired
```

**Full trade flow:**
```
INDICATORS_UPDATED (15m) + OPTIONS_CHAIN_UPDATED (both cached, evaluated together)
  → strategy scores all 11 conditions
  → all pass → emit TRADE_SIGNAL
  → telegram sends approval message with inline YES/NO keyboard (3-min timeout)
  → TRADE_APPROVED → paper-executor simulates fill → ORDER_FILLED
  → position-tracker starts monitoring on TICK_RECEIVED + CANDLE_CLOSE_15M
  → anti-hunt.evaluate() called on each 15m close
  → EXIT_SIGNAL → paper-executor simulates exit → ORDER_EXITED → TRADE_CLOSED
  → journal appends TRADE_CLOSED entry
```

**State machine wired for real:**
`IDLE → SIGNAL_DETECTED → AWAITING_APPROVAL → ORDER_PLACING → ACTIVE → EXITING → CLOSED`

---

## Files

### `execution/order-executor.js`

Abstract base class defining the executor interface. Both `PaperExecutor` and future `DhanExecutor` implement this.

```js
// Abstract interface
placeOrder(legs)   // Promise<fill>
exitOrder(orderId) // Promise<fill>
```

---

### `execution/paper-executor.js`

Simulates fills. Uses last cached `TICK_RECEIVED` ltp as the fill price basis.

**Fill model:**
- Buy legs: `ltp + SLIPPAGE_PER_LOT`
- Sell legs: `ltp - SLIPPAGE_PER_LOT`
- `ltp` = last value from `TICK_RECEIVED` event, cached module-level

**P&L:**
- Entry premium = (sell CE price − buy CE price) + (sell PE price − buy PE price) × lot size
- Unrealised P&L = current premium − entry premium (inverted: profit on decay)
- Realised P&L = exit premium paid − entry premium collected

**Emits:** `ORDER_FILLED`, `ORDER_EXITED`

**Config additions:**
```js
LOT_SIZE: 75,
SLIPPAGE_PER_LOT: 1.5,  // ₹ — swap point for spread-based (Phase 3)
```

**Note:** `SLIPPAGE_PER_LOT` is the designed swap point. When Phase 3 adds spread-based slippage, only the fill calculation inside `paper-executor.js` changes — interface and callers are unaffected.

---

### `journal/trade-journal.js`

Append-only NDJSON writer. File: `journal/trades.ndjson` (git-ignored, created on first write).

**Event types written:**
```js
{ timestamp, eventType: 'TRADE_SIGNAL',     data: { strikes, scores, indicators } }
{ timestamp, eventType: 'TRADE_APPROVED',   data: { approvedBy: 'TELEGRAM' } }
{ timestamp, eventType: 'ORDER_FILLED',     data: { legs, fillPrices, premiumCollected } }
{ timestamp, eventType: 'POSITION_UPDATED', data: { unrealisedPnl, ltpAtUpdate } }
{ timestamp, eventType: 'POSITION_FLAGGED', data: { rule, reason } }
{ timestamp, eventType: 'ORDER_EXITED',     data: { exitPrices, realisedPnl } }
{ timestamp, eventType: 'TRADE_CLOSED',     data: { realisedPnl, duration, reasoning: null } }
```

**Boot restore:** On startup, reads today's entries from `trades.ndjson` and restores `pnlToday` and `tradesToday` into `SessionContext`. Fixes the Phase 1 known limitation where these reset to 0 on restart.

**Interface:**
```js
journal.write(eventType, data)   // appends one line, never modifies existing
journal.readToday()              // returns array of today's entries (date-keyed by timestamp)
```

`reasoning: null` in `TRADE_CLOSED` is a forward-compatibility placeholder — populated when AI/HYBRID mode is added, no schema change needed.

---

### `strategies/iron-condor.strategy.js`

Extends `base.strategy.js`. Listens to `INDICATORS_UPDATED` (15m) and `OPTIONS_CHAIN_UPDATED` — caches both, evaluates entry only when both are present and fresh.

**Strike selection:**
```
Short CE = maxCeOiStrike - 100
Short PE = maxPeOiStrike + 100
Long CE  = Short CE + 200
Long PE  = Short PE - 200
If any short strike is on exact hundred (24000, 24100…) → shift +50
Validate: range width > 300 points, risk/reward > 0.3
```

**Entry conditions — all 11 must pass (all-or-nothing in RULES mode):**

| # | Condition | Value |
|---|-----------|-------|
| 1 | VIX | 14–22 |
| 2 | BB Width % | 2–4% |
| 3 | BB not squeezing | width not contracting for 5+ consecutive 15m candles |
| 4 | IV Percentile proxy | BB width percentile > 50% (real IV% deferred to Phase 3) |
| 5 | EMA9 vs EMA21 | within 0.2% of each other |
| 6 | RSI | 40–60 |
| 7 | MACD line | abs(macd) < `MACD_ZERO_THRESHOLD` |
| 8 | NIFTY vs day open | within 0.5% |
| 9 | PCR | 0.9–1.2 |
| 10 | Time window | 09:30–14:00 IST |
| 11 | Not major event day | checked against `holidays.json` (extended with event dates) |

**Guards before emitting TRADE_SIGNAL:**
- State machine must be `IDLE` — skip evaluation if not
- `circuitBreaker.isTripped()` must be false

**Emits:** `TRADE_SIGNAL { strikes, legs, indicatorSnapshot, optionsSnapshot, timestamp }`

**Config additions:**
```js
MACD_ZERO_THRESHOLD: 2.0,
IV_PERCENTILE_PROXY_MIN: 50,
```

---

### `monitoring/position-tracker.js`

Starts after `ORDER_FILLED`. Monitors position until `TRADE_CLOSED`.

- Caches entry fill data (strikes, premiums, lot size)
- On `TICK_RECEIVED`: recalculates unrealised P&L → emits `POSITION_UPDATED` → writes to journal
- On `CANDLE_CLOSE_15M`: calls `antiHunt.evaluate(position, candle, sessionContext)` → if `shouldExit` → emits `EXIT_SIGNAL`
- On `EXIT_SIGNAL`: calls paper-executor to exit → `ORDER_EXITED` → `TRADE_CLOSED`
- Square-off at 15:15 IST: forces `EXIT_SIGNAL` regardless of P&L

---

### `monitoring/anti-hunt.js`

Pure logic module — no event bus imports. Called by `position-tracker.js` with position state + candle + session context.

```js
antiHunt.evaluate(position, candle, sessionContext)
// returns { shouldExit, rule, reason } or { shouldExit: false }
```

**Rule evaluation order (strict):**

1. **Rule 6** — Absolute P&L stop: loss > 50% of `MAX_DAILY_LOSS` → `{ shouldExit: true, rule: 6 }` immediately, bypasses everything
2. **Rule 4** — Dangerous window check: if current IST time is inside 09:15–09:30, 11:30–11:45, 13:00–13:30, 14:45–15:00 → `{ shouldExit: false }` (only Rule 6 can exit here)
3. **Rule 1** — No exit on price touch: only evaluate exit if 15m candle *closes* beyond buffer (not merely touches)
4. **Rule 2** — Buffer zone: price must be 50–75pts beyond short strike to consider exit
5. **Rule 3** — Volume confirmation: if `candle.volume === 0` → skip rule (neutral, NSE source limitation). If volume available: `volume > 1.5× avgVolume` = real move; below avg = likely hunt
6. **Rule 5** — Delta monitoring: if short CE delta > 0.35 or short PE delta < −0.35 → `position-tracker` emits `POSITION_FLAGGED`, Telegram sends "High Risk Alert". Not an exit signal.
7. **Rule 7** — Non-obvious strikes: applied at entry in strategy, not re-evaluated here
8. **Rule 8** — Claude hunt detection: skipped silently in RULES mode

---

### `notifications/telegram.js`

Two-direction bot using `node-telegram-bot-api`. Responds only to `config.TELEGRAM_CHAT_ID` — all other senders silently ignored.

**Outbound triggers:**

| Event | Message |
|-------|---------|
| `TRADE_SIGNAL` | Approval request with strikes, premium, indicator snapshot + inline YES/NO keyboard |
| `POSITION_FLAGGED` | "⚠️ High Risk Alert" with delta values |
| `CIRCUIT_BREAKER_HIT` | Circuit breaker alert with reason |
| `OPTIONS_CHAIN_STALE` | Data warning |
| `TRADE_CLOSED` | Trade summary with realised P&L |

**Trade approval flow:**
```
TRADE_SIGNAL received
  → send message with inline YES/NO keyboard
  → start 3-min countdown (TRADE_APPROVAL_TIMEOUT_MS)
  → YES pressed → emit TRADE_APPROVED
  → NO pressed  → emit TRADE_REJECTED
  → timeout     → emit TRADE_REJECTED, send "Auto-rejected (timeout)" message
```

**Inbound commands:**

| Command | Action |
|---------|--------|
| `/status` | Current position, unrealised P&L, session P&L, regime (null in Phase 2) |
| `/mode [AI\|RULES\|HYBRID]` | Switches `config.INTELLIGENCE_MODE` at runtime; AI/HYBRID reply "not implemented yet" |
| `/pause` | Sets internal pause flag — strategy skips `TRADE_SIGNAL` emission |
| `/resume` | Clears pause flag |
| `/squareoff` | Emits `EXIT_SIGNAL` directly |

**Every outbound message footer shows current `INTELLIGENCE_MODE`.**

**Config additions (via .env):**
```js
TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID,
TRADE_APPROVAL_TIMEOUT_MS: 180000,
```

---

## Test Plan

Six independent test files + one integration test. All synthetic — no live APIs.

| Gate | File | Covers |
|------|------|--------|
| 1 | `test-phase2-executor.js` | Fill simulation, P&L math, slippage applied, lot size respected |
| 2 | `test-phase2-journal.js` | Append-only writes, read-back, boot restore of pnlToday/tradesToday |
| 3 | `test-phase2-strategy.js` | All 11 conditions pass → signal; 11 near-miss cases (each condition fails in isolation while other 10 pass) |
| 4 | `test-phase2-antihunt.js` | Each rule in isolation; rule priority order; volume=0 skip; dangerous window near-miss (price 60pts beyond strike + 11:35 IST → no exit) |
| 5 | `test-phase2-telegram.js` | Approval YES/NO/timeout flow; unknown sender ignored; /pause sets flag |
| 6 | `test-phase2-integration.js` | Full loop: synthetic signal → approval → fill → 15m close → exit → journal entry |

**npm script:**
```json
"test:phase2": "node test-phase2-executor.js && node test-phase2-journal.js && node test-phase2-strategy.js && node test-phase2-antihunt.js && node test-phase2-telegram.js && node test-phase2-integration.js"
```

---

## Config Changes Summary

```js
// execution
LOT_SIZE: 75,
SLIPPAGE_PER_LOT: 1.5,

// strategy
MACD_ZERO_THRESHOLD: 2.0,
IV_PERCENTILE_PROXY_MIN: 50,

// telegram
TRADE_APPROVAL_TIMEOUT_MS: 180000,
```

`.env` additions:
```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

---

## What Phase 2 Does NOT Include

- `INTELLIGENCE_MODE: "AI"` or `"HYBRID"` — Claude client, prompt builder, strategy selector
- Anti-hunt Rule 8 (Claude hunt detection)
- Spread-based slippage in paper executor (swap point is designed in — only fill calculation changes)
- Real IV Percentile (BB width proxy used as stand-in)
- Dashboard / frontend
- `DATA_SOURCE=DHAN` tick source (Phase 3)

---

## Known Limitations (By Design)

- `reasoning: null` in all journal `TRADE_CLOSED` entries until AI/HYBRID mode added
- IV Percentile is a proxy (BB width) — not true historical implied volatility
- Volume always 0 on NSE source → Rule 3 always skips → anti-hunt relies on Rules 1, 2, 4, 6 for exit decisions
- `/mode AI` and `/mode HYBRID` are accepted commands but reply "not implemented yet"
