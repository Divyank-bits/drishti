# CLAUDE.md — Drishti Trading System

## What This Project Is

Drishti is a **local AI-powered options trading system** for Indian stock markets (NSE/BSE).
It runs on Node.js, trades NIFTY options (Iron Condor strategy), and uses Claude AI for
market analysis. All execution is local — no cloud deployment.

---

## Build Order (Strict — Never Skip Ahead)

Each phase is only started after the user explicitly confirms the previous phase passes tests.

| Phase | What Gets Built | Gate |
|-------|----------------|------|
| **0** | Architectural skeleton — event bus, state machine, circuit breakers, config | `test-phase0.js` PASS |
| **1** | Data layer — candle builder, historical fetch, options chain, indicators, tick stream | `test-phase1.js` PASS |
| **2** | Iron Condor paper trading — full strategy, Claude integration, anti-hunt, dashboard | `test-phase2.js` PASS |
| **3** | (Future) Live Dhan execution | User confirms Phase 2 |
| **4** | (Future) Multi-strategy expansion | User confirms Phase 3 |
| **5** | (Future) Deep scan / watchlist | User confirms Phase 4 |

**Do not implement code from a future phase while building the current one.**

---

## Folder Structure (Enforce Exactly)

```
/core
  event-bus.js          ← EventEmitter wrapper
  events.js             ← ALL event name constants (no magic strings anywhere)
  state-machine.js      ← position state machine
  circuit-breaker.js    ← kill switch logic
  session-context.js    ← day's accumulated market context

/strategies
  base.strategy.js      ← abstract base class (interface contract)
  registry.js           ← auto-discovers strategy files in this folder
  iron-condor.strategy.js

/data
  tick-stream.js        ← factory: selects source based on DATA_SOURCE config
  candle-builder.js     ← 1m/5m/15m OHLCV from ticks
  historical.js         ← startup candle fetch with fallback chain
  options-chain.js      ← NSE option chain fetcher
  indicator-engine.js   ← technicalindicators wrapper
  /sources
    nse-source.js       ← NSE LTP polling (Phase 1, DATA_SOURCE=NSE)
    dhan-source.js      ← Dhan WebSocket feed (Phase 3, DATA_SOURCE=DHAN)

/execution
  order-executor.js     ← abstract base interface
  paper-executor.js     ← simulated fills with slippage
  dhan-executor.js      ← real Dhan REST API (Phase 3+)

/intelligence
  claude-client.js      ← @anthropic-ai/sdk wrapper
  prompt-builder.js     ← assembles Claude prompts
  strategy-selector.js  ← routes AI vs RULES path

/monitoring
  position-tracker.js   ← real-time position monitoring
  anti-hunt.js          ← all 8 anti-hunt rules

/notifications
  telegram.js           ← send alerts + receive YES/NO approvals

/journal
  trade-journal.js      ← append-only NDJSON writer

/dashboard
  server.js             ← Express + SSE endpoint
  public/index.html     ← read-only live dashboard (vanilla JS)

config.js               ← all constants and flags (secrets via .env only)
index.js                ← app entry point / boot sequence
.env.example            ← all required keys listed, values empty
holidays.json           ← NSE market holidays list
```

---

## Non-Negotiable Design Rules

### 1. No Magic Strings
Every event name comes from `core/events.js`. Never write a raw string like `'TICK_RECEIVED'` outside that file.

### 2. Event-Driven Only
Modules communicate **only through the event bus**. No direct `require('../data/candle-builder').someMethod()` calls across domain boundaries. The event bus is the only coupling point.

### 3. State Machine Transitions Must Be Explicit
Position states and their valid transitions are defined in `core/state-machine.js`. Any invalid transition throws an error — it never silently succeeds.

**Valid states:**
```
IDLE → SIGNAL_DETECTED → AWAITING_APPROVAL → ORDER_PLACING
  → PARTIALLY_FILLED → ACTIVE → FLAGGED → HUNT_SUSPECTED
  → EXITING → CLOSED
FORCE_EXIT (reachable from any state — circuit breaker only)
```

### 4. Circuit Breakers Override Everything
The 7 circuit breakers in `core/circuit-breaker.js` are hardcoded limits. They cannot be disabled via config. When tripped:
- Emit `CIRCUIT_BREAKER_HIT` event
- Log reason with timestamp
- New entries killed; open positions still monitored until `FORCE_EXIT`

