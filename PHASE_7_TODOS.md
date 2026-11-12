# Phase 7 — Swing Setup Engine & Setup Backtester: Task List

> **Before you start (human step):** this file replaces the old Phase 7 plan (options
> backtesting). Run `git mv PHASE_7_TODOS.md PHASE_9_TODOS.md` first, then save this file as
> `PHASE_7_TODOS.md`. The options backtest still needs weeks of stored snapshots, so it moves
> to Phase 9. Phase 8 will be the evening scanner, `/smm` command, risk module and journal.

## What This Phase Builds

A daily/weekly ("swing") analysis engine for NSE equities, plus a backtester that scores each
trade setup on historical data **before** any of them is allowed to raise an alert.

1. Daily candle store in SQLite, with weekly candles aggregated locally.
2. A pure analysis library: candlestick patterns, swing pivots, support/resistance levels,
   swing indicators, divergence, Fibonacci retracement.
3. Swing setups as plugins (one file per setup), all returning one result shape.
4. A setup backtester and report: per-setup win rate, expectancy in R, drawdown, sample size,
   in-sample vs out-of-sample.

**This phase is offline analysis only.** No Telegram command, no scheduler, no orders, no
Claude calls. Those are Phase 8.

**Source of the rules:** the user's course material (SMM Decision Check List, PAPA Decision
Sheet, SMM/PAPA concept decks). Where the course gives no number, this file sets a default
and marks it **[assumption]**. Do not invent further rules. If something is unspecified and
not covered here, stop and ask.

---

## Non-Negotiables For This Phase

| # | Rule |
|---|------|
| 1 | **No lookahead.** A result for day `i` may use only candles `0..i`. A swing pivot at bar `t` is only "known" from bar `t + SWING_PIVOT_K`. Gate 4 tests this. |
| 2 | **No tuning.** Defaults in this file are fixed before the first backtest run. Do not change any threshold to improve results. Any change the user approves is logged in `PHASE_7_COMPLETE.md` with the reason. |
| 3 | **Out-of-sample data is touched once.** Development and debugging use the in-sample window only. |
| 4 | **Pure functions.** Everything in `/analysis` and every setup's `evaluate()` has no I/O, no network, no clock, no event emission. |
| 5 | **No magic strings.** New event names go in `core/events.js`; new constants go in `config.js`. |
| 6 | **Tests are offline.** `npm run test:phase7` must pass with no network. Live-data checks are separate ad-hoc scripts. |
| 7 | **Undefined course terms stay out.** "Ungli setup", "BKT", "BKP", "BBC", "BBNC" are not defined in the material. Any row that needs them returns `status: 'NA'` with `detail: 'undefined in source material'`. Do not guess. |

`/analysis` is a pure library (same standing as `technicalindicators`). The backtester is an
offline CLI and may `require` the swing registry and data layer directly, as
`intelligence/equity-scanner.js` already does. It must not boot `index.js`.

---

## New Folder Structure (add to CLAUDE.md)

```
/analysis                      ← Phase 7: pure functions, no I/O
  candles.js                   ← candle anatomy + candlestick pattern detection
  swings.js                    ← pivot detection, trend structure, S/R levels
  swing-indicators.js          ← EMA/MACD/Stochastic/RSI/BB/ADX/Heikin Ashi/volume series
  divergence.js                ← regular bullish/bearish divergence
  fibonacci.js                 ← retracement of the last swing leg
  features.js                  ← buildFeatures(daily) → all series, index-aligned

/data
  daily-candles.js             ← Phase 7: daily OHLCV fetch + SQLite cache + weekly aggregation

/strategies/swing              ← Phase 7: swing setups (separate from /strategies/equity)
  base.swing-setup.js
  registry.js
  smm-checklist.swing-setup.js
  soldiers-crows.swing-setup.js
  counter-attack.swing-setup.js
  sandwich.swing-setup.js
  mother-candle.swing-setup.js
  fake-breakout.swing-setup.js

/backtest
  swing-backtester.js          ← Phase 7: walks history, simulates trades
  swing-report.js              ← Phase 7: metrics + console report + setup_stats writer

swing-backtest.js              ← Phase 7: CLI entry point
/tests/fixtures/swing          ← hand-built candle fixtures (JSON)
```

---

## Build Order (implement in this sequence)

