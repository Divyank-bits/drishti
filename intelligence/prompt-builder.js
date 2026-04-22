/**
 * @file prompt-builder.js
 * @description Assembles Claude prompts from live market data and session context.
 *              Two prompt types:
 *                1. Entry analysis — should we take this strategy's signal?
 *                2. Hunt detection — is the current price move a stop-hunt?
 *
 *              Phase 4: prompts include active strategy name and per-strategy P&L
 *              so Claude has full multi-strategy context when evaluating signals.
 *
 *              All prompts request a strict JSON response so claude-client.parseJSON()
 *              can extract structured fields without text parsing.
 */
'use strict';

/**
 * Formats a candle array into a compact readable table for the prompt.
 * @param {Array<{openTime, open, high, low, close, volume}>} candles
 * @param {number} limit — max candles to include (most recent last)
 * @returns {string}
 */
function _formatCandles(candles, limit = 10) {
  const slice = candles.slice(-limit);
  const rows  = slice.map(c => {
    const d = new Date(c.openTime).toISOString().slice(11, 16); // HH:MM
    return `  ${d}  O:${c.open}  H:${c.high}  L:${c.low}  C:${c.close}  V:${c.volume ?? 0}`;
  });
  return rows.join('\n') || '  (no candles)';
}

/**
 * Formats a session context snapshot for the prompt.
 * @param {object} ctx — SessionContext.snapshot()
 * @returns {string}
 */
function _formatContext(ctx) {
  return [
    `Date: ${ctx.date}`,
    `Day Open: ${ctx.dayOpen ?? 'N/A'}  High: ${ctx.dayHigh ?? 'N/A'}  Low: ${ctx.dayLow ?? 'N/A'}`,
    `VIX at open: ${ctx.vixAtOpen ?? 'N/A'}  VIX now: ${ctx.vixCurrent ?? 'N/A'}`,
    `Regime: ${ctx.currentRegime ?? 'unknown'}  Regime changes today: ${ctx.regimeChangesToday}`,
    `Trades today: ${ctx.tradesToday}  Aggregate P&L today: ₹${ctx.pnlToday}`,
    `Consecutive losses: ${ctx.consecutiveLosses}`,
  ].join('\n');
}

/**
 * Formats per-strategy P&L map into a compact table line.
 * @param {object|null} strategyPnl — { strategyName: realisedPnl, ... } or null
 * @returns {string}
 */
function _formatStrategyPnl(strategyPnl) {
  if (!strategyPnl || Object.keys(strategyPnl).length === 0) return '  (none this session)';
  return Object.entries(strategyPnl)
    .map(([name, pnl]) => `  ${name}: ₹${pnl}`)
    .join('\n');
}

/**
 * Formats a strikes object into readable lines regardless of strategy shape.
 * Iron Condor has 4 strikes; spreads have 2; straddle has 1 (atm).
 * @param {object} strikes
 * @returns {string}
 */
function _formatStrikes(strikes) {
  if (!strikes) return '  (no strikes)';
  return Object.entries(strikes)
    .map(([key, val]) => `  ${key}: ${val}`)
    .join('\n');
}

// ── Public builders ───────────────────────────────────────────────────────────

/**
 * Builds an entry analysis prompt asking Claude whether to approve a strategy signal.
 *
 * @param {object} signal — SIGNAL_GENERATED payload (includes signal.strategy name)
 * @param {object} sessionCtx — SessionContext.snapshot()
 * @param {Array}  candles15m — last N 15-minute candles from candle-builder
 * @param {object} [strategyPnl] — per-strategy realised P&L map { name: rupees }
 * @returns {string} prompt string for claude-client.call()
 */