The 7 breakers:
1. Daily loss > `MAX_DAILY_LOSS` (₹5000)
2. 3 consecutive losses (`CONSECUTIVE_LOSS_PAUSE`)
3. Fill price > 5% from expected → reject + alert
4. WebSocket down > 30s with open position → emergency REST exit
5. Claude API down → rule-based exit only, no new entries
6. `ABSOLUTE_PNL_STOP_PCT` (50% of max loss) → immediate exit
7. Master `isTripped()` = true if ANY single breaker is triggered

### 5. Intelligence Mode Is Config-Driven
```
INTELLIGENCE_MODE: "HYBRID"   // default
```
- `"AI"` — Claude handles everything
- `"RULES"` — zero Claude API calls, pure rule engine
- `"HYBRID"` — rules filter first; Claude called only when score > `MATCH_SCORE_THRESHOLD`

The execution path below the `strategy-selector.js` is **identical regardless of mode**.

### 6. Executor Abstraction
`PaperExecutor` and `DhanExecutor` implement the same interface defined in `order-executor.js`. All logic above the executor layer is identical. Switching live/paper = one config flag change.

### 8. Data Source Abstraction
`DATA_SOURCE` and `EXECUTION_MODE` are independent config axes. You can paper-trade with Dhan live data (pre-live validation), or use NSE polling in paper mode (no subscription needed).

`tick-stream.js` is a factory that loads the correct source module. Each source in `data/sources/` emits identical `TICK_RECEIVED` events — nothing downstream knows or cares which source is active.

- `DATA_SOURCE: "NSE"` — NSE LTP polling every 3–5s (no paid subscription, Phase 1)
- `DATA_SOURCE: "DHAN"` — Dhan WebSocket feed (requires paid Data API subscription, Phase 3)

`historical.js` and `options-chain.js` branch internally on `DATA_SOURCE` via isolated `_fetchFromNSE()` / `_fetchFromDhan()` methods (Phase 3 adds the Dhan methods).

### 7. Immutable Trade Journal
`trade-journal.js` is append-only. Never modify existing entries. Every event written includes `{ timestamp, eventType, data }`.

---

## Config Reference (`config.js`)

All of these must exist. Secrets come from `.env`.

```js
INTELLIGENCE_MODE: "HYBRID"     // "AI" | "RULES" | "HYBRID"
EXECUTION_MODE: "PAPER"         // "PAPER" | "LIVE"
DATA_SOURCE: "NSE"              // "NSE" | "DHAN" — independent of EXECUTION_MODE
                                // NSE = polling, no subscription; DHAN = WebSocket, requires paid plan
MARKET_OPEN: "09:15"
MARKET_CLOSE: "15:30"
NO_NEW_TRADES_AFTER: "14:00"
SQUARE_OFF_TIME: "15:15"
CONFIDENCE_THRESHOLD: 0.70
MATCH_SCORE_THRESHOLD: 65       // rules filter threshold for HYBRID mode
MAX_TRADES_PER_DAY: 3
MAX_DAILY_LOSS: 5000            // rupees
CONSECUTIVE_LOSS_PAUSE: 3
ABSOLUTE_PNL_STOP_PCT: 0.50     // 50% of max loss → immediate exit
CLAUDE_MODEL: "claude-sonnet-4-5"
VIX_SAFE_MAX: 22
VIX_DANGER: 25
CANDLE_TIMEFRAMES: [1, 5, 15]   // minutes
OPTIONS_CHAIN_INTERVAL: 15      // minutes
WEBSOCKET_RECONNECT_TIMEOUT: 30 // seconds
```

---

## Coding Conventions

### File Header
Every file must start with a JSDoc comment:
```js
/**
 * @file candle-builder.js
 * @description Builds OHLCV candles for 1m, 5m, and 15m timeframes
 *              from raw tick events. Emits CANDLE_CLOSE_* events.
 */
```

### Log Format
```
[HH:mm:ss] [MODULE_NAME] [LEVEL] message
```
Example: `[09:32:14] [CandleBuilder] [INFO] 5m candle closed: NIFTY 24185`