### Block 0 — Housekeeping
| # | Task | File |
|---|------|------|
| 1 | Confirm `PHASE_9_TODOS.md` exists (old options-backtest plan). If it does not, stop and tell the user. | — |
| 2 | Update the Build Order table: Phase 7 = "Swing setup engine + setup backtester", Phase 8 = "Evening scanner, `/smm`, risk module, journal", Phase 9 = "Options backtesting + analytics (optional)". Add the folder structure above. | `CLAUDE.md` |
| 3 | Add `drishti.db`, `drishti.db-shm`, `drishti.db-wal`, `backtest-results/` to `.gitignore`. Run `git rm --cached drishti.db drishti.db-shm drishti.db-wal`. Do **not** delete the files from disk. | `.gitignore` |

### Block 1 — Phase 6 Carry-Over Fixes
These are the "Known Limitations" from `PHASE_6_COMPLETE.md`. Keep them small.

| # | Task | File |
|---|------|------|
| 4 | `fetchForSymbol(symbol, timeframe = 15)` — fetch real 1m / 5m / 15m candles (Yahoo `interval=1m|5m|15m`; note Yahoo limits 1m history to a few days). Existing callers with one argument keep working. | `data/historical.js` |
| 5 | `_fetchCandles(symbol, timeframe)` must pass `timeframe` through, so each timeframe gets its own candles. | `intelligence/equity-scanner.js` |
| 6 | Add `computeSessionVwap(candles)` — VWAP from today's intraday candles: `Σ(typicalPrice × volume) / Σ(volume)` where `typicalPrice = (H+L+C)/3`. `getContext()` uses it when no ticks were recorded. Returns `null` when volume is zero. | `data/equity-context.js` |
| 7 | Extend Phase 6 tests: three timeframes receive different candle arrays; VWAP is non-null from a candle fixture. `npm run test:phase6` still passes. | `tests/test-phase6-integration.js` |

### Block 2 — Config, Events, Daily Data Layer
| # | Task | File |
|---|------|------|
| 8 | Add the `SWING_*` config keys listed under **Config Keys** below. | `config.js` |
| 9 | Add `SWING_BACKTEST_STARTED`, `SWING_BACKTEST_COMPLETED`. | `core/events.js` |
| 10 | Add tables `daily_candles` and `setup_stats` (schema below) and prepared statements `upsertDailyCandle`, `getDailyCandles(symbol, from, to)`, `upsertSetupStats`. Update the file header comment: the DB is now read by the offline backtester. | `data/db.js` |
| 11 | `daily-candles.js`: `sync(symbol)` fetches `SWING_HISTORY_YEARS` of daily OHLCV and upserts; on later calls it fetches only missing days. `get(symbol, from, to)` reads from SQLite, oldest first, shape `{ date, open, high, low, close, volume }`. Primary source: Yahoo `interval=1d`. Fallback: Dhan daily historical — **read the Dhan v2 API docs for the daily endpoint first; do not guess parameters** (the existing 15m call is known to return too few candles). | `data/daily-candles.js` |
| 12 | Data sanity check inside `sync()`: drop rows with null/zero close; log `WARN` for any day-over-day gap above 25% (likely an unadjusted split or bad row) and for missing runs longer than 5 trading days. Store whatever the source gives; do not "repair" prices. | `data/daily-candles.js` |
| 13 | `toWeekly(daily)`: group by ISO week. Open = first open, High = highest high, Low = lowest low, Close = last close, Volume = sum. The last week may be partial; mark it `partial: true`. | `data/daily-candles.js` |
| 14 | Add npm script `swing:sync` — syncs every symbol in `SWING_UNIVERSE`, prints rows per symbol. | `package.json` |

### Block 3 — Analysis Library
All functions pure. All series are arrays index-aligned with the input candles, `null` where
not yet computable.

