/**
 * @file confluence-scorer.js
 * @description Multi-timeframe confluence scorer for Phase 6 equity directional scans.
 *              Weights: 15m = 50%, 5m = 30%, 1m = 20%.
 *              Score >= EQUITY_SCAN_CONFLUENCE_THRESHOLD → CONFIRMED
 *              Score >= EQUITY_SCAN_FORMING_THRESHOLD    → FORMING
 *              Score <  EQUITY_SCAN_FORMING_THRESHOLD    → no signal
 */

'use strict';

const config = require('../config');

// Timeframe weights must sum to 1.0
const WEIGHTS = { 15: 0.50, 5: 0.30, 1: 0.20 };

/**
 * Computes a weighted confluence score from per-timeframe strategy results.
 *
 * @param {object} resultsByTimeframe
 *   Keys are timeframe minutes (1, 5, 15). Each value is an array of
 *   { strategy, result } objects returned by equityRegistry.runAll().
 *   result shape: { state, confidence, patternName, direction, signals, failedConditions }
 *
 * @returns {{
 *   score:           number,       // 0–100 weighted confluence score
 *   state:           'CONFIRMED' | 'FORMING' | 'NONE',
 *   timeframeScores: object,       // { 1: number, 5: number, 15: number } raw per-tf scores
 *   dominantPattern: string|null,  // name of highest-confidence pattern across all timeframes
 *   dominantDirection: string|null // direction of dominant pattern
 * }}
 */
function score(resultsByTimeframe) {
  const timeframeScores = {};
  let   weightedSum     = 0;
  let   weightUsed      = 0;

  let bestConfidence    = -1;
  let dominantPattern   = null;
  let dominantDirection = null;

  for (const [tf, weight] of Object.entries(WEIGHTS)) {
    const tfNum   = Number(tf);
    const results = resultsByTimeframe[tfNum] || [];

    // Per-timeframe score = average confidence of non-NONE strategies
    const active = results.filter(r => r.result.state !== 'NONE');

    let tfScore = 0;
    if (active.length > 0) {
      tfScore = active.reduce((sum, r) => sum + r.result.confidence, 0) / active.length;
    }

    timeframeScores[tfNum] = Math.round(tfScore);
    weightedSum  += tfScore * weight;
    weightUsed   += weight;

    // Track dominant pattern (highest confidence across all timeframes)
    for (const { result } of active) {
      if (result.confidence > bestConfidence) {
        bestConfidence    = result.confidence;
        dominantPattern   = result.patternName;
        dominantDirection = result.direction;
      }
    }
  }

  const finalScore = weightUsed > 0 ? Math.round(weightedSum / weightUsed * 100) / 100 : 0;

  // Clamp to 0–100
  const clampedScore = Math.min(100, Math.max(0, Math.round(finalScore)));

  let state = 'NONE';
  if      (clampedScore >= config.EQUITY_SCAN_CONFLUENCE_THRESHOLD) state = 'CONFIRMED';
  else if (clampedScore >= config.EQUITY_SCAN_FORMING_THRESHOLD)    state = 'FORMING';

  return {
    score:            clampedScore,
    state,
    timeframeScores,
    dominantPattern,
    dominantDirection,
  };
}

module.exports = { score };
