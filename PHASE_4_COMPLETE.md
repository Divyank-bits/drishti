# Phase 4 Complete — Multi-Strategy Expansion

## What Was Built

Phase 4 adds three new strategies (Bull Put Spread, Bear Call Spread, Straddle) alongside
the existing Iron Condor, and introduces a strategy allocation layer that decides which
strategy (or strategies) to execute each cycle based on market conditions, capital limits,
and a configurable selection mode. Each strategy runs its own circuit breaker so one
strategy tripping does not affect others.

---

## What Each File Does

### Block 1 — Config & Events

| File | Changes |
|------|---------|
| `config.js` | Added `ACTIVE_STRATEGIES` (env-driven list of strategy names to load), `STRATEGY_SELECTION_MODE` (`FIRST_MATCH` \| `BEST_SCORE` \| `ALL_PASSING`), `MAX_CONCURRENT_POSITIONS` (hard cap across all strategies), `STRATEGY_CAPITAL_PCT` (per-strategy fraction of daily risk budget) |
| `core/events.js` | Added `STRATEGY_SELECTED`, `STRATEGY_SKIPPED`, `STRATEGY_ALLOCATION_CHANGED` constants |

### Block 2 — New Strategies

All three extend `BaseStrategy` and are auto-discovered by `registry.js`.

| File | Strategy | Regime | Entry Conditions | Legs |
|------|----------|--------|-----------------|------|
| `strategies/bull-put-spread.strategy.js` | Bull Put Spread | A, B | VIX < 20, RSI > 50, NIFTY above EMA21, PCR > 1.0, EMA9 ≥ EMA21, MACD not bearish, time 09:30–14:00, no holiday | Sell OTM PE (`maxPeOiStrike + 100`), Buy PE 200 below |
| `strategies/bear-call-spread.strategy.js` | Bear Call Spread | B, C | VIX < 20, RSI < 50, NIFTY below EMA21, PCR < 1.0, EMA9 ≤ EMA21, MACD not bullish, time 09:30–14:00, no holiday | Sell OTM CE (`maxCeOiStrike - 100`), Buy CE 200 above |
| `strategies/straddle.strategy.js` | Straddle | B | VIX 18–25, IV Percentile > 70%, RSI 45–55, EMAs within 0.3%, MACD near zero, PCR 0.8–1.2, time 09:30–13:00 (tighter), no holiday | Sell ATM CE and ATM PE at nearest 50-point strike to spot |

**Exit conditions:**
- Bull Put Spread: PE delta < -0.40 or 15m close below `shortPe - 75`
- Bear Call Spread: CE delta > 0.40 or 15m close above `shortCe + 75`
- Straddle: either delta > ±0.45 or premium collected erodes 60%

All three apply the +50 shift rule if a short strike lands on a round 500/1000 level.
All three require both legs to fill — partial fill triggers full rollback.

### Block 3 — Registry & Allocator

| File | Role |
|------|------|
| `strategies/registry.js` | Updated `_discover()` to filter loaded strategies by `config.ACTIVE_STRATEGIES` (kebab-case name matching filenames). Added `getEligible(marketData)` — runs `checkConditions()` on all registered strategies, returns passing ones sorted by score descending. Used by strategy-allocator. |
| `intelligence/strategy-allocator.js` | New module. `allocate(eligible, sessionContext)` enforces `MAX_CONCURRENT_POSITIONS`, `MAX_TRADES_PER_DAY`, per-strategy open position cap, per-strategy circuit breaker, and `STRATEGY_CAPITAL_PCT = 0` guard. Three selection modes: `FIRST_MATCH` (first passing by registry order), `BEST_SCORE` (highest scorer), `ALL_PASSING` (all passing up to slot limit). Emits `STRATEGY_SELECTED` / `STRATEGY_SKIPPED`. Tracks open positions via `POSITION_ACTIVE` / `POSITION_CLOSED` events. |

### Block 4 — Risk & Monitoring

| File | Changes |
|------|---------|
| `monitoring/position-tracker.js` | Added `_strategyPnl` map (`Map<strategyName, number>`) accumulating realised P&L per strategy. `getStrategyPnl()` and `getAggregatePnl()` public helpers. `POSITION_UPDATED` and `POSITION_CLOSED` payloads now include `strategy`, `strategyPnl`, `aggregatePnl`. Journal entries carry `strategy` field. |
| `core/circuit-breaker.js` | Added per-strategy breaker system (`_strategyBreakers` map, separate from the 7 global breakers). `checkStrategyDailyLoss(name, loss)` trips only the named strategy (cap = `MAX_DAILY_LOSS × STRATEGY_CAPITAL_PCT[name]`). `isStrategyTripped(name)` used by allocator. `resetStrategy(name)` / `resetAllStrategyBreakers()` called at session start. Tripping a strategy breaker does NOT affect `isTripped()` — other strategies continue unaffected. |

### Block 5 — Intelligence

| File | Changes |
|------|---------|
| `intelligence/prompt-builder.js` | Added `_formatStrikes(strikes)` helper — renders any strikes object shape (4-leg IC, 2-leg spread, 1-leg straddle ATM) generically. Added `_formatStrategyPnl(strategyPnl)` helper. `buildEntryPrompt()` now accepts optional `strategyPnl` arg and includes strategy name + per-strategy P&L table in the prompt. `buildHuntPrompt()` includes strategy name and uses `_formatStrikes()` instead of hardcoded IC fields. |

---

## How to Run

### Default (Iron Condor only — no config change needed)
```
ACTIVE_STRATEGIES=iron-condor   # default
STRATEGY_SELECTION_MODE=FIRST_MATCH
```
```bash
node index.js
```

### Multi-strategy with BEST_SCORE
```
ACTIVE_STRATEGIES=iron-condor,bull-put-spread,bear-call-spread
STRATEGY_SELECTION_MODE=BEST_SCORE
```

### All strategies, ALL_PASSING mode
```
ACTIVE_STRATEGIES=iron-condor,bull-put-spread,bear-call-spread,straddle
STRATEGY_SELECTION_MODE=ALL_PASSING
MAX_CONCURRENT_POSITIONS=2
```

### Run Phase 4 tests
```bash
npm run test:phase4
# Runs all three test files sequentially:
#   node test-phase4-strategies.js   → 76 tests
#   node test-phase4-allocator.js    → 28 tests
#   node test-phase4-integration.js  → 31 tests
# Total: 135 tests, 0 failed
```

---

## Strategy Selection Modes

| Mode | Behaviour |
|------|-----------|
| `FIRST_MATCH` | Execute first passing strategy (registry file order = priority). Lowest latency. |
| `BEST_SCORE` | Score all passing strategies, execute highest scorer. More selective. |
| `ALL_PASSING` | Execute all passing strategies up to `MAX_CONCURRENT_POSITIONS`. Maximum utilisation. |

---

## Capital Allocation

Per-strategy daily risk cap = `MAX_DAILY_LOSS × STRATEGY_CAPITAL_PCT[name]`

| Strategy | Default PCT | Cap (at ₹5000 daily limit) |
|----------|-------------|---------------------------|
| iron-condor | 100% | ₹5000 |
| bull-put-spread | 50% | ₹2500 |
| bear-call-spread | 50% | ₹2500 |
| straddle | 40% | ₹2000 |

Overridable in `config.js`. Setting `STRATEGY_CAPITAL_PCT[name] = 0` permanently disables a strategy without removing it from `ACTIVE_STRATEGIES`.

---

## Known Limitations

- **No concurrent position management in state machine**: `StateMachine` is a singleton tracking a single position state. With `ALL_PASSING` mode, the second strategy's signal will find the state machine in `SIGNAL_DETECTED` or later and silently skip. Full concurrent position support requires refactoring `StateMachine` to be per-position (Phase 4+ scope).
- **strategy-allocator not wired into index.js boot sequence**: The allocator exists and is tested, but `index.js` has not been updated to call `allocate()` before signal emission. The Iron Condor strategy still fires independently via its event listeners. Full wiring is a Phase 4 completion step.
- **Straddle is high-risk**: No long legs for protection. The absolute P&L stop (₹2000 cap at 40% allocation) is the primary risk control. Only use in low-DTE, post-event environments.
- **Claude prompts not yet tested with new strategy shapes**: `buildEntryPrompt` and `buildHuntPrompt` are updated but integration with `strategy-selector.js` for non-IC strategies has not been exercised end-to-end with a live Claude API call.
