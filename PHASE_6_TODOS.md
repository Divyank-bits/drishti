# Phase 6 — Equity Directional Scan: Task List

## What This Phase Builds

On-demand directional analysis for NSE F&O stocks via `/scan RELIANCE` Telegram command.
Fetches 1m/5m/15m candles, runs pluggable equity strategies (pattern detection + indicators),
scores multi-timeframe confluence, optionally invokes Claude for reasoning, and returns a
structured alert via Telegram.

**This phase is analysis-only — no equity order execution.**

---

## Scan Command Modes

| Command | Behaviour |
|---------|-----------|
| `/scan RELIANCE` | Rules only — runs all active equity strategies, no Claude |
| `/scan RELIANCE --claude` | Claude detects pattern freely from raw candle + indicator data |
| `/scan RELIANCE --confirm` | Rules run first, Claude adds reasoning on top of what rules found |

---

## Build Order (implement in this sequence)

### Block 1 — Config & Events Foundation
| # | Task | File |
|---|------|------|
| 1 | Add `EQUITY_SCAN_SYMBOLS`, `EQUITY_SCAN_CANDLE_TIMEFRAMES`, `EQUITY_SCAN_CONFLUENCE_THRESHOLD`, `EQUITY_SCAN_FORMING_THRESHOLD` to config | `config.js` |
| 2 | Add `EQUITY_SCAN_STARTED`, `EQUITY_SCAN_RESULT`, `EQUITY_PATTERN_FORMING`, `EQUITY_PATTERN_CONFIRMED` event constants | `core/events.js` |

### Block 2 — Equity Strategy Base System
| # | Task | File |
|---|------|------|
| 3 | Create `strategies/equity/` folder and `base.equity-strategy.js` — abstract base with `checkPattern(candles, indicators, context)` returning `{ patternName, direction, state, confidence, signals, timeframes }` | `strategies/equity/base.equity-strategy.js` |
| 4 | Create equity strategy registry — discovers all `*.equity-strategy.js` files in `strategies/equity/`, same auto-discovery pattern as options registry | `strategies/equity/registry.js` |

### Block 3 — Market Context Helpers
| # | Task | File |
|---|------|------|
| 5 | Create `data/equity-context.js` — fetches prev day OHLC (high/low/close as S/R levels), VWAP calculation from intraday ticks, and current day open. Exposes `getContext(symbol)` returning `{ prevDayHigh, prevDayLow, prevDayClose, vwap, dayOpen }` | `data/equity-context.js` |

### Block 4 — Five Named Equity Strategies
Each strategy extends `BaseEquityStrategy`. All use VWAP + volume confirmation. All return `state: "FORMING" | "CONFIRMED"`.

| # | Strategy | File | Trigger Conditions |
|---|----------|------|--------------------|
| 6 | Bull Flag | `strategies/equity/bull-flag.equity-strategy.js` | Strong up move on 15m, consolidation (lower volume, tight BB) on 5m, 1m starting to break consolidation high. VWAP below price. Volume on breakout > 1.5× avg. |
| 7 | Bear Flag | `strategies/equity/bear-flag.equity-strategy.js` | Inverse of bull flag. VWAP above price. Volume on breakdown > 1.5× avg. |
| 8 | Breakout | `strategies/equity/breakout.equity-strategy.js` | 15m close above prev day high with volume > 2× avg. EMA9 > EMA21. RSI > 60. Price > VWAP. |
| 9 | Breakdown | `strategies/equity/breakdown.equity-strategy.js` | 15m close below prev day low with volume > 2× avg. EMA9 < EMA21. RSI < 40. Price < VWAP. |
| 10 | Range Bound | `strategies/equity/range-bound.equity-strategy.js` | Price between prev day high/low for 3+ consecutive 15m candles. BB width contracting. RSI 40–60. Volume below avg. MACD near zero. |

### Block 5 — Multi-Timeframe Confluence Scorer
| # | Task | File |
|---|------|------|
| 11 | Create confluence scorer — takes results from all strategies across all 3 timeframes, computes weighted agreement score. Weights: 15m = 50%, 5m = 30%, 1m = 20%. Score ≥ `EQUITY_SCAN_CONFLUENCE_THRESHOLD` (default 65%) → `CONFIRMED`. Score ≥ `EQUITY_SCAN_FORMING_THRESHOLD` (default 40%) → `FORMING`. | `intelligence/confluence-scorer.js` |

### Block 6 — Symbol Scanner (Equity)
| # | Task | File |
|---|------|------|
| 12 | Create equity symbol scanner — orchestrates the full scan: fetch candles for all 3 timeframes → compute indicators → fetch equity context (VWAP, S/R) → run all equity strategies → score confluence → emit `EQUITY_PATTERN_FORMING` or `EQUITY_PATTERN_CONFIRMED` | `intelligence/equity-scanner.js` |

