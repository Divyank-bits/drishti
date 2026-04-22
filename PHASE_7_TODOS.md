# Phase 7 — Backtesting & Analytics Database: Task List

## What This Phase Builds

A backtesting engine that replays historical candle + options data against your strategy
rules, simulates fills via PaperExecutor, and produces a performance report. Also migrates
trade journal and options snapshots to SQLite for fast querying and analytics.

**Prerequisite:** At least 2–4 weeks of options chain snapshots collected by `snapshot-store.js`
(started in Pre-Phase 5). NSE Bhavcopy downloader provides historical backfill.

---

## Build Order (implement in this sequence)

### Block 1 — SQLite Database Layer
| # | Task | File |
|---|------|------|
| 1 | Install `better-sqlite3` — synchronous SQLite driver, best for Node.js CJS projects | `package.json` |
| 2 | Create `data/db.js` — opens/creates `drishti.db`, runs migrations on boot. Tables: `trades` (one row per closed trade), `snapshots` (one row per options chain snapshot), `scan_results` (one row per equity scan) | `data/db.js` |
| 3 | Migrate trade journal writer — `trade-journal.js` continues writing NDJSON (audit log, never removed) but also inserts into `trades` table on `POSITION_CLOSED` | `journal/trade-journal.js` |
| 4 | Migrate snapshot store — `snapshot-store.js` continues writing NDJSON files but also inserts into `snapshots` table | `data/snapshot-store.js` |
| 5 | Add `data/backfill.js` — reads existing NDJSON journal files and snapshot files, inserts any missing rows into SQLite. Run once on Phase 7 boot to migrate historical data | `data/backfill.js` |

### Block 2 — NSE Bhavcopy Downloader
| # | Task | File |
|---|------|------|
| 6 | Create `data/bhavcopy.js` — downloads NSE F&O Bhavcopy CSV for a given date from NSE's public URL. Parses rows for NIFTY options (symbol, strike, expiry, OI, volume, settle price). Inserts into `snapshots` table as EOD entries | `data/bhavcopy.js` |
| 7 | Add `backfill:bhavcopy` npm script — accepts `--from` and `--to` date args, downloads and inserts Bhavcopy for each trading day in range | `package.json` |

### Block 3 — Candle Replay Engine
| # | Task | File |
|---|------|------|
| 8 | Create `backtest/candle-replayer.js` — fetches historical 15m candles from Dhan (`/v2/charts/historical`) for a date range. Emits synthetic `CANDLE_CLOSE_15M` and `INDICATORS_UPDATED` events in chronological order with configurable replay speed | `backtest/candle-replayer.js` |
| 9 | Create `backtest/options-replayer.js` — for each candle timestamp, looks up the nearest `snapshots` row in SQLite and emits a synthetic `OPTIONS_CHAIN_UPDATED` event. Falls back to Bhavcopy EOD data if intraday snapshot unavailable | `backtest/options-replayer.js` |

### Block 4 — Backtest Runner
| # | Task | File |
|---|------|------|
| 10 | Create `backtest/runner.js` — orchestrates a full backtest. Loads strategy by name, initialises `PaperExecutor` with a clean state, replays candles + options chain via replayers, collects every `SIGNAL_GENERATED`, `ORDER_FILLED`, `ORDER_EXITED` event | `backtest/runner.js` |
| 11 | Wire circuit breakers into runner — reset all breakers at start of each backtest day so daily loss limits apply per-day as in live trading | `backtest/runner.js` |
| 12 | Add `backtest.js` CLI entry point — accepts args: `--strategy iron-condor`, `--from 2026-01-01`, `--to 2026-04-01`, `--mode RULES\|HYBRID`. Runs `runner.js` and prints report | `backtest.js` |

### Block 5 — Performance Report
| # | Task | File |
|---|------|------|
| 13 | Create `backtest/report.js` — computes from collected trades: total trades, win rate, average P&L per trade, max drawdown, max consecutive losses, Sharpe ratio (annualised), best/worst day | `backtest/report.js` |
| 14 | Print report to console in a readable table format. Also write full per-trade log to `backtest-results/YYYY-MM-DD-strategy.ndjson` | `backtest/report.js` |

### Block 6 — Analytics Queries
| # | Task | File |
|---|------|------|
| 15 | Create `analytics/queries.js` — pre-built SQLite queries: `getTradesByStrategy()`, `getPnlByMonth()`, `getWinRateByVixRange()`, `getBestEntryHour()`, `getSnapshotsByDateRange()` | `analytics/queries.js` |
| 16 | Add `analytics.js` CLI — runs named queries and prints results. e.g. `node analytics.js --query pnl-by-month` | `analytics.js` |

