# Drishti — System Architecture

This document describes the current state of the system for anyone (human or LLM) who needs
to understand how Drishti works without reading every source file.

---

## What the System Does

Drishti is a Node.js options trading system for Indian markets (NSE/BSE). It runs locally,
monitors NIFTY (and F&O watchlist symbols), detects options strategy entry signals using a
rule engine optionally confirmed by Claude AI, executes orders via Dhan broker, and monitors
open positions using anti-hunt logic. Everything communicates through a central event bus —
no module calls another module's methods directly across domain boundaries.

---

## Current System State

| Layer | Status |
|-------|--------|
| Event bus, state machine, circuit breakers | ✅ Built |
| Data layer (candles, indicators, options chain, tick stream) | ✅ Built |
| Iron Condor paper + live trading | ✅ Built |
| Bull Put Spread, Bear Call Spread, Straddle strategies | ✅ Built |
| Strategy allocator (multi-strategy selection) | ✅ Built, not yet wired in `index.js` |
| Live Dhan execution (WebSocket + REST) | ✅ Built |
| Anti-hunt monitoring (8 rules) | ✅ Built |
| Telegram bot (commands + trade approvals) | ✅ Built |
| Trade journal (append-only NDJSON) | ✅ Built |
| Multi-symbol scan / watchlist | 🔜 Phase 5 |
| Equity directional scan (pattern detection) | 🔜 Phase 6 |
| Backtesting + SQLite analytics | 🔜 Phase 7 |

**Known issues being fixed before Phase 5:**
- `DhanExecutor` places 4 legs sequentially — needs Dhan basket order API
- `StateMachine` is a singleton — needs to be per-position for multi-strategy
- No startup order reconciliation after crash
- Anti-hunt Rule 3 silently skips when `DATA_SOURCE=NSE` (volume always 0)

---

## End-to-End Data Flow

```
Market Data
    │
    ▼
[tick-stream.js] ──────────────────────────────── TICK_RECEIVED
    │ (factory: NSE polling or Dhan WebSocket)
    ▼
[candle-builder.js] ──────────── CANDLE_CLOSE_1M / 5M / 15M
    │
    ▼
[indicator-engine.js] ─────────── INDICATORS_UPDATED { timeframe, indicators }
    │ (EMA9, EMA21, RSI, MACD, Bollinger Bands)
    │
    │                    [options-chain.js] ──── OPTIONS_CHAIN_UPDATED
    │                         │                  { vix, pcr, atmStrike,
    │                         │                    underlyingValue, strikeData,
    │                         │                    maxCeOiStrike, maxPeOiStrike }
    ▼                         ▼
[strategy.checkConditions(marketData)]
    │  Returns: { eligible, score, failedConditions }
    │
    ▼
[strategy-selector.js]  ←── INTELLIGENCE_MODE config
    │  RULES:  eligible flag is final
    │  HYBRID: score must pass MATCH_SCORE_THRESHOLD (65), then Claude decides
    │  AI:     Claude decides, rule score is context only
    │
    ├── [claude-client.js] → Anthropic API
    │       prompt built by [prompt-builder.js]
    │       returns: { approved, confidence, reasoning, concerns }
    │
    ▼
  approved?
    │ NO  → SIGNAL_DISCARDED
    │ YES → SIGNAL_GENERATED
              │
              ▼
         [telegram.js] ── approval keyboard → user
              │  3-minute timeout, no response = auto-reject
              │
         USER_APPROVED / USER_REJECTED
              │
              ▼
         [executor.placeOrder(legs)]
              │  PaperExecutor: simulated fill with slippage
              │  DhanExecutor:  live MARKET orders on NSE_FNO
              │
         ORDER_FILLED { orderId, legs, premiumCollected }
              │
              ▼
         [position-tracker.js]
              │  Every TICK_RECEIVED  → POSITION_UPDATED (unrealised P&L)
              │  Every CANDLE_CLOSE_15M → anti-hunt.evaluate()
              │
              ├── shouldExit? → executor.exitOrder()
              │                  → ORDER_EXITED → POSITION_CLOSED
              │
              └── flagged?   → anti-hunt.evaluateWithClaude() (Rule 8)
                                → HUNT_DETECTION_RESULT
```

---

## Module Reference

### `core/event-bus.js`
Singleton EventEmitter wrapper. Every module imports this same instance.
No module holds a direct reference to another module — all coupling goes through here.

### `core/events.js`
Frozen object of all event name constants. **Never use raw strings for event names.**

