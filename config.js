/**
 * @file config.js
 * @description Central configuration for Drishti. All constants and flags live here.
 *              Sensitive values (API keys, tokens) are loaded exclusively from .env.
 *              Never hardcode secrets in this file.
 */

require('dotenv').config();

const config = {
  // ── Intelligence & Execution Modes ────────────────────────────────────────
  INTELLIGENCE_MODE: process.env.INTELLIGENCE_MODE || 'HYBRID', // AI | RULES | HYBRID
  EXECUTION_MODE: process.env.EXECUTION_MODE || 'PAPER',        // PAPER | LIVE

  // ── Market Hours (IST, 24h format) ────────────────────────────────────────
  MARKET_OPEN: '09:15',
  MARKET_CLOSE: '15:30',
  NO_NEW_TRADES_AFTER: '14:00',
  SQUARE_OFF_TIME: '15:15',
  PRE_MARKET_CHECK_TIME: '09:00', // pre-market checklist cron

  // ── Strategy Thresholds ───────────────────────────────────────────────────
  CONFIDENCE_THRESHOLD: 0.70,   // Claude confidence minimum to act
  MATCH_SCORE_THRESHOLD: 65,    // rule engine score minimum (0-100)

  // ── Multi-Strategy (Phase 4) ──────────────────────────────────────────────
  ACTIVE_STRATEGIES: (process.env.ACTIVE_STRATEGIES || 'iron-condor').split(',').map(s => s.trim()),
  // STRATEGY_SELECTION_MODE: how to pick among passing strategies each cycle
  //   FIRST_MATCH  — execute first strategy whose rules pass (registry order = priority)
  //   BEST_SCORE   — score all passing strategies, execute highest scorer
  //   ALL_PASSING  — execute every passing strategy up to MAX_CONCURRENT_POSITIONS
  STRATEGY_SELECTION_MODE: process.env.STRATEGY_SELECTION_MODE || 'FIRST_MATCH',
  MAX_CONCURRENT_POSITIONS: 2,  // hard cap on simultaneous open positions across all strategies
  // Per-strategy capital allocation cap as fraction of total daily risk budget (0–1)
  // Keyed by strategy name matching the ACTIVE_STRATEGIES entries
  STRATEGY_CAPITAL_PCT: {
    'iron-condor':      1.0,    // 100% — sole strategy by default
    'bull-put-spread':  0.5,
    'bear-call-spread': 0.5,
    'straddle':         0.4,
  },

  // ── Trade & Risk Limits ───────────────────────────────────────────────────
  MAX_TRADES_PER_DAY: 3,
  MAX_DAILY_LOSS: 5000,           // rupees — daily loss circuit breaker
  CONSECUTIVE_LOSS_PAUSE: 3,      // pause new entries after N consecutive losses
  ABSOLUTE_PNL_STOP_PCT: 0.50,    // 50% of MAX_DAILY_LOSS → immediate exit

  // ── Position Sizing ───────────────────────────────────────────────────────
  NIFTY_LOT_SIZE: 25,             // NIFTY options lot size (updated Nov 2024)
  DEFAULT_LOTS: 1,                // lots per trade
  MAX_LOTS: 2,                    // hard cap regardless of capital

  // ── Expiry & DTE Filters ──────────────────────────────────────────────────
  TARGET_DTE_MIN: 7,              // do not enter if days-to-expiry < 7
  TARGET_DTE_MAX: 21,             // prefer DTE between 7-21
  NO_ENTRY_ON_EXPIRY_DAY: true,   // skip new entries on Thursday (weekly expiry)

  // ── AI Model ─────────────────────────────────────────────────────────────
  CLAUDE_MODEL: 'claude-sonnet-4-5',
  CLAUDE_TIMEOUT_MS: 10000,       // 10 second timeout on Claude API calls
  CLAUDE_SLOW_LOG_MS: 3000,       // log warning if response takes > 3s

  // ── VIX Thresholds ───────────────────────────────────────────────────────
  VIX_SAFE_MAX: 22,               // no new IC entries above this
  VIX_DANGER: 25,                 // flag existing positions as high-risk

  // ── Data & WebSocket Config ───────────────────────────────────────────────
  CANDLE_TIMEFRAMES: [1, 5, 15],  // minutes
  OPTIONS_CHAIN_INTERVAL: 15,     // minutes between option chain refreshes
  WEBSOCKET_RECONNECT_TIMEOUT: 30, // seconds before circuit breaker trips
  CANDLE_HISTORY_SIZE: 200,       // rolling candles kept in memory per timeframe
  STARTUP_CANDLE_COUNT: 50,       // candles fetched at boot; bump to 200 for deep scans
  DATA_SOURCE: process.env.DATA_SOURCE || 'NSE', // 'NSE' | 'DHAN' — independent of EXECUTION_MODE
                                                  // NSE = polling, no subscription; DHAN = WebSocket (Phase 3)

  // ── Dhan Feed & Instrument IDs ────────────────────────────────────────────
  DHAN_WS_URL:          'wss://api-feed.dhan.co',  // binary feed endpoint
  DHAN_REST_URL:        'https://api.dhan.co/v2',  // REST API base URL
  DHAN_SECURITY_ID:     '13',                      // NIFTY 50 index security ID
  DHAN_EXCHANGE_SEGMENT:'IDX_I',                   // index segment identifier

  // ── Brokerage & Costs (Dhan flat fee model) ───────────────────────────────
  BROKERAGE_PER_ORDER: 20,        // ₹20 per executed order leg
  STT_RATE: 0.000625,             // 0.0625% on sell side for options
  EXCHANGE_CHARGE_RATE: 0.00053,  // NSE: 0.053% on premium turnover
  GST_RATE: 0.18,                 // 18% on brokerage + exchange charges
  STAMP_DUTY_RATE: 0.00003,       // 0.003% on buy side

  // ── Phase 5 — Deep Scan / Watchlist ──────────────────────────────────────
  // Comma-separated list of NSE FO symbols to scan (besides primary NIFTY)
  WATCHLIST_SYMBOLS: (process.env.WATCHLIST_SYMBOLS || 'BANKNIFTY,FINNIFTY').split(',').map(s => s.trim()),
  SCAN_INTERVAL_MINUTES: parseInt(process.env.SCAN_INTERVAL_MINUTES, 10) || 15,
  SCAN_MAX_SYMBOLS: parseInt(process.env.SCAN_MAX_SYMBOLS, 10) || 10,
  DEEP_SCAN_CONFIDENCE_THRESHOLD: parseFloat(process.env.DEEP_SCAN_CONFIDENCE_THRESHOLD) || 70,

  // ── Phase 6 — Equity Directional Scan ────────────────────────────────────
  // Comma-separated NSE F&O equity symbols to support via /scan SYMBOL
  EQUITY_SCAN_SYMBOLS: (process.env.EQUITY_SCAN_SYMBOLS || 'RELIANCE,TCS,INFY').split(',').map(s => s.trim()),
  // Timeframes (minutes) fetched and scored for each equity scan
  EQUITY_SCAN_CANDLE_TIMEFRAMES: [1, 5, 15],
  // Confluence score threshold (0–100) → CONFIRMED pattern
  EQUITY_SCAN_CONFLUENCE_THRESHOLD: parseFloat(process.env.EQUITY_SCAN_CONFLUENCE_THRESHOLD) || 65,
  // Confluence score threshold (0–100) → FORMING pattern (watch alert)
  EQUITY_SCAN_FORMING_THRESHOLD: parseFloat(process.env.EQUITY_SCAN_FORMING_THRESHOLD) || 40,

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

  SWING_TIDE_INDICATOR: 'MACD_LINE', // 'MACD_HIST' | 'MACD_LINE'                    confirmed by user
  SWING_WAVE_OSCILLATOR: 'STOCH',   // 'STOCH' | 'RSI'
  SWING_STOCH: { period: 14, signalPeriod: 3 },                                   // [assumption]
  SWING_STOCH_OVERSOLD: 30,         // PCO must start from at/below this            [assumption]
  SWING_STOCH_OVERBOUGHT: 70,       // NCO must start from at/above this            [assumption]
  SWING_SMM_SL_MODE: 'OSC_PCO_CANDLE', // 'OSC_PCO_CANDLE' | 'SIG_CANDLE_MEDIAN'   (course gives both)

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

  // ── Phase 8 — Evening scanner & risk ─────────────────────────────────────
  SWING_SCAN_ENABLED: process.env.SWING_SCAN_ENABLED !== 'false',
  SWING_SCAN_TIME: process.env.SWING_SCAN_TIME || '15:45',  // HH:MM IST
  SWING_ACCOUNT_SIZE: parseInt(process.env.SWING_ACCOUNT_SIZE || '500000', 10),
  SWING_RISK_PCT_PER_TRADE: parseFloat(process.env.SWING_RISK_PCT_PER_TRADE || '1.0'),

  // ── Anti-Hunt Config Knobs (Pre-Phase 5) ──────────────────────────────────
  // When false, Rule 3 volume gate is skipped — required when DATA_SOURCE=NSE (volume is always 0)
  ANTI_HUNT_VOLUME_REQUIRED: process.env.ANTI_HUNT_VOLUME_REQUIRED !== 'false',
  // BLOCK_ALL: current behaviour — no exits during dangerous windows except Rule 6
  // SUPPRESS_FIRST: hold on first breach in window; exit if next 15m candle also closes beyond buffer
  ANTI_HUNT_DANGEROUS_WINDOW_MODE: process.env.ANTI_HUNT_DANGEROUS_WINDOW_MODE || 'BLOCK_ALL',

  // ── Paper Executor ────────────────────────────────────────────────────────
  SLIPPAGE_PER_LOT: 1.5,              // ₹ fixed slippage per lot — swap point for spread-based (Phase 3)

  // ── Strategy Filters ──────────────────────────────────────────────────────
  MACD_ZERO_THRESHOLD: 2.0,           // abs(macd.macd) must be < this for entry
  IV_PERCENTILE_PROXY_MIN: 50,        // BB width percentile proxy minimum

  // ── Telegram ──────────────────────────────────────────────────────────────
  TRADE_APPROVAL_TIMEOUT_MS: 180000,  // 3-minute trade approval window

  // ── Dashboard ─────────────────────────────────────────────────────────────
  DASHBOARD_PORT: parseInt(process.env.DASHBOARD_PORT, 10) || 3000,
  SSE_PUSH_INTERVAL_MS: 2000,     // dashboard SSE push frequency

  // ── Secrets (from .env only) ──────────────────────────────────────────────
  DHAN_CLIENT_ID: process.env.DHAN_CLIENT_ID || null,
  DHAN_ACCESS_TOKEN: process.env.DHAN_ACCESS_TOKEN || null,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,
  TELEGRAM_AUTHORIZED_USER_IDS: process.env.TELEGRAM_AUTHORIZED_USER_IDS
    ? process.env.TELEGRAM_AUTHORIZED_USER_IDS.split(',').map((id) => parseInt(id.trim(), 10))
    : [],

  // ── Environment ───────────────────────────────────────────────────────────
  NODE_ENV: process.env.NODE_ENV || 'production',
  IS_DEV: process.env.NODE_ENV === 'development',
};

// ── Derived constants (do not modify directly) ─────────────────────────────
config.ABSOLUTE_PNL_STOP_RUPEES = config.MAX_DAILY_LOSS * config.ABSOLUTE_PNL_STOP_PCT;
config.TOTAL_LEGS_PER_IC = 4; // Iron Condor always has 4 legs

module.exports = config;