### Block 7 — Tests & Completion
| # | Task | File |
|---|------|------|
| 17 | Unit tests for candle-replayer — correct chronological order, synthetic events have right shape | `test-phase7-replayer.js` |
| 18 | Unit tests for report — known fixture trades produce correct win rate, drawdown, Sharpe | `test-phase7-report.js` |
| 19 | Integration test — full backtest run over 5 fixture days produces non-zero trade log and valid report | `test-phase7-integration.js` |
| 20 | Add `test:phase7` and `backtest` npm scripts | `package.json` |
| 21 | Phase deliverable doc | `PHASE_7_COMPLETE.md` |

---

## Database Schema

```sql
-- One row per closed trade
CREATE TABLE trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_date    TEXT NOT NULL,          -- YYYY-MM-DD
  strategy      TEXT NOT NULL,
  entry_time    TEXT NOT NULL,          -- ISO timestamp
  exit_time     TEXT,
  strikes       TEXT NOT NULL,          -- JSON blob
  premium_collected REAL,
  exit_premium  REAL,
  realised_pnl  REAL,
  intelligence_mode TEXT,
  confidence    REAL,
  exit_reason   TEXT,
  source        TEXT DEFAULT 'live'     -- 'live' | 'backtest'
);

-- One row per options chain snapshot
CREATE TABLE snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL DEFAULT 'NIFTY',
  timestamp     TEXT NOT NULL,          -- ISO timestamp
  trade_date    TEXT NOT NULL,          -- YYYY-MM-DD
  vix           REAL,
  pcr           REAL,
  atm_strike    REAL,
  underlying    REAL,
  strike_data   TEXT,                   -- JSON blob
  source        TEXT DEFAULT 'intraday' -- 'intraday' | 'bhavcopy'
);

-- One row per equity scan result (Phase 6+)
CREATE TABLE scan_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol        TEXT NOT NULL,
  timestamp     TEXT NOT NULL,
  pattern_name  TEXT,
  direction     TEXT,
  state         TEXT,                   -- 'FORMING' | 'CONFIRMED'
  confluence    REAL,
  claude_used   INTEGER DEFAULT 0,
  reasoning     TEXT
);
```

---

## Backtest Report Output

```
══════════════════════════════════════════════════
  Drishti Backtest — Iron Condor (RULES mode)
  Period: 2026-01-01 → 2026-04-01 (60 trading days)
══════════════════════════════════════════════════
  Total signals generated : 38
  Trades taken            : 22   (58% pass rate)
  Winning trades          : 15   (68% win rate)
  Losing trades           : 7

  Avg P&L per trade       : ₹842
  Avg winner              : ₹1,240
  Avg loser               : ₹-890
  Max single win          : ₹2,100
  Max single loss         : ₹-2,800

  Total P&L               : ₹18,524
  Max drawdown            : ₹-4,200
  Max consecutive losses  : 3
  Sharpe ratio            : 1.42

  Best day                : 2026-02-14  ₹2,100
  Worst day               : 2026-03-08  ₹-2,800
══════════════════════════════════════════════════
```

---

## Data Availability by Source

| Data | Source | Granularity | Available From |
|------|--------|-------------|---------------|
| NIFTY candles | Dhan `/v2/charts/historical` | 15m | ~1 year back |
| Options OI + PCR (EOD) | NSE Bhavcopy | Daily | Years back (free) |
| Options chain intraday | `snapshot-store.js` | Every 15min | From Pre-Phase 5 start |
| IV Rank intraday | `snapshot-store.js` | Every 15min | From Pre-Phase 5 start |

---

## Known Limitations

- **Intraday options data before Pre-Phase 5** — only EOD Bhavcopy available. Backtest results for older periods will use EOD OI/PCR as a proxy for intraday conditions — less accurate but better than nothing.
- **Slippage model** — PaperExecutor uses fixed per-lot slippage. Real backtest slippage varies by time of day and liquidity. Results will be optimistic vs live.
- **No HYBRID/AI backtest** — Claude API costs make replaying months of signals expensive. Backtest runs in RULES mode only; HYBRID results are approximated by using the rule score as a proxy for Claude confidence.

---

## Gates (all must pass before PHASE_7_COMPLETE.md)

| Gate | What it tests |
|------|--------------|
| Gate 1 | SQLite `trades` table populated correctly from existing NDJSON journal |
| Gate 2 | Bhavcopy downloader fetches and parses NSE F&O CSV for a given date |
| Gate 3 | Candle replayer emits events in correct chronological order |
| Gate 4 | Full backtest over 5 fixture days produces valid trade log |
| Gate 5 | Report Sharpe ratio matches manual calculation on fixture data |
| Gate 6 | `node analytics.js --query pnl-by-month` prints correct grouped output |
| Gate 7 | `source='backtest'` trades are excluded from live P&L calculations |
