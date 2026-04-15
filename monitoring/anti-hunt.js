/**
 * @file anti-hunt.js
 * @description Pure function module — no event bus imports. Evaluates anti-hunt rules
 *              against current position state and last 15m candle. Called by
 *              position-tracker.js on each CANDLE_CLOSE_15M event.
 *
 *              Rule evaluation order (strict):
 *                6 → 4 → 1+2 → 3 → 5
 *              Rule 8 (Claude hunt detection) skipped silently in RULES mode.
 */
'use strict';

const config = require('../config');

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

module.exports = { evaluate };
