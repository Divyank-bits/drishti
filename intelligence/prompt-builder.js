/**
 * @file prompt-builder.js
 * @description Assembles Claude prompts from live market data and session context.
 *              Two prompt types:
 *                1. Entry analysis — should we take this Iron Condor signal?
 *                2. Hunt detection — is the current price move a stop-hunt?
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
    `Trades today: ${ctx.tradesToday}  P&L today: ₹${ctx.pnlToday}`,
    `Consecutive losses: ${ctx.consecutiveLosses}`,
  ].join('\n');
}

// ── Public builders ───────────────────────────────────────────────────────────

/**
 * Builds an entry analysis prompt asking Claude whether to approve an IC signal.
 *
 * @param {object} signal — SIGNAL_GENERATED payload from iron-condor.strategy.js
 * @param {object} sessionCtx — SessionContext.snapshot()
 * @param {Array}  candles15m — last N 15-minute candles from candle-builder
 * @returns {string} prompt string for claude-client.call()
 */
function buildEntryPrompt(signal, sessionCtx, candles15m) {
  const { strikes, indicatorSnapshot: ind, optionsSnapshot: opts } = signal;

  const indicatorLines = ind ? [
    `EMA9: ${ind.ema9?.toFixed(2) ?? 'N/A'}  EMA21: ${ind.ema21?.toFixed(2) ?? 'N/A'}`,
    `RSI(14): ${ind.rsi?.toFixed(1) ?? 'N/A'}`,
    `MACD line: ${ind.macd?.macd?.toFixed(2) ?? 'N/A'}  Signal: ${ind.macd?.signal?.toFixed(2) ?? 'N/A'}`,
    `BB Width: ${ind.bb?.width?.toFixed(2) ?? 'N/A'}%  Upper: ${ind.bb?.upper?.toFixed(0) ?? 'N/A'}  Lower: ${ind.bb?.lower?.toFixed(0) ?? 'N/A'}`,
  ].join('\n') : '  (no indicators)';

  return `You are analyzing a proposed NIFTY 50 Iron Condor trade on NSE.

## Session Context
${_formatContext(sessionCtx)}

## Proposed Iron Condor Strikes
Short CE: ${strikes.shortCe}  Long CE: ${strikes.longCe}
Short PE: ${strikes.shortPe}  Long PE: ${strikes.longPe}

## Technical Indicators (15m)
${indicatorLines}

## Options Chain
VIX: ${opts?.vix ?? 'N/A'}  PCR: ${opts?.pcr ?? 'N/A'}  ATM Strike: ${opts?.atmStrike ?? 'N/A'}

## Recent 15m Candles (most recent last)
${_formatCandles(candles15m, 10)}

## Task
Assess whether this Iron Condor entry is favourable RIGHT NOW.
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
 * @param {object} position — { strikes, currentPnl, ceDelta, peDelta, entryPremium }
 * @param {object} candle   — the just-closed 15m candle { open, high, low, close, volume, openTime }
 * @param {object} sessionCtx — SessionContext.snapshot()
 * @returns {string} prompt string for claude-client.call()
 */
function buildHuntPrompt(position, candle, sessionCtx) {
  const { strikes, currentPnl, ceDelta, peDelta, entryPremium } = position;
  const candleTime = new Date(candle.openTime).toISOString().slice(11, 16);

  return `You are assessing whether a price move against an active NIFTY Iron Condor is a stop-hunt.

## Active Position
Short CE: ${strikes.shortCe}  Short PE: ${strikes.shortPe}
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
