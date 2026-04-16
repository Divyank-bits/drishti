/**
 * @file anti-hunt.js
 * @description Evaluates anti-hunt rules against current position state and
 *              last 15m candle. Called by position-tracker.js on each CANDLE_CLOSE_15M.
 *
 *              Rule evaluation order (strict):
 *                6 → 4 → 1+2 → 3 → 5
 *              Rule 8 (Claude hunt detection) — async, AI/HYBRID only.
 *              Skipped silently in RULES mode or when Claude is unavailable.
 */
'use strict';

const config         = require('../config');
const claudeClient   = require('../intelligence/claude-client');
const promptBuilder  = require('../intelligence/prompt-builder');

function toIST(tsMs) {
  const istMs  = tsMs + 5.5 * 3600 * 1000;
  const hour   = Math.floor((istMs % (24 * 3600000)) / 3600000);
  const minute = Math.floor((istMs % 3600000) / 60000);
  return { hour, minute };
}

function _isDangerousWindow(tsMs) {
  const { hour, minute } = toIST(tsMs);
  return (
    (hour === 9  && minute >= 15 && minute < 30) ||  // 09:15–09:30
    (hour === 11 && minute >= 30 && minute < 45) ||  // 11:30–11:45
    (hour === 13 && minute >= 0  && minute < 30) ||  // 13:00–13:30
    (hour === 14 && minute >= 45)                    // 14:45–15:00
  );
}

/**
 * Evaluate anti-hunt rules for the current position and candle.
 *
 * @param {{ orderId, strikes, entryPremium, currentPnl, ceDelta, peDelta, avgVolume }} position
 * @param {{ close, high, low, volume, openTime }} candle  — the just-closed 15m candle
 * @param {{ dayOpen }} sessionContext
 * @returns {{ shouldExit: boolean, flagged: boolean, rule: number|null, reason: string }}
 */
function evaluate(position, candle, sessionContext) {
  const { strikes, currentPnl, ceDelta, peDelta, avgVolume } = position;

  // ── Rule 6: Absolute P&L stop (checked first, bypasses everything) ───────
  const absoluteStop = config.MAX_DAILY_LOSS * config.ABSOLUTE_PNL_STOP_PCT;
  if (currentPnl <= -absoluteStop) {
    return { shouldExit: true, flagged: false, rule: 6,
      reason: `Absolute P&L stop: loss ₹${Math.abs(currentPnl)} exceeds ₹${absoluteStop}` };
  }

  // ── Rule 4: Dangerous window — only Rule 6 can exit here ─────────────────
  if (_isDangerousWindow(candle.openTime)) {
    return { shouldExit: false, flagged: false, rule: null,
      reason: 'Dangerous window — no exits except absolute P&L stop' };
  }

  // ── Rules 1+2: Price must close (not touch) beyond 50pt buffer zone ───────
  const BUFFER   = 50;
  const ceBreach = candle.close > strikes.shortCe + BUFFER;
  const peBreach = candle.close < strikes.shortPe - BUFFER;

  if (ceBreach || peBreach) {
    // ── Rule 3: Volume confirmation ──────────────────────────────────────
    if (candle.volume === 0) {
      return { shouldExit: false, flagged: false, rule: null,
        reason: 'Volume unavailable — Rule 3 skipped, treating as hunt' };
    }

    if (candle.volume < avgVolume * 1.5) {
      return { shouldExit: false, flagged: false, rule: null,
        reason: `Volume ${candle.volume} < 1.5× avg ${avgVolume} — likely hunt` };
    }

    const side   = ceBreach ? 'CE' : 'PE';
    const strike = ceBreach ? strikes.shortCe : strikes.shortPe;
    return { shouldExit: true, flagged: false, rule: 2,
      reason: `${side} short strike ${strike} breached by >50pts on high volume` };
  }

  // ── Rule 5: Delta monitoring (flag only, not exit) ────────────────────────
  if (ceDelta != null && ceDelta > 0.35) {
    return { shouldExit: false, flagged: true, rule: 5,
      reason: `Short CE delta ${ceDelta} exceeds 0.35 — high risk alert` };
  }
  if (peDelta != null && peDelta < -0.35) {
    return { shouldExit: false, flagged: true, rule: 5,
      reason: `Short PE delta ${peDelta} below -0.35 — high risk alert` };
  }

  return { shouldExit: false, flagged: false, rule: null, reason: 'All rules within bounds' };
}

/**
 * Rule 8 — Claude hunt detection (AI and HYBRID modes only).
 * Called by position-tracker after the synchronous evaluate() returns a
 * flag (not a definitive exit) to get a second opinion from Claude.
 *
 * @param {object} position     — same shape as evaluate()'s position param
 * @param {object} candle       — the just-closed 15m candle
 * @param {object} sessionCtx   — SessionContext.snapshot()
 * @returns {Promise<{ isLikelyHunt: boolean, confidence: number, reasoning: string, action: string }>}
 */
async function evaluateWithClaude(position, candle, sessionCtx) {
  const mode = (config.INTELLIGENCE_MODE || 'HYBRID').toUpperCase();

  // Skip in RULES mode or if Claude circuit breaker has tripped
  if (mode === 'RULES' || !claudeClient.isAvailable()) {
    return { isLikelyHunt: false, confidence: 0, reasoning: 'Claude unavailable or RULES mode', action: 'HOLD' };
  }

  const prompt = promptBuilder.buildHuntPrompt(position, candle, sessionCtx);

  let text;
  try {
    text = await claudeClient.call(prompt);
  } catch (err) {
    return { isLikelyHunt: false, confidence: 0, reasoning: `Claude call failed: ${err.message}`, action: 'HOLD' };
  }

  const parsed = claudeClient.parseJSON(text);
  if (!parsed) {
    return { isLikelyHunt: false, confidence: 0, reasoning: 'Unparseable Claude response', action: 'HOLD' };
  }

  return {
    isLikelyHunt: parsed.isLikelyHunt === true,
    confidence:   typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    reasoning:    parsed.reasoning || '',
    action:       parsed.action    || 'HOLD',
  };
}

module.exports = { evaluate, evaluateWithClaude };