| # | Task | File |
|---|------|------|
| 15 | Candle anatomy: `body`, `range`, `upperWick`, `lowerWick`, `median` (= midpoint of the body, `(open+close)/2`), `isBullish`, `isBearish`. | `analysis/candles.js` |
| 16 | Pattern detectors, each `(candles, i) → boolean`, exactly as defined under **Candlestick Definitions**. Plus `detectAll(candles, i) → { bullish: [...names], bearish: [...names], neutral: [...names] }`. | `analysis/candles.js` |
| 17 | `findPivots(candles, k)` — a pivot high at `t` has the highest high of bars `t-k..t+k`; pivot low mirrors. Each pivot carries `confirmedAt = t + k`. `pivotsKnownAt(pivots, i)` returns only those with `confirmedAt <= i`. | `analysis/swings.js` |
| 18 | `levelsAt(candles, pivots, i)` — support/resistance as of bar `i`: cluster known pivots from the last `SWING_LEVEL_LOOKBACK` bars whose prices are within `SWING_LEVEL_CLUSTER_PCT` of each other. A level is **major** when it has 2+ touches, or is the highest high / lowest low of the lookback. Returns `{ supports: [...], resistances: [...] }` sorted by distance from `candles[i].close`. | `analysis/swings.js` |
| 19 | `trendAt(features, i)` → `'UP' | 'DOWN' | 'SIDEWAYS'`: UP when EMA 5 > 13 > 26 > 50; DOWN when 5 < 13 < 26 < 50; else SIDEWAYS. (SMM "Trend" slide.) | `analysis/swings.js` |
| 20 | Series builders using `technicalindicators`: EMA 5/13/26/50, MACD(12,26,9) line/signal/histogram, Stochastic, RSI(14), Bollinger(20, 2) and (20, 3), ADX(14) with +DI/−DI, ATR(14), volume ratio (`volume / average volume of the previous SWING_VOLUME_AVG_PERIOD bars`, excluding the current bar). | `analysis/swing-indicators.js` |
| 21 | Heikin Ashi series using the course formulas: `haClose = (O+H+L+C)/4`; `haOpen = (prev haOpen + prev haClose)/2`; `haHigh = max(H, haOpen)`; `haLow = min(L, haOpen)`. Flags: `decisiveBull` (no lower wick), `decisiveBear` (no upper wick). | `analysis/swing-indicators.js` |
| 22 | `crossedAbove(a, b, i, lookback)` / `crossedBelow(...)` — true when `a` crossed `b` on any of the last `lookback` bars ending at `i`. | `analysis/swing-indicators.js` |
| 23 | Regular divergence as of `i`, using known pivots only. Bullish: price makes an equal or lower pivot low while the oscillator makes a higher low. Bearish: price makes an equal or higher pivot high while the oscillator makes a lower high. Returns `{ bullish, bearish, on: 'RSI'|'STOCH' }`. | `analysis/divergence.js` |
| 24 | `retracementAt(candles, pivots, i)` — retracement % of the last completed swing leg. Classify per SMM row 5: `<= 50` → `HEALTHY`, `>= 61.8` → `WATCHFUL`, between → `NEUTRAL`. | `analysis/fibonacci.js` |
| 25 | `buildFeatures(daily)` — computes every series once and returns one object. Setups read `features.x[i]` and must never read an index above `i`. | `analysis/features.js` |
| 26 | `tideAt(daily, i)` — builds weekly candles from days `0..i` (completed weeks plus the in-progress week), computes the Tide indicator, returns `'UP' | 'DOWN' | 'FLAT_AFTER_DOWN' | 'FLAT_AFTER_UP'`. Hint: cache EMA state at each completed week so each day costs one extra step, not a full recompute. | `analysis/features.js` |

**⛔ STOP — Checkpoint A.** Run the Block 3 unit tests. Then print, for one symbol, the last 30
days of detected patterns, pivots, levels and Tide. Show the user and wait for confirmation
that the detections look right on a real chart before building setups.

### Block 4 — Swing Setup Plugin System
| # | Task | File |
|---|------|------|
| 27 | Abstract base with getters `id`, `name`, `sourceRef` (e.g. `'PAPA #5/#6'`), `directions`, and `evaluate({ daily, features, i, direction })` returning the **Setup Result Shape** below. | `strategies/swing/base.swing-setup.js` |
| 28 | Registry — auto-discovers `*.swing-setup.js`, validates inheritance and getters, exposes `getAll()`, `getById()`. Same pattern as `strategies/equity/registry.js`. | `strategies/swing/registry.js` |
| 29 | Shared helpers: `hatAt(daily, features, i)` (Tide + Wave → `'BULL' | 'BEAR' | 'NONE'`), `targetFor(levels, entry, direction)` (nearest **major** level beyond entry; `null` if none), `riskReward(entry, stop, target, direction)`. | `strategies/swing/base.swing-setup.js` |
| 30–35 | Implement the six setups exactly as specified under **Setup Specifications**. Each handles LONG and SHORT. | `strategies/swing/*.swing-setup.js` |