### Block 7 — Claude Integration for Equity Scan
| # | Task | File |
|---|------|------|
| 13 | Add `buildEquityScanPrompt(symbol, candles, indicators, context, strategyResults)` to prompt-builder — includes: symbol, VWAP, prev day S/R, candle summaries per timeframe, indicator values, strategy findings (if `--confirm` mode) | `intelligence/prompt-builder.js` |
| 14 | In `equity-scanner.js`, check scan mode flag — if `--claude`: skip rules, call Claude directly. If `--confirm`: run rules first, pass findings to Claude for reasoning layer. If neither: rules only, no Claude call | `intelligence/equity-scanner.js` |

### Block 8 — Telegram Wiring
| # | Task | File |
|---|------|------|
| 15 | Wire `/scan SYMBOL [--claude\|--confirm]` command — parse symbol + flag, trigger `equity-scanner.js`, format result as Telegram message with: pattern name, direction, state (FORMING/CONFIRMED), confluence score, VWAP position, key S/R levels, Claude reasoning (if applicable) | `notifications/telegram.js` |

### Block 9 — Journal
| # | Task | File |
|---|------|------|
| 16 | Write `EQUITY_SCAN_RESULT`, `EQUITY_PATTERN_FORMING`, `EQUITY_PATTERN_CONFIRMED` events to trade journal with full scan payload | `journal/trade-journal.js` |

### Block 10 — Tests & Completion
| # | Task | File |
|---|------|------|
| 17 | Unit tests for each equity strategy — fixture candles for each pattern (forming + confirmed state), volume edge cases, VWAP positioning | `test-phase6-strategies.js` |
| 18 | Unit tests for confluence scorer — weighted scoring, FORMING vs CONFIRMED thresholds, single-timeframe edge case | `test-phase6-confluence.js` |
| 19 | Integration test — `/scan RELIANCE` triggers full pipeline, correct event emitted, journal entry written. Claude bypass verified in rules-only mode. | `test-phase6-integration.js` |
| 20 | Add `test:phase6` script; verify all Phase 6 tests pass | `package.json` |
| 21 | Phase deliverable doc | `PHASE_6_COMPLETE.md` |

---

## Confluence Scoring (Multi-Timeframe Weighting)

| Timeframe | Weight | Rationale |
|-----------|--------|-----------|
| 15m | 50% | Primary trend — most reliable signal |
| 5m | 30% | Intermediate confirmation |
| 1m | 20% | Entry timing only — noisy, lowest weight |

**Confluence score** = sum of (strategy confidence × timeframe weight) across all passing strategies per timeframe.

| Score | State | Action |
|-------|-------|--------|
| ≥ 65% | `CONFIRMED` | Emit `EQUITY_PATTERN_CONFIRMED`, alert via Telegram |
| 40–64% | `FORMING` | Emit `EQUITY_PATTERN_FORMING`, alert as "watch this" |
| < 40% | No signal | No alert |

---

## Equity Context (S/R + VWAP)

Every scan includes:
- **Prev day high** — resistance level
- **Prev day low** — support level
- **Prev day close** — psychological level
- **Day open** — intraday reference
- **VWAP** — computed from intraday ticks; price above VWAP = bullish bias, below = bearish bias

All five levels are included in Claude prompts and Telegram output.

---

## Telegram Output Format

```
📊 RELIANCE — Bull Flag [CONFIRMED]
Direction: BULLISH
Confluence: 78% (15m: ✅ 5m: ✅ 1m: ⏳)

Price vs VWAP: Above (₹2847 vs ₹2831 VWAP) ✅
Key Levels: PDH ₹2865 | PDL ₹2798 | Day Open ₹2820

Signals:
• 15m: Strong up move, tight consolidation, volume drying up
• 5m: BB squeezing, EMA9 > EMA21
• 1m: Breaking consolidation high

[Claude Reasoning if --confirm mode]
"The bull flag structure is clean with volume contracting during consolidation..."

Mode: RULES+CLAUDE | 09:47:23
```

---

## What is Out of Scope for Phase 6

- No equity order execution (analysis only)
- No auto-scheduling (manual `/scan` trigger only)
- No real-time monitoring of flagged stocks after scan
- No stock fundamental data (P/E, earnings, news)
- No options chain analysis for stocks (that is Phase 5)

---

## Gates (all must pass before PHASE_6_COMPLETE.md)

| Gate | What it tests |
|------|--------------|
| Gate 1 | Bull flag detected correctly on fixture candles (FORMING and CONFIRMED states) |
| Gate 2 | Confluence scorer weights 15m/5m/1m correctly, threshold logic works |
| Gate 3 | VWAP computed correctly from intraday ticks |
| Gate 4 | Prev day high/low fetched and included in scan context |
| Gate 5 | In `--claude` mode, rules are skipped and Claude called directly |
| Gate 6 | In rules-only mode, Claude is never called |
| Gate 7 | `/scan RELIANCE` returns formatted Telegram message within 15s |
| Gate 8 | `EQUITY_PATTERN_CONFIRMED` written to trade journal with full payload |
