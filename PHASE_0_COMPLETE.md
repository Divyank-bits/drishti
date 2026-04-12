# Phase 0 Complete — Architectural Skeleton

## What Was Built

The full application skeleton. No trading logic. All modules importable and
testable without external API calls. App boots with "System ready" log.

---

## Files Created

### Root
| File | What it does |
|------|-------------|
| `package.json` | npm project config, all 10 dependencies, npm scripts |
| `config.js` | All constants + flags. Secrets from .env only. Derived constants calculated. |
| `index.js` | Boot sequence: validate env → event bus → circuit breaker → session context → registry → SYSTEM_READY |
| `.env.example` | All required env keys listed with empty values |
| `holidays.json` | NSE trading holidays for 2025 |

### core/
| File | What it does |
|------|-------------|
| `events.js` | 40+ event name constants. No magic strings anywhere else. |
| `event-bus.js` | Singleton EventEmitter. Debug logger in dev mode (logs every event + timestamp). |
| `state-machine.js` | 10 states, full valid transition map, FORCE_EXIT from any active state. Throws on invalid transition. Emits STATE_TRANSITION. |
| `circuit-breaker.js` | 7 breakers: daily_loss, consecutive_loss, fill_price_deviation, websocket_timeout, claude_api, absolute_pnl_stop, manual_pause. Each has check/trip/reset. Master isTripped() method. |
| `session-context.js` | Day context: P&L, trades, streak, regime, VIX, first-hour levels. recordTrade(), updateRegime(), update(), snapshot(). Phase 1 hooks are stubs. |

### strategies/
| File | What it does |
|------|-------------|
| `base.strategy.js` | Abstract base class with 5 methods + 2 getters that all strategies must implement. Throws descriptive errors if not implemented. |
| `registry.js` | Auto-discovers *.strategy.js files. Validates they extend BaseStrategy. getBestForMarket() scores all eligible strategies. Singleton. |

---

## How to Run

```bash
# Install dependencies (first time only)
npm install

# Run Phase 0 tests
npm run test:phase0

# Boot the app (requires .env with API keys)
cp .env.example .env
# fill in .env values, then:
npm start

# Development mode (verbose event logging)
npm run dev
```

---

## Test Results

```
16 tests — 16 passed, 0 failed

T01  EventBus: emit 5 events and confirm receipt
T02  EventBus: off() removes listener
T03  StateMachine: all valid linear transitions succeed
T03b StateMachine: all extra valid transitions succeed
T04  StateMachine: invalid transitions throw errors
T05  StateMachine: FORCE_EXIT from all eligible states
T06  StateMachine: FORCE_EXIT from IDLE throws
T07  CircuitBreaker: all 7 breakers trip correctly
T08  CircuitBreaker: isTripped() true when any breaker trips
T09  CircuitBreaker: reset() clears individual breaker
T10  CircuitBreaker: resetAll() clears everything
T11  SessionContext: update() and snapshot()
T12  SessionContext: recordTrade() P&L and streak tracking
T13  SessionContext: updateRegime() tracks changes
T14  Registry: loads without error, 0 strategies in Phase 0
T15  Config: all required fields present with correct types
```

---

## Known Limitations (By Design)

- `SessionContext._hookEvents()` is a stub — hooks wired in Phase 1
- No actual data flowing yet (no tick stream, no candles, no options chain)
- `index.js` boot sequence has placeholder comments for Phase 1 + 2 steps
- Registry shows 0 strategies — `iron-condor.strategy.js` added in Phase 2
- No dashboard server, no Telegram bot, no executors — all Phase 2

---

## What Phase 1 Will Add

- `data/candle-builder.js` — 1m/5m/15m candles from ticks
- `data/historical.js` — startup candle fetch with 3-source fallback
- `data/options-chain.js` — NSE option chain (PCR, OI, VIX)
- `data/indicator-engine.js` — RSI, EMA, MACD, BB, ATR, ADX, delta
- `data/tick-stream.js` — Dhan WebSocket live feed
- `session-context.js` Phase 1 hooks wired up
- `test-phase1.js` — synthetic tick feeding + all indicator tests