### Block 5 — Backtester & Report
| # | Task | File |
|---|------|------|
| 36 | `run({ symbols, setups, from, to, exitMode, rrGate })` — for each symbol: load daily candles, `buildFeatures`, then for each day `i` call each setup. On `state === 'TRIGGERED'` open a simulated trade per **Trade Simulation Rules**. One open trade per symbol + setup + direction at a time. | `backtest/swing-backtester.js` |
| 37 | Collect per trade: symbol, setup, direction, subtype, signal date, entry date/price, stop, target, exit date/price, exit reason, holding days, result in R (after costs). Write all trades to `backtest-results/YYYY-MM-DD-swing.ndjson`. | `backtest/swing-backtester.js` |
| 38 | Metrics per setup × direction, separately for in-sample and out-of-sample: trades, win rate, average R, expectancy (R), profit factor, max drawdown (R), max consecutive losses, average holding days, signals blocked by the RR gate. Flag `LOW_SAMPLE` when trades < `SWING_BT_MIN_TRADES`. | `backtest/swing-report.js` |
| 39 | Baseline per setup: the mean forward return of the same symbols over the setup's median holding period, sampled on **all** days, expressed in the setup's average R unit. Shows whether the setup beats simply holding. | `backtest/swing-report.js` |
| 40 | Console report (format below) and upsert one row per setup × direction × sample into `setup_stats`. | `backtest/swing-report.js` |
| 41 | CLI: `node swing-backtest.js [--setup <id>] [--symbols A,B] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--exit TARGET_SL|TRAIL_EMA] [--no-rr-gate] [--sample IS|OOS|BOTH]`. Default `--sample IS`. Emits `SWING_BACKTEST_STARTED` / `SWING_BACKTEST_COMPLETED`. Add npm script `swing:backtest`. | `swing-backtest.js`, `package.json` |

**⛔ STOP — Checkpoint B.** Run the in-sample backtest only. Show the user the report. Do not
run `--sample OOS` or `BOTH` until the user says the logic is final.

### Block 6 — Tests & Completion
| # | Task | File |
|---|------|------|
| 42 | Candle pattern unit tests: for every detector, at least one positive and two near-miss negative fixtures. | `tests/test-phase7-candles.js` |
| 43 | Swings/levels/indicators/divergence/fib unit tests on hand-built fixtures with known answers. Heikin Ashi checked against a hand calculation. | `tests/test-phase7-analysis.js` |
| 44 | Setup unit tests: each setup TRIGGERED on its positive fixture (LONG and SHORT), NONE on negatives, correct stop/target/RR, `NA` rows for undefined terms. | `tests/test-phase7-setups.js` |
| 45 | Backtester tests on a synthetic series with known trades: entry at next open, stop/target/time exits, costs applied, R computed correctly, same-bar stop-and-target resolves to the stop. | `tests/test-phase7-backtester.js` |
| 46 | **Lookahead test:** for a fixture of 300+ bars, for every setup and several `i`, `evaluate` on the full array equals `evaluate` on the array truncated at `i`. Same check for `tideAt`. | `tests/test-phase7-lookahead.js` |
| 47 | Add `test:phase7` (runs 42–46). Ad-hoc, not in the suite: `tests/test-daily-candles-live.js` (network). | `package.json` |
| 48 | Deliverable doc: what was built, files changed, test counts, the in-sample and out-of-sample report, every assumption used, any threshold changes with reasons, known limitations. | `PHASE_7_COMPLETE.md` |

---

## Config Keys

```js
// ── Phase 7 — Swing Setup Engine ─────────────────────────────────────────
SWING_UNIVERSE: (process.env.SWING_UNIVERSE ||
  'RELIANCE,TCS,INFY,HDFCBANK,ICICIBANK,SBIN,WIPRO,AXISBANK,KOTAKBANK,LT,' +
  'BHARTIARTL,ITC,HINDUNILVR,BAJFINANCE,MARUTI,TATASTEEL,SUNPHARMA,NTPC'
).split(',').map(s => s.trim()),
SWING_HISTORY_YEARS: 5,

SWING_PIVOT_K: 5,                 // bars each side to confirm a pivot            [assumption]
SWING_LEVEL_LOOKBACK: 250,        // bars searched for S/R levels                 [assumption]
SWING_LEVEL_CLUSTER_PCT: 1.0,     // pivots within 1% form one level              [assumption]
SWING_AT_LEVEL_PCT: 1.0,          // "at support/resistance" tolerance            [assumption]

SWING_VOLUME_AVG_PERIOD: 10,      // "average of last few days"                   [assumption: 10]
SWING_HEAVY_VOLUME_MULT: 1.0,     // "more than average"                          (course)
SWING_CROSSOVER_LOOKBACK: 3,      // "in last 3 periods/candles"                  (course)
SWING_MIN_RR: 3,                  // reward/risk must be above 3                  (course)

SWING_TIDE_INDICATOR: 'MACD_HIST',// 'MACD_HIST' | 'MACD_LINE'                    [open question 1]
SWING_WAVE_OSCILLATOR: 'STOCH',   // 'STOCH' | 'RSI'
SWING_STOCH: { period: 14, signalPeriod: 3 },                                  // [assumption]
SWING_STOCH_OVERSOLD: 30,         // PCO must start from at/below this            [assumption]
SWING_STOCH_OVERBOUGHT: 70,       // NCO must start from at/above this            [assumption]
SWING_SMM_SL_MODE: 'OSC_PCO_CANDLE', // 'OSC_PCO_CANDLE' | 'SIG_CANDLE_MEDIAN'    (course gives both)

SWING_SMALL_BODY_PCT: 30,         // neutral candle: body <= 30% of range         [assumption]
SWING_STRONG_BODY_PCT: 60,        // plain bullish/bearish candle: body >= 60%    [assumption]
SWING_WICK_BODY_MULT: 2,          // hammer wick >= 2 x body                      (course: 2-3x)
SWING_MOTHER_ATR_MULT: 1.5,       // mother candle range >= 1.5 x ATR14           [assumption]
SWING_MOTHER_MIN_INSIDE: 3,       // "next few candles" inside the mother         [assumption]
SWING_SETUP_VALID_BARS: 10,       // how long a pending setup waits for trigger   [assumption]

SWING_BT_COST_PCT: 0.30,          // round-trip cost + slippage, % of entry       [open question 3]
SWING_BT_MAX_HOLD_DAYS: 40,       // time stop                                    [assumption]
SWING_BT_EXIT_MODE: 'TARGET_SL',  // 'TARGET_SL' | 'TRAIL_EMA'
SWING_BT_STOP_MODE: 'CLOSE_BASED',// 'CLOSE_BASED' | 'INTRADAY_TOUCH'
SWING_BT_OOS_FRACTION: 0.30,      // most recent 30% of dates held out
SWING_BT_MIN_TRADES: 30,          // below this → LOW_SAMPLE
```

