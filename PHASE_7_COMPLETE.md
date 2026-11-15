# PHASE_7_COMPLETE.md — Swing Setup Engine & Setup Backtester

## What Was Built

A fully offline swing analysis engine for NSE daily equities. No Telegram, no scheduler, no Claude calls — pure data processing and rule evaluation.

### Components

| Component | Description |
|-----------|-------------|
| **Daily candle store** | SQLite-backed OHLCV store with Yahoo → Dhan fallback, incremental sync, sanity checks |
| **Analysis library** | Pure functions: candle patterns, pivot detection, S/R levels, indicators, divergence, Fibonacci, Heikin Ashi |
| **Feature builder** | `buildFeatures(daily)` computes all series in one pass; `tideAt(daily, i)` for weekly Tide |
| **Swing setup registry** | Auto-discovers `*.swing-setup.js`, validates inheritance |
| **6 swing setups** | SMM Checklist, Soldiers/Crows, Counter Attack, Sandwich, Mother Candle, Fake Breakout |
| **Backtester** | Per-symbol/setup/direction simulation, one-trade-at-a-time, all Trade Simulation Rules |
| **Report** | Console table + `setup_stats` upsert; baseline R; subtype breakdown |
| **CLI** | `node swing-backtest.js` with full flag set |

---

## Files Changed / Created

### New files
| File | Purpose |
|------|---------|
| `analysis/candles.js` | 15 candlestick pattern detectors + anatomy helpers |
| `analysis/swings.js` | Pivot detection, S/R level clustering, `trendAt` |
| `analysis/swing-indicators.js` | EMA, MACD, Stoch, RSI, BB, ADX, ATR, volume ratio, Heikin Ashi |
| `analysis/divergence.js` | Regular bullish/bearish divergence |
| `analysis/fibonacci.js` | Fibonacci retracement of last swing leg |
| `analysis/features.js` | `buildFeatures`, `tideAt` |
| `data/daily-candles.js` | `sync`, `get`, `toWeekly` |
| `strategies/swing/base.swing-setup.js` | Abstract base + `hatAt`, `targetFor`, `riskReward`, `naRow` |
| `strategies/swing/registry.js` | Auto-discovers and validates setup plugins |
| `strategies/swing/smm-checklist.swing-setup.js` | SMM Decision Check List |
| `strategies/swing/soldiers-crows.swing-setup.js` | PAPA #3/#4 |
| `strategies/swing/counter-attack.swing-setup.js` | PAPA #5/#6 |
| `strategies/swing/sandwich.swing-setup.js` | PAPA #7 |
| `strategies/swing/mother-candle.swing-setup.js` | PAPA #16/#17/#18 |
| `strategies/swing/fake-breakout.swing-setup.js` | PAPA #12/#13 |
| `backtest/swing-backtester.js` | Main backtest loop + trade simulation |
| `backtest/swing-report.js` | Metrics, console report, `setup_stats` writer |
| `swing-backtest.js` | CLI entry point |
| `tests/test-phase7-candles.js` | 64 candle pattern unit tests |
| `tests/test-phase7-analysis.js` | 56 analysis/indicator unit tests |
| `tests/test-phase7-setups.js` | 127 setup plugin unit tests |
| `tests/test-phase7-backtester.js` | 18 backtester logic unit tests |
| `tests/test-phase7-lookahead.js` | 78 no-lookahead gate tests |

### Modified files
| File | Change |
|------|--------|
| `CLAUDE.md` | Updated build order table, added Phase 7 folder structure |
| `.gitignore` | Added `drishti.db*`, `backtest-results/` |
| `config.js` | Added full `SWING_*` section |
| `core/events.js` | Added `SWING_BACKTEST_STARTED`, `SWING_BACKTEST_COMPLETED` |
| `data/db.js` | Added `daily_candles`, `setup_stats` tables + prepared statements |
| `data/historical.js` | `fetchForSymbol(symbol, timeframe=15)` accepts timeframe argument |
| `intelligence/equity-scanner.js` | Passes timeframe to `fetchForSymbol` |
| `data/equity-context.js` | Added `computeSessionVwap` |
| `tests/test-phase6-integration.js` | Gates 13b, 13c |
| `package.json` | Added `test:phase7`, `swing:sync`, `swing:backtest` scripts |

---

## How to Run

```bash
# Sync daily candles (requires network)
npm run swing:sync

# Run in-sample backtest
npm run swing:backtest

# CLI options
node swing-backtest.js [--setup <id>] [--symbols A,B,C] [--from YYYY-MM-DD] [--to YYYY-MM-DD] \
  [--exit TARGET_SL|TRAIL_EMA] [--no-rr-gate] [--sample IS|OOS|BOTH]
```

---

## Test Results

```
npm run test:phase7
  Phase 7 Candles:    64 passed,  0 failed
  Phase 7 Analysis:   56 passed,  0 failed
  Setup tests:       127 passed,  0 failed
  Backtester tests:   18 passed,  0 failed
  Lookahead tests:    78 passed,  0 failed
                     ─────────────────────
  Total:             343 passed,  0 failed
```

---

## Assumptions Used

All `[assumption]` defaults from PHASE_7_TODOS.md were kept as-is. No thresholds were changed.