Key events:
```js
TICK_RECEIVED              // { ltp, timestamp, symbol }
CANDLE_CLOSE_15M           // { open, high, low, close, volume, openTime }
INDICATORS_UPDATED         // { timeframe, indicators: { ema9, ema21, rsi, macd, bb } }
OPTIONS_CHAIN_UPDATED      // { vix, pcr, atmStrike, underlyingValue, strikeData, maxCeOiStrike, maxPeOiStrike }
SIGNAL_GENERATED           // { strategy, strikes, legs, intelligenceMode, confidence, reasoning }
SIGNAL_DISCARDED           // { strategy, strikes, reason, mode }
ORDER_FILLED               // { orderId, legs, premiumCollected, timestamp }
ORDER_EXITED               // { orderId, legs, realisedPnl, timestamp }
POSITION_UPDATED           // { orderId, strategy, unrealisedPnl, aggregatePnl, ltp }
POSITION_CLOSED            // { orderId, strategy, realisedPnl, aggregatePnl, duration, reason }
CIRCUIT_BREAKER_HIT        // { breakerName, reason, timestamp }
STRATEGY_SELECTED          // { strategy, score, mode }
STRATEGY_SKIPPED           // { strategy, score, reason }
```

### `core/state-machine.js`
Tracks position lifecycle state. Currently a singleton (known issue — should be per-position).

Valid transitions:
```
IDLE → SIGNAL_DETECTED → AWAITING_APPROVAL → ORDER_PLACING
     → PARTIALLY_FILLED → ACTIVE → FLAGGED → HUNT_SUSPECTED
     → EXITING → CLOSED
FORCE_EXIT  ← reachable from any state (circuit breaker only)
```
Invalid transitions throw — they never silently succeed.

### `core/circuit-breaker.js`
7 global breakers (hardcoded, cannot be disabled via config):
1. `daily_loss` — pnlToday < -₹5000
2. `consecutive_loss` — 3 consecutive losing trades
3. `fill_price_deviation` — fill > 5% from expected
4. `websocket_timeout` — WS down > 30s with open position
5. `claude_api` — Claude API unavailable
6. `absolute_pnl_stop` — position loss > 50% of MAX_DAILY_LOSS
7. `manual_pause` — `/pause` Telegram command

Per-strategy breakers (Phase 4): `checkStrategyDailyLoss(name, loss)` — trips only that strategy, does not affect `isTripped()`.

### `core/session-context.js`
Singleton (`SessionContext.shared`). Accumulates day's context.

```js
snapshot() → {
  date, dayOpen, dayHigh, dayLow,
  firstHourHigh, firstHourLow, firstHourComplete,
  vixAtOpen, vixCurrent,
  currentRegime,           // "A" | "B" | "C"
  tradesToday, pnlToday, consecutiveLosses, wins, losses,
  isPaused, claudeAvailable
}
```

---

## Strategy System

### `strategies/base.strategy.js`
Abstract base class. All strategies must implement:

```js
get name()             → string           // "Iron Condor"
get regime()           → string|string[]  // "A" | ["A","B"]
get claudeDescription()→ string           // plain text for Claude system prompt

checkConditions(marketData) → {
  eligible: boolean,
  score: number,          // 0–100
  failedConditions: string[]
}

buildTrade(marketData) → {
  strikes: object,        // { shortCe, longCe, shortPe, longPe } for IC
  legs: Array<{ type, strike, action }>,
  expectedPremium: number|null
}

validatePartialFill(filledLegs) → boolean  // false = rollback all legs
```

### `strategies/registry.js`
Auto-discovers `*.strategy.js` files in `/strategies`. Filters by `config.ACTIVE_STRATEGIES`.

```js
getAll()                  → BaseStrategy[]
getEligible(marketData)   → Array<{ strategy, result }>  // sorted by score desc
getBestForMarket(marketData, regime) → { strategy, result } | null
```

### Active Strategies

| Strategy | File | Regime | Key Conditions |
|----------|------|--------|---------------|
| Iron Condor | `iron-condor.strategy.js` | A, B, C | VIX 14–22, RSI 40–60, EMAs within 0.2%, PCR 0.9–1.2, BB width 2–4% |
| Bull Put Spread | `bull-put-spread.strategy.js` | A, B | VIX < 20, RSI > 50, NIFTY above EMA21, PCR > 1.0 |
| Bear Call Spread | `bear-call-spread.strategy.js` | B, C | VIX < 20, RSI < 50, NIFTY below EMA21, PCR < 1.0 |
| Straddle | `straddle.strategy.js` | B | VIX 18–25, IV Pct > 70%, RSI 45–55, EMAs within 0.3% |

---

## Intelligence Layer

### `intelligence/strategy-selector.js`
Routes signals through configured intelligence mode.

```js
select(signal, signalPayload, sessionCtx, candles15m) → Promise<{
  approved: boolean,
  confidence: number,   // 0.0–1.0
  reasoning: string,
  mode: string          // "RULES" | "AI" | "HYBRID" | "RULES_FALLBACK"
}>
```