---

## Database Schema (additions)

```sql
CREATE TABLE IF NOT EXISTS daily_candles (
  symbol  TEXT NOT NULL,
  date    TEXT NOT NULL,            -- YYYY-MM-DD (IST trading date)
  open    REAL NOT NULL,
  high    REAL NOT NULL,
  low     REAL NOT NULL,
  close   REAL NOT NULL,
  volume  REAL NOT NULL DEFAULT 0,
  source  TEXT NOT NULL,            -- 'yahoo' | 'dhan'
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS setup_stats (
  setup_id        TEXT NOT NULL,
  direction       TEXT NOT NULL,    -- 'LONG' | 'SHORT'
  sample          TEXT NOT NULL,    -- 'IS' | 'OOS'
  run_at          TEXT NOT NULL,    -- ISO timestamp
  period_from     TEXT NOT NULL,
  period_to       TEXT NOT NULL,
  exit_mode       TEXT NOT NULL,
  trades          INTEGER NOT NULL,
  win_rate        REAL,
  avg_r           REAL,
  expectancy_r    REAL,
  profit_factor   REAL,
  max_drawdown_r  REAL,
  max_consec_loss INTEGER,
  avg_hold_days   REAL,
  baseline_r      REAL,
  low_sample      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (setup_id, direction, sample, exit_mode)
);
```

---

## Setup Result Shape

```js
{
  setupId:   'counter-attack',
  setupName: 'Bulls Counter Attack',
  sourceRef: 'PAPA #5',
  direction: 'LONG',                 // 'LONG' | 'SHORT'
  subtype:   null,                   // e.g. candle pattern name for smm-checklist
  state:     'TRIGGERED',            // 'NONE' | 'WATCH' | 'TRIGGERED'
  asOf:      '2026-03-12',           // date of bar i
  stopLoss:  412.5,                  // price, or null
  target:    455.0,                  // price, or null
  riskReward: 3.4,                   // computed with bar i close as provisional entry
  rows: [                            // every checklist row, in order
    { id: 'tide',   label: 'Tide (weekly)', status: 'PASS', detail: 'MACD hist uptick' },
    { id: 'ungli',  label: 'Ungli setup',   status: 'NA',   detail: 'undefined in source material' },
  ],                                 // status: 'PASS' | 'FAIL' | 'NA' | 'JUDGMENT'
  blockedBy: null,                   // 'RR_GATE' | 'NO_TARGET' | null
}
```

- `WATCH` = the observation is present but the trigger has not fired, or it fired and was
  blocked (`blockedBy` says why).
- `JUDGMENT` = a row that needs a human or Claude (chart patterns). Never counted as PASS.

---

## Candlestick Definitions (from SMM Part 1 / PAPA Part 1)

`c1`, `c2`, `c3` are consecutive candles ending at bar `i`.