| Config Key | Value | Source |
|-----------|-------|--------|
| `SWING_PIVOT_K` | 5 | [assumption] |
| `SWING_LEVEL_LOOKBACK` | 250 | [assumption] |
| `SWING_LEVEL_CLUSTER_PCT` | 1.0% | [assumption] |
| `SWING_AT_LEVEL_PCT` | 1.0% | [assumption] |
| `SWING_VOLUME_AVG_PERIOD` | 10 | [assumption: "last few days"] |
| `SWING_HEAVY_VOLUME_MULT` | 1.0 | (course: "more than average") |
| `SWING_CROSSOVER_LOOKBACK` | 3 | (course: "in last 3 periods") |
| `SWING_MIN_RR` | 3 | (course) |
| `SWING_TIDE_INDICATOR` | `MACD_LINE` | confirmed by user |
| `SWING_WAVE_OSCILLATOR` | `STOCH` | — |
| `SWING_STOCH_OVERSOLD` | 30 | [assumption] |
| `SWING_STOCH_OVERBOUGHT` | 70 | [assumption] |
| `SWING_SMALL_BODY_PCT` | 30% | [assumption] |
| `SWING_STRONG_BODY_PCT` | 60% | [assumption] |
| `SWING_WICK_BODY_MULT` | 2 | (course: 2–3×) |
| `SWING_MOTHER_ATR_MULT` | 1.5 | [assumption] |
| `SWING_MOTHER_MIN_INSIDE` | 3 | [assumption] |
| `SWING_SETUP_VALID_BARS` | 10 | [assumption] |
| `SWING_BT_COST_PCT` | 0.30% | confirmed by user |
| `SWING_BT_MAX_HOLD_DAYS` | 40 | [assumption] |
| `SWING_BT_OOS_FRACTION` | 0.30 | — |
| `SWING_BT_MIN_TRADES` | 30 | — |
| Three Soldiers body ≥ 50% of range | 50% | [assumption] |
| Doji body ≤ 10% of range | 10% | [assumption] |
| Tweezers within 0.2% | 0.2% | [assumption] |
| Counter-attack trigger window | 3 bars | [assumption] |
| Sandwich range ≤ 2 × ATR14 | 2× | [assumption] |
| "At bottom/top" lookback | 10 bars | (course spec) |

---

## Undefined Terms (NA rows)

The following course terms appear as `status: 'NA'` in the setup rows, as they are not defined in the available course material:

| Term | Setup | Phase Available |
|------|-------|----------------|
| Ungli setup | smm-checklist | Phase 8, after open question 2 |
| BKT (Breakout) | fake-breakout, mother-candle | Phase 8, after open question 2 |
| BKP (Breakdown Point) | mother-candle | Phase 8, after open question 2 |
| BBC (BB channel) | counter-attack | Phase 8, after open question 2 |
| BBNC | — | Phase 8, after open question 2 |

---

## In-Sample Backtest Results (IS, 2021–2026)

Universe: NIFTY50 large-caps. Exit mode: TARGET_SL. RR gate: > 3. Cost: 0.30% round-trip.

| Setup | Dir | Trades | Win% | Avg R | Note |
|-------|-----|--------|------|-------|------|
| smm-checklist | LONG | 5 | 60% | +1.24R | LOW_SAMPLE |
| smm-checklist | SHORT | 11 | 18% | -1.96R | LOW_SAMPLE, bull mkt |
| fake-breakout | LONG | 65 | 43% | +0.60R | |
| sandwich | LONG | 197 | 35% | +0.77R | |
| counter-attack | LONG | 160 | 36% | +0.07R | |
| soldiers-crows | LONG | — | — | — | LOW_SAMPLE |
| mother-candle | LONG | — | — | — | LOW_SAMPLE |
| All SHORT setups | SHORT | — | — | negative | Expected in 2021-2026 bull market |

SHORT setups losing in this period is expected behavior (5-year bull market in Indian large-caps).
LOW_SAMPLE setups require more data or a longer history period before drawing conclusions.

---

## Checkpoint Status

- **Checkpoint A**: Confirmed — analysis output reviewed before setups were built.
- **Checkpoint B**: Confirmed by user — IS report reviewed, pattern-name bug fixed (camelCase → kebab-case in PRIORITY list), re-ran IS, results look plausible.
- **Out-of-sample run**: Run `node swing-backtest.js --sample BOTH` to touch OOS data for the first time (once only, per spec).

---

## Known Limitations

- **Survivorship bias**: universe is today's large caps; delisted stocks not included.
- **Multiple setups tested simultaneously**: some will look good by chance. Treat positive results as candidates requiring out-of-sample confirmation and later paper trading.
- **Mechanical proxies**: "major level", "at bottom", "ranging" are coded approximations of what the course teaches visually.
- **NA/JUDGMENT rows**: the backtest scores a reduced version of each checklist (chart pattern rows, BKT/BKP rows all excluded from scoring).
- **Daily bars only**: intraday stop vs target order inside one bar is unknown.
- **Short trades**: simulated on daily cash prices (not futures). No financing or roll costs.
- **Data quality**: unadjusted corporate actions may appear as outliers; the sanity check warns but does not fix.
- **tideAt performance**: rebuilds weekly candles from scratch each call; acceptable for single-bar evaluation, potentially slow for large backtests. Consider caching if needed.