Decision logic:
- `HYBRID`: score < `MATCH_SCORE_THRESHOLD` (65) → reject without Claude call
- Falls back to `RULES` automatically if `claudeClient.isAvailable()` is false
- Confidence gate: Claude approval rejected if `confidence < CONFIDENCE_THRESHOLD` (0.70)

### `intelligence/strategy-allocator.js`
Selects which strategies to execute based on `STRATEGY_SELECTION_MODE`.

```js
allocate(eligible, sessionContext) → Array<{ strategy, result }>
```

Modes: `FIRST_MATCH` | `BEST_SCORE` | `ALL_PASSING`

Enforces: `MAX_CONCURRENT_POSITIONS`, `MAX_TRADES_PER_DAY`, per-strategy open position cap, per-strategy circuit breaker.

### `intelligence/claude-client.js`
Anthropic SDK wrapper.

```js
call(prompt)        → Promise<string>   // raw text response
parseJSON(text)     → object | null     // strips markdown fences before parsing
isAvailable()       → boolean           // false if breaker 5 tripped
```

Races API call against `CLAUDE_TIMEOUT_MS`. On failure: trips circuit breaker 5, emits `CIRCUIT_BREAKER_HIT`.

### `intelligence/prompt-builder.js`
```js
buildEntryPrompt(signalPayload, sessionCtx, candles15m) → string
// Claude returns: { approved, confidence, reasoning, concerns }

buildHuntPrompt(position, candle, sessionCtx) → string
// Claude returns: { isLikelyHunt, confidence, reasoning, action }
```

---

## Execution Layer

### `execution/order-executor.js`
Abstract interface. Both executors implement:
```js
placeOrder(legs)          → Promise<fill>
exitOrder(orderId)        → Promise<exitResult>
computeUnrealisedPnl(fill)→ number
```

### `execution/paper-executor.js`
Simulated fills. Fixed slippage per lot. Tracks open orders in memory.
Selected when `EXECUTION_MODE=PAPER`.

### `execution/dhan-executor.js`
Live Dhan REST API. Places each leg as a separate `MARKET` order on `NSE_FNO`.
Polls `/orders/{id}` until `TRADED` or terminal state. Rolls back on failure.
Selected when `EXECUTION_MODE=LIVE`.

**Known issue:** Sequential leg placement — if leg 3 fails, legs 1+2 may already be filled.
Basket order API fix pending in Pre-Phase 5.

---

## Monitoring Layer

### `monitoring/anti-hunt.js`
Pure function — no event bus, no side effects.

```js
evaluate(position, candle, sessionContext) → {
  shouldExit: boolean,
  flagged: boolean,
  rule: number | null,
  reason: string
}

evaluateWithClaude(position, candle, sessionCtx) → Promise<{
  isLikelyHunt: boolean,
  confidence: number,
  reasoning: string,
  action: string   // "EXIT" | "HOLD" | "MONITOR"
}>
```

Rule evaluation order: **6 → 4 → 1+2 → 3 → 5**

| Rule | What it does |
|------|-------------|
| 1 | Exit only on 15m candle close, never on price touch |
| 2 | 50pt buffer beyond short strike before considering exit |
| 3 | Volume must be > 1.5× average — low volume = likely hunt |
| 4 | Dangerous windows (9:15–9:30, 11:30–11:45, 13:00–13:30, 14:45–15:00) — block all exits |
| 5 | Delta flag: CE delta > 0.35 or PE delta < -0.35 |
| 6 | Absolute P&L stop: loss > 50% of MAX_DAILY_LOSS → EXIT, bypasses all rules |
| 7 | Strike selection: shift +50 if short strike lands on round 500/1000 level |
| 8 | Claude hunt detection (AI/HYBRID only) — called when Rule 5 flags position |

**Config knobs (Pre-Phase 5):**
- `ANTI_HUNT_VOLUME_REQUIRED: false` — skips Rule 3 (required when `DATA_SOURCE=NSE`, volume=0)
- `ANTI_HUNT_DANGEROUS_WINDOW_MODE: "SUPPRESS_FIRST"` — exits on second consecutive breach in window instead of blocking all exits

### `monitoring/position-tracker.js`
Wires event bus to anti-hunt and executor. Manages full exit lifecycle.
Tracks per-strategy realised P&L via `_strategyPnl` map.

---

## Data Layer

### `data/tick-stream.js`
Factory — selects source based on `config.DATA_SOURCE`.
All sources emit identical `TICK_RECEIVED` events.

| `DATA_SOURCE` | Source | Feed type |
|---------------|--------|-----------|
| `NSE` | `nse-source.js` | HTTP polling every 3–5s, no volume data |
| `DHAN` | `dhan-source.js` | WebSocket binary feed, auto-reconnects up to 5× |