| Pattern | Definition |
|---|---|
| Hammer | Small body, lower wick ≥ `SWING_WICK_BODY_MULT` × body, upper wick ≤ body **[assumption]**. Counts as a signal only at the bottom of a decline (see "at bottom" below). |
| Inverted Hammer / Shooting Star | Mirror: upper wick ≥ mult × body, lower wick ≤ body. Signal only at the top of an advance. |
| Bullish Piercing | `c1` bearish, `c2` bullish, `c2.open <= c1.close`, `c2.close > median(c1)` and `c2.close <= c1.open`. |
| Bullish Engulf | `c1` bearish, `c2` bullish, `c2.open <= c1.close`, `c2.close > c1.open`. |
| Morning Star | `c1` bearish; `c2` neutral (small body), opens below `c1.close`, `c2.low < c1.low`; `c3` bullish, opens above `c2.close`, closes above `median(c1)`. |
| Bearish Piercing / Engulf / Evening Star | Exact mirrors of the three above. |
| Hanging Man | Hammer shape at the top of an advance, **followed by a bearish candle** (so it is confirmed on the next bar). |
| Three White Soldiers | Three consecutive bullish candles, each closing above the previous close, each body ≥ 50% of its range **[assumption]**. |
| Three Black Crows | Mirror. |
| Plain Bullish / Bearish Candle | Body ≥ `SWING_STRONG_BODY_PCT` % of range. |
| Doji | Body ≤ 10% of range **[assumption]**. |
| Spinning Top | Body ≤ `SWING_SMALL_BODY_PCT` % of range, wicks on both sides. |
| High Wave | Small body with both wicks ≥ 2 × body. |
| Tweezers | Two consecutive candles with highs (top) or lows (bottom) within 0.2% **[assumption]**. |

**"At bottom" / "at top" [assumption]:** at bottom = the pattern's low is the lowest low of the
last 10 bars and `trendAt` was not `UP` five bars earlier. At top mirrors. The course says
reversal patterns matter only at the end of a trend and are ignored mid-range.

---

## Setup Specifications

`entry` in the backtest is always the next bar's open (see Trade Simulation Rules). "Major
support/resistance" always means a major level from `levelsAt`. Default target for every setup
is `targetFor()`; when it returns `null`, state is `WATCH` with `blockedBy: 'NO_TARGET'` (the
course says to avoid the stock when no target is evident).

### 1. `smm-checklist` — SMM Decision Check List
- **Tide (weekly):** `SWING_TIDE_INDICATOR` uptick, or flat after down → Buy. Downtick, or flat
  after up → Sell. "Flat" = change smaller than 5% of the indicator's 10-bar average absolute
  change **[assumption]**.
- **Wave (daily):** Stochastic %K crossed above %D within `SWING_CROSSOVER_LOOKBACK` bars, with
  %K at or below `SWING_STOCH_OVERSOLD` at some point in the 3 bars before the cross → Buy.
  Mirror → Sell. With `SWING_WAVE_OSCILLATOR = 'RSI'`: RSI crossing up through 40 / down
  through 60 **[assumption]**.