Levels: `INFO`, `WARN`, `ERROR`, `DEBUG` (DEBUG only in development)

### Error Handling
All async operations must use `try/catch` with meaningful messages:
```js
// Good
} catch (err) {
  log.error(`[OptionsChain] Failed to fetch NSE option chain: ${err.message}`);
  eventBus.emit(EVENTS.OPTIONS_CHAIN_STALE, { reason: err.message });
}

// Bad
} catch (e) { console.error(e); }
```

### Secrets
- Never hardcode API keys, tokens, or secrets
- All secrets in `.env` file (git-ignored)
- `.env.example` must list every required key with empty values

### No Speculative Code
- Don't add error handling for scenarios that can't happen
- Don't build abstractions for hypothetical future requirements
- Don't add comments that restate what the code obviously does

---

## Required npm Packages

```json
"express": "^4.x",
"@anthropic-ai/sdk": "^0.x",
"technicalindicators": "^3.x",
"node-telegram-bot-api": "^0.x",
"node-cron": "^3.x",
"ws": "^8.x",
"axios": "^1.x",
"dayjs": "^1.x",
"black-scholes": "^1.x",
"dotenv": "^16.x"
```

---

## Anti-Hunt Rules (all 8 must be implemented in `anti-hunt.js`)

| # | Rule | When It Triggers |
|---|------|-----------------|
| 1 | Never exit on price touch | Exit only on 15m candle close beyond buffer |
| 2 | Buffer zones | 50-75 points beyond short strikes before considering exit |
| 3 | Volume confirmation | 1.5× average = real move; below average = likely hunt |
| 4 | Dangerous windows | 9:15–9:30, 11:30–11:45, 13:00–13:30, 14:45–15:00 IST — only absolute P&L stop triggers immediate exit |
| 5 | Delta monitoring | Flag when short CE delta > 0.35 or short PE delta < -0.35 |
| 6 | Absolute P&L stop | Loss > 50% of max → EXIT IMMEDIATELY, bypasses all other rules |
| 7 | Non-obvious strikes | If strike lands on exact hundred, shift +50 |
| 8 | Claude hunt detection | AI/HYBRID only, Claude not tripped — returns `{ isLikelyHunt, confidence, reasoning, action }` |

---

## Telegram Bot Commands

| Command | Action |
|---------|--------|
| `/status` | Current position, P&L, regime |
| `/mode [AI\|RULES\|HYBRID]` | Switch intelligence mode |
| `/pause` | Pause new entries (positions still monitored) |
| `/resume` | Resume entries |
| `/squareoff` | Manually trigger square-off |
| `/scan [SYMBOL]` | Trigger deep scan (Phase 5) |

Trade approval messages have a **3-minute timeout** — no response = auto-reject.
Every message footer shows current `INTELLIGENCE_MODE`.

---

## Iron Condor Strike Selection Rules

- Short CE = `maxCeOiLevel - 100`
- Short PE = `maxPeOiLevel + 100`
- Long CE  = Short CE + 200
- Long PE  = Short PE - 200
- If any short strike lands on an exact hundred (24000, 24100…) → shift +50
- Validate: range width > 300 points, risk/reward > 0.3

### Entry Conditions (all must pass)
- VIX: 14–22
- BB Width %: 2–4%
- BB not squeezing (width not contracting for 5+ consecutive candles)
- IV Percentile > 50%
- EMA9 and EMA21 within 0.2% of each other
- RSI: 40–60
- MACD line near zero
- NIFTY within 0.5% of day open
- PCR: 0.9–1.2
- Time: 09:30–14:00 IST
- Not flagged as major event day

---

## Phase Deliverables Checklist

After completing each phase, create `PHASE_X_COMPLETE.md` containing:
- What was built
- What each file does
- How to run the test script
- Known limitations

---

## What Not To Do

- Do not start Phase N+1 until the user confirms Phase N test script passes
- Do not use magic strings for event names — always import from `core/events.js`
- Do not make direct cross-module function calls — use the event bus
- Do not hardcode secrets
- Do not modify existing NDJSON journal entries
- Do not add features not in the current phase spec
- Do not use `console.log` directly — use the structured log format
- Do not allow invalid state machine transitions to silently pass
