# Phase 4 — Multi-Strategy Expansion: Task List

## Build Order (implement in this sequence)

### Block 1 — Config & Events Foundation
| # | Task | File |
|---|------|------|
| 1 | Add `ACTIVE_STRATEGIES`, `MAX_CONCURRENT_POSITIONS`, `STRATEGY_SELECTION_MODE`, per-strategy `MAX_CAPITAL_PCT` | `config.js` |
| 2 | Add `STRATEGY_SELECTED`, `STRATEGY_SKIPPED`, `STRATEGY_ALLOCATION_CHANGED` event constants | `core/events.js` |

### Block 2 — New Strategies
| # | Task | File |
|---|------|------|
| 3 | Bull Put Spread — entry conditions, strike selection, exit logic extending `base.strategy.js` | `strategies/bull-put-spread.strategy.js` |
| 4 | Bear Call Spread — entry conditions, strike selection, exit logic extending `base.strategy.js` | `strategies/bear-call-spread.strategy.js` |
| 5 | Straddle — entry conditions suited to high-IV breakout regime, extending `base.strategy.js` | `strategies/straddle.strategy.js` |

### Block 3 — Registry & Allocator
| # | Task | File |
|---|------|------|
| 6 | Upgrade registry to load `ACTIVE_STRATEGIES` from config, enforce base interface, expose `getEligible(marketContext)` returning scored list | `strategies/registry.js` |
| 7 | Strategy allocator — given `getEligible()` output and active positions, selects strategy per `STRATEGY_SELECTION_MODE` (FIRST_MATCH \| BEST_SCORE \| ALL_PASSING); enforces capital caps and `MAX_TRADES_PER_DAY` | `intelligence/strategy-allocator.js` |

### Block 4 — Risk & Monitoring Updates
| # | Task | File |
|---|------|------|
| 8 | Track positions keyed by `strategyId`, compute per-strategy and aggregate P&L, add `strategyId` to `POSITION_UPDATED` payload | `monitoring/position-tracker.js` |
| 9 | Add per-strategy daily loss limit check — tripping one strategy's breaker must not halt others | `core/circuit-breaker.js` |

### Block 5 — Intelligence Update
| # | Task | File |
|---|------|------|
| 10 | Include active strategy name and per-strategy P&L in Claude context payloads | `intelligence/prompt-builder.js` |

### Block 6 — Tests & Completion
| # | Task | File |
|---|------|------|
| 13 | Unit tests for Bull Put Spread, Bear Call Spread, Straddle — entry/exit/strike logic (≥10 tests each) | `test-phase4-strategies.js` |
| 14 | Allocator tests — all 3 `STRATEGY_SELECTION_MODE` values, capital cap enforcement, concurrent position limit enforcement | `test-phase4-allocator.js` |
| 15 | Integration test — 2 strategies active simultaneously, independent position tracking, circuit breaker isolation | `test-phase4-integration.js` |
| 16 | Add `test:phase4` script; verify all Phase 4 tests pass | `package.json` |
| 17 | Phase deliverable doc | `PHASE_4_COMPLETE.md` |

---

## Strategy Specs

### Bull Put Spread
- Sell OTM PE at `maxPeOiLevel + 100`, buy PE 200 points below
- Entry: VIX < 20, RSI > 50, NIFTY above EMA21, PCR > 1.0
- Exit: short PE delta < -0.40, or 15m candle close below short strike buffer

### Bear Call Spread
- Sell OTM CE at `maxCeOiLevel - 100`, buy CE 200 points above
- Entry: VIX < 20, RSI < 50, NIFTY below EMA21, PCR < 1.0
- Exit: short CE delta > 0.40, or 15m candle close above short strike buffer

### Straddle
- Sell ATM CE and ATM PE at same strike (nearest to spot)
- Entry: IV Percentile > 70%, VIX 18–25, RSI 45–55, within 30 min of event resolution
- Exit: net premium erodes 60%, or either leg delta breaches ±0.45

---

## Strategy Selection Modes

| Mode | Behaviour |
|------|-----------|
| `FIRST_MATCH` | Execute first strategy whose rules pass (registry order = priority) |
| `BEST_SCORE` | Score all passing strategies, execute highest scorer |
| `ALL_PASSING` | Execute every passing strategy up to `MAX_CONCURRENT_POSITIONS` |

---

## Gates (all must pass before PHASE_4_COMPLETE.md)

| Gate | What it tests |
|------|--------------|
| Gate 1 | Registry loads all 3 new strategies, rejects file missing required interface methods |
| Gate 2 | Bull Put Spread entry/exit conditions fire correctly on fixture data |
| Gate 3 | Bear Call Spread entry/exit conditions fire correctly on fixture data |
| Gate 4 | Straddle entry/exit conditions fire correctly on fixture data |
| Gate 5 | Allocator returns correct strategy for all 3 `STRATEGY_SELECTION_MODE` values |
| Gate 6 | Capital cap enforced — allocator rejects trade when per-strategy `MAX_CAPITAL_PCT` exhausted |
| Gate 7 | Circuit breaker isolation — tripping one strategy's daily loss limit does not halt the other |
| Gate 8 | Telegram `/status` command reports per-strategy P&L for all active strategies |