### `data/candle-builder.js`
Builds 1m, 5m, 15m OHLCV candles from `TICK_RECEIVED` events.
Emits `CANDLE_CLOSE_1M`, `CANDLE_CLOSE_5M`, `CANDLE_CLOSE_15M`.

### `data/indicator-engine.js`
Listens to `CANDLE_CLOSE_15M`, computes indicators via `technicalindicators` package.
Emits `INDICATORS_UPDATED { timeframe: 15, indicators: { ema9, ema21, rsi, macd, bb } }`.

### `data/options-chain.js`
Fetches NSE/Dhan options chain every `OPTIONS_CHAIN_INTERVAL` (15 min).
Emits `OPTIONS_CHAIN_UPDATED` with full strike data including `ceSecurityId`/`peSecurityId`
needed by `DhanExecutor` for live order placement.

### `data/historical.js`
Fetches startup candle history on boot. Fallback chain: Dhan → NSE → Yahoo → cache.

---

## Notifications

### `notifications/telegram.js`
Two-direction bot. Outbound: trade approval keyboard (3-min timeout), alerts, P&L summaries.
Inbound commands:

| Command | Action |
|---------|--------|
| `/status` | Current position, P&L, regime |
| `/mode [AI\|RULES\|HYBRID]` | Switch intelligence mode |
| `/pause` | Pause new entries |
| `/resume` | Resume + reset consecutive loss breaker |
| `/squareoff` | Manual square-off |
| `/scan [SYMBOL]` | Deep scan (Phase 5+) |

---

## Journal

### `journal/trade-journal.js`
Append-only NDJSON writer. Each line: `{ timestamp, eventType, data }`.
Never modifies existing entries.

```js
write(eventType, data)      → void    // appends one line
restoreFromJournal()        → { pnlToday, tradesToday }  // called on boot
```

---

## Config Axes (Independent of Each Other)

```
DATA_SOURCE:       "NSE" | "DHAN"     — where market data comes from
EXECUTION_MODE:    "PAPER" | "LIVE"   — how orders are placed
INTELLIGENCE_MODE: "RULES" | "HYBRID" | "AI"  — how signals are confirmed
```

Valid combinations:

| DATA_SOURCE | EXECUTION_MODE | Use case |
|-------------|----------------|----------|
| NSE | PAPER | Development, zero subscriptions needed |
| DHAN | PAPER | Pre-live validation with real market data |
| DHAN | LIVE | Production |

---

## Boot Sequence (`index.js`)

```
1. Validate environment variables
2. Wire event bus system listeners
3. Instantiate CircuitBreaker
4. Get SessionContext.shared
5. Load strategy registry (auto-discovers strategies)
6. Data layer: historical.fetch() → optionsChain.start() → tickStream.start()
7. Trading layer: journal.restoreFromJournal() → executor → strategies → positionTracker → telegram.start()
8. Intelligence layer: claudeClient availability check
```

Boot fails fast — any step failure exits the process immediately.

---

## Project Structure

```
/core               event bus, state machine, circuit breakers, session context
/strategies         options trading strategies + registry
/strategies/equity  Phase 6: equity directional strategies (not yet built)
/data               tick stream, candle builder, indicator engine, options chain, historical
/data/sources       nse-source.js (polling), dhan-source.js (WebSocket)
/execution          order-executor (abstract), paper-executor, dhan-executor
/intelligence       claude-client, prompt-builder, strategy-selector, strategy-allocator
/monitoring         position-tracker, anti-hunt
/notifications      telegram bot
/journal            append-only NDJSON trade log
/dashboard          Express + SSE server, vanilla JS read-only dashboard
/tests              all test files (phase0 through phase4 + ad-hoc)
/snapshots          daily options chain snapshots, git-ignored (Pre-Phase 5+)
/backtest           Phase 7: candle replayer, runner, report (not yet built)
/analytics          Phase 7: SQLite query helpers (not yet built)
config.js           all constants and flags
index.js            boot sequence entry point
holidays.json       NSE market holidays
```

---

## Key Design Constraints

1. **No magic strings** — all event names from `core/events.js`
2. **Event-driven only** — no direct cross-module method calls across domain boundaries
3. **Circuit breakers are hardcoded** — cannot be disabled via config
4. **Trade journal is immutable** — append only, never modify existing entries
5. **Executor abstraction** — paper/live swap = one config flag, zero code change
6. **Data source abstraction** — NSE/DHAN swap = one config flag, zero code change
7. **Intelligence mode abstraction** — RULES/HYBRID/AI swap = one config flag, execution path below `strategy-selector` is identical