function buildEntryPrompt(signal, sessionCtx, candles15m, strategyPnl = null) {
  const { strategy: strategyName, strikes, indicatorSnapshot: ind, optionsSnapshot: opts } = signal;

  const indicatorLines = ind ? [
    `EMA9: ${ind.ema9?.toFixed(2) ?? 'N/A'}  EMA21: ${ind.ema21?.toFixed(2) ?? 'N/A'}`,
    `RSI(14): ${ind.rsi?.toFixed(1) ?? 'N/A'}`,
    `MACD line: ${ind.macd?.macd?.toFixed(2) ?? 'N/A'}  Signal: ${ind.macd?.signal?.toFixed(2) ?? 'N/A'}`,
    `BB Width: ${ind.bb?.width?.toFixed(2) ?? 'N/A'}%  Upper: ${ind.bb?.upper?.toFixed(0) ?? 'N/A'}  Lower: ${ind.bb?.lower?.toFixed(0) ?? 'N/A'}`,
  ].join('\n') : '  (no indicators)';

  const strikesBlock = _formatStrikes(strikes);

  return `You are analyzing a proposed NIFTY 50 ${strategyName || 'options'} trade on NSE.

## Session Context
${_formatContext(sessionCtx)}

## Per-Strategy Realised P&L This Session
${_formatStrategyPnl(strategyPnl)}

## Strategy
${strategyName || 'Unknown'}

## Proposed Strikes
${strikesBlock}

## Technical Indicators (15m)
${indicatorLines}

## Options Chain
VIX: ${opts?.vix ?? 'N/A'}  PCR: ${opts?.pcr ?? 'N/A'}  ATM Strike: ${opts?.atmStrike ?? 'N/A'}

## Recent 15m Candles (most recent last)
${_formatCandles(candles15m, 10)}

## Task
Assess whether this ${strategyName || 'options'} entry is favourable RIGHT NOW.
Consider: current volatility regime, strike placement relative to market structure,
risk/reward given current VIX and PCR, and any red flags in price action.

Respond with ONLY valid JSON in this exact shape:
{
  "approved": true | false,
  "confidence": 0.0–1.0,
  "reasoning": "one concise sentence",
  "concerns": ["concern1", "concern2"]
}`;
}

/**
 * Builds a hunt-detection prompt asking Claude whether a price breach is a stop-hunt.
 *
 * @param {object} position — { strategy, strikes, currentPnl, ceDelta, peDelta, entryPremium }
 * @param {object} candle   — the just-closed 15m candle { open, high, low, close, volume, openTime }
 * @param {object} sessionCtx — SessionContext.snapshot()
 * @returns {string} prompt string for claude-client.call()
 */
function buildHuntPrompt(position, candle, sessionCtx) {
  const { strategy: strategyName, strikes, currentPnl, ceDelta, peDelta, entryPremium } = position;
  const candleTime = new Date(candle.openTime).toISOString().slice(11, 16);

  return `You are assessing whether a price move against an active NIFTY ${strategyName || 'options'} position is a stop-hunt.

## Active Position
Strategy: ${strategyName || 'Unknown'}
${_formatStrikes(strikes)}
Entry premium: ₹${entryPremium ?? 'N/A'}  Current P&L: ₹${currentPnl}
CE delta: ${ceDelta ?? 'N/A'}  PE delta: ${peDelta ?? 'N/A'}

## Triggering 15m Candle (closed at ${candleTime} IST)
Open: ${candle.open}  High: ${candle.high}  Low: ${candle.low}  Close: ${candle.close}
Volume: ${candle.volume ?? 0}

## Session Context
${_formatContext(sessionCtx)}

## Task
Determine whether this price move is:
  (A) a genuine directional breakout requiring exit, or
  (B) a stop-hunt / liquidity sweep that is likely to reverse.

Respond with ONLY valid JSON in this exact shape:
{
  "isLikelyHunt": true | false,
  "confidence": 0.0–1.0,
  "reasoning": "one concise sentence",
  "action": "HOLD" | "EXIT" | "FLAG"
}`;
}

module.exports = { buildEntryPrompt, buildHuntPrompt };
