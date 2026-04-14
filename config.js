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

  // ── Brokerage & Costs (Dhan flat fee model) ───────────────────────────────
  BROKERAGE_PER_ORDER: 20,        // ₹20 per executed order leg
  STT_RATE: 0.000625,             // 0.0625% on sell side for options
  EXCHANGE_CHARGE_RATE: 0.00053,  // NSE: 0.053% on premium turnover
  GST_RATE: 0.18,                 // 18% on brokerage + exchange charges
  STAMP_DUTY_RATE: 0.00003,       // 0.003% on buy side

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