- **Hat:** BULL when both say Buy; BEAR when both say Sell; else NONE → state `NONE`.
- **Row 1 Candlestick:** any bullish pattern on bar `i` for a Bull hat (hammer only "at
  bottom"); mirror for Bear. `subtype` = strongest pattern found, in the order
  star > engulf > piercing > hammer > plain candle.
- **Row 2 Volume:** volume ratio of the pattern's most significant candle ≥
  `SWING_HEAVY_VOLUME_MULT`, and that candle is green for Buy / red for Sell.
- **Row 3 EMA:** EMA 5 crossed above EMA 13 **or** EMA 26 within `SWING_CROSSOVER_LOOKBACK`
  bars → PASS for a Bull hat; crossed below → PASS for a Bear hat. `NA` (ignored) when Row 1
  is a Morning/Evening Star.
- **Row 4 Chart pattern:** `JUDGMENT` in this phase.
- **Row 5 Fib:** informational, from `retracementAt`.
- **Row 6 Divergence:** in trade direction → PASS ("Go for it"); against → FAIL ("Watchful");
  none → NA.
- **Stop loss (rows 7/8/11):** `OSC_PCO_CANDLE` → low of the candle where the Wave oscillator
  crossed (high for shorts). `SIG_CANDLE_MEDIAN` → median of the heavy-volume candle.
- **Target (row 12)** and **RR (row 13):** `riskReward > SWING_MIN_RR`.
- **TRIGGERED when [assumption]:** hat set, Row 1 PASS, Row 2 PASS, Row 3 PASS or NA, Row 6 not
  FAIL, target exists, RR passes. The course rule behind this is "zero contradictory signal".

### 2. `soldiers-crows` — PAPA #3 / #4
- **Observation (LONG):** Three White Soldiers completed within the last
  `SWING_SETUP_VALID_BARS` bars, and price has since dipped into the high–low range of the
  2nd soldier.
- **Trigger:** any bullish candle pattern on bar `i` while the low of bar `i` is inside or
  below that range and the close is above the low of the 1st soldier.
- **Stop loss:** low of the 1st soldier. **SHORT:** mirror with Three Black Crows, rally into
  the 2nd crow's range, bearish pattern, stop = high of the 1st crow.

### 3. `counter-attack` — PAPA #5 / #6
- **Observation (LONG):** a bar opens below a major support level (the breakdown level).
- **Trigger:** that bar, or one within the next 3 bars **[assumption]**, closes back above the
  breakdown level. That candle is the counter-attack candle.
- **Supportive rows:** volume ratio ≥ mult → PASS/FAIL; "Lower BBC failed" → `NA` (undefined).
- **Stop loss:** low of the counter-attack candle. **SHORT:** opens above major resistance,
  closes back below it; stop = high of the counter-attack candle.

### 4. `sandwich` — PAPA #7
- **Observation:** 4 or more consecutive candles alternating red/green whose combined high–low
  range is ≤ 2 × ATR14 **[assumption for "ranging"]**.
- **Trigger (LONG):** the next candle closes above the previous candle's high. **(SHORT):**
  closes below the previous candle's low.
- **Stop loss:** low of the breakout candle (LONG) / high of the breakdown candle (SHORT).

### 5. `mother-candle` — PAPA #16 / #17 / #18
- **Mother candle:** range ≥ `SWING_MOTHER_ATR_MULT` × ATR14, followed by at least
  `SWING_MOTHER_MIN_INSIDE` candles whose highs and lows stay inside the mother's high–low.
- **Bullish reversal (#16):** mother's low within `SWING_AT_LEVEL_PCT` of a major support.
  Trigger: a candle closes above the mother's high. Stop: mother's low.
- **Bearish reversal (#17):** mother's high at a major resistance. Trigger: close below the
  mother's low. Stop: mother's high.
- **Continuation (#18):** mother not at a major level and `trendAt` is UP (LONG) or DOWN
  (SHORT). Trigger: close beyond the mother in the trend direction. Stop: opposite end.
- **Supportive rows:** "BKP at major support" / "BKT at major resistance" → `NA`.
- `subtype`: `'REVERSAL'` or `'CONTINUATION'`.

### 6. `fake-breakout` — PAPA #12 / #13
- **Observation (SHORT, Fake BO):** a candle closes above a major resistance (the breakout
  candle).
- **Trigger:** within `SWING_SETUP_VALID_BARS` bars, a bearish follow-up candle closes below
  the breakout candle's low and below the breakout level.
- **Supportive rows:** bearish divergence → PASS/NA; volume ratio ≥ mult → PASS/FAIL; "BKT" → `NA`.
- **Stop loss:** high of the breakout candle. **LONG (Fake BD):** mirror — close below major
  support, then a bullish candle closes above the breakdown candle's high and the level;
  stop = low of the breakdown candle.

---

## Trade Simulation Rules

| Rule | Detail |
|---|---|
| Entry | Signal on the close of bar `i` → enter at the **open of bar `i+1`**. Recompute RR with the real entry; if it is now ≤ `SWING_MIN_RR` (and the RR gate is on), skip the trade and count it as blocked. Skip if the open is already beyond the stop. |
| Risk unit | `1R = |entry − stopLoss|`. All results are in R. No capital or position-size model in this phase. |
| Stop, `CLOSE_BASED` (default) | If bar closes beyond the stop → exit at the next bar's open. Matches the project's candle-close exit rule. Losses can exceed 1R; the report shows this. |
| Stop, `INTRADAY_TOUCH` | Exit at the stop price when the bar's low (LONG) / high (SHORT) touches it; if the bar opens beyond the stop, exit at the open. |
| Target, `TARGET_SL` | Exit at the target price when touched; if the bar opens beyond it, exit at the open. |
| Same bar hits stop and target | Count it as the stop (conservative). |
| Exit, `TRAIL_EMA` | Ignore the target. Exit at the next open after EMA 5 crosses below EMA 13 (LONG) / above (SHORT), or on the stop. (Course: "do not exit just because your target is reached".) |
| Time stop | After `SWING_BT_MAX_HOLD_DAYS` bars → exit at that bar's close. |
| Costs | Subtract `SWING_BT_COST_PCT` % of entry price from every trade, converted to R. |
| Short trades | Simulated on the same daily cash series as a proxy for futures. No financing or roll costs. State this in the report. |
| In/out of sample | Split by date: the most recent `SWING_BT_OOS_FRACTION` of the period is out-of-sample. A trade belongs to the sample of its signal date. |

---

## Backtest Report Output

```
════════════════════════════════════════════════════════════════════════════
  Drishti Swing Backtest — IN-SAMPLE
  Period: 2021-11-15 → 2025-05-12   Symbols: 18   Exit: TARGET_SL / CLOSE_BASED
  Costs: 0.30% round trip   RR gate: > 3
════════════════════════════════════════════════════════════════════════════
  Setup              Dir    Trades  Win%   Avg R   Expect  PF    MaxDD   Blocked  Baseline
  smm-checklist      LONG     41    34%   +0.42   +0.42   1.5   -6.0R     212     +0.08
  smm-checklist      SHORT    28    29%   -0.11   -0.11   0.9   -9.2R     187     -0.05   LOW_SAMPLE
  counter-attack     LONG     17    ...                                                   LOW_SAMPLE
  ...
────────────────────────────────────────────────────────────────────────────
  smm-checklist LONG by subtype:  engulf 14 (+0.61R) · hammer 9 (+0.20R) · ...
  Short trades use cash prices as a futures proxy.
  Universe is today's large caps (survivorship bias) — results are optimistic.
════════════════════════════════════════════════════════════════════════════
```

(The numbers above are layout placeholders, not expected results.)

---

## Gates (all must pass before PHASE_7_COMPLETE.md)

| Gate | What it tests |
|------|--------------|
| Gate 1 | `npm run test:phase6` still passes; three timeframes get different candles; VWAP non-null from candles |
| Gate 2 | `npm run swing:sync` stores ≥ 1,000 daily rows per symbol; a second run fetches only new days; `drishti.db*` is untracked by git |
| Gate 3 | Every candlestick detector passes its positive and near-miss fixtures; Heikin Ashi matches the hand calculation |
| Gate 4 | Lookahead test passes for all six setups and `tideAt` |
| Gate 5 | Each setup produces the specified stop, target and RR on its fixtures; undefined-term rows are `NA` |
| Gate 6 | Backtester reproduces the known trades of the synthetic series exactly (entry, exit, R after costs) |
| Gate 7 | `node swing-backtest.js --sample IS` prints the report, writes the NDJSON trade log and `setup_stats` rows |
| Gate 8 | Checkpoints A and B were confirmed by the user; the out-of-sample run happened once, after Checkpoint B |

---

## Open Questions For The User (ask before Block 4 if unanswered)

1. **Tide indicator.** SMM says "slope of MACD"; the GUE session says "MACD Histogram of the
   Tide". Default here is the histogram. Which did the course use?
2. **Undefined terms.** Ungli setup, BKT, BKP, BBC, BBNC. If the user supplies definitions, the
   affected rows can be switched on in Phase 8.
3. **Cost.** Is 0.30% round trip a fair figure for the user's broker and typical trade size?
4. **Universe.** 18 large caps by default. A wider F&O list gives more trades but takes longer
   to sync.

---

## Known Limitations (carry into PHASE_7_COMPLETE.md)

- **Survivorship bias:** the universe is today's large caps; stocks that fell out are missing.
- **Multiple setups tested at once:** some will look good by chance. Treat a positive result as
  a candidate, and require it to hold out-of-sample and later in paper trading.
- **Mechanical proxies:** "major level", "at bottom", "ranging" are coded approximations of
  what the course teaches by eye.
- **Rows marked `NA` or `JUDGMENT`** mean the backtest scores a reduced version of each
  course checklist.
- **Daily bars only:** intraday order of stop vs target inside one bar is unknown.
- **Data quality:** free daily data can contain unadjusted corporate actions; the sanity check
  warns but does not fix.

---

## Deferred (not in this phase)

| Item | Phase |
|---|---|
| Evening watchlist scan, Telegram digest, `/smm SYMBOL` | 8 |
| Risk module (2% per trade, monthly loss cap, stop after 4 losses, max open positions) | 8 |
| Playbook journal, paper trading of alerts, weekly review | 8 |
| Claude confirmation of `JUDGMENT` rows (wave count, chart patterns) | 8 |
| GUE setups (3rd Wave, Ending Diagonal, Triangle) — core rows depend on undefined terms and on wave/triangle recognition | 8, after open question 2 |
| PAPA Double Top/Bottom, Rounding Top/Bottom, Genuine BO/BD, Gap Up/Down | 8, after open question 2 |
| Options structure mapper (FOME) and open-interest interpretation | 8 or 9 |
| Options backtesting + analytics (old Phase 7) | 9 |