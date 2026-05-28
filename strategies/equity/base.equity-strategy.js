/**
 * @file base.equity-strategy.js
 * @description Abstract base class for all Drishti equity directional strategies (Phase 6).
 *              Every equity strategy must extend this class and implement checkPattern().
 *              The equity registry validates this at load time.
 *
 *              To add a new equity strategy:
 *                1. Create [name].equity-strategy.js in /strategies/equity
 *                2. Extend BaseEquityStrategy
 *                3. Implement all abstract members below
 *                4. equity/registry.js auto-discovers it on boot
 */

'use strict';

class BaseEquityStrategy {
  // ── Identity ──────────────────────────────────────────────────────────────

  /**
   * Human-readable name of the strategy.
   * @returns {string} e.g. "Bull Flag"
   */
  get name() {
    throw new Error(`[${this.constructor.name}] getter 'name' must be implemented`);
  }

  /**
   * Directional bias this pattern targets.
   * @returns {'BULLISH' | 'BEARISH' | 'NEUTRAL'}
   */
  get direction() {
    throw new Error(`[${this.constructor.name}] getter 'direction' must be implemented`);
  }

  /**
   * Short description of what this pattern looks for.
   * Included in Claude prompts and Telegram output.
   * @returns {string}
   */
  get description() {
    throw new Error(`[${this.constructor.name}] getter 'description' must be implemented`);
  }

  // ── Core Interface ────────────────────────────────────────────────────────

  /**
   * Evaluates whether the pattern is present in the given candle + indicator data.
   * Must be a pure function — no side effects, no API calls.
   *
   * @param {object} params
   * @param {Array}  params.candles    - OHLCV candle array for this timeframe (oldest first)
   * @param {object} params.indicators - { rsi, ema9, ema21, macd, bb, volume, avgVolume }
   * @param {object} params.context    - { prevDayHigh, prevDayLow, prevDayClose, vwap, dayOpen }
   * @param {number} params.timeframe  - Candle timeframe in minutes (1 | 5 | 15)
   *
   * @returns {{
   *   patternName: string,
   *   direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
   *   state: 'FORMING' | 'CONFIRMED' | 'NONE',
   *   confidence: number,
   *   signals: string[],
   *   failedConditions: string[]
   * }}
   *   state       — 'NONE' means pattern not detected on this timeframe
   *   confidence  — 0–100; meaningful only when state !== 'NONE'
   *   signals     — human-readable list of conditions that fired
   *   failedConditions — conditions that did not pass (for debugging)
   */
  checkPattern(params) {
    throw new Error(`[${this.constructor.name}] checkPattern() must be implemented`);
  }
}

module.exports = BaseEquityStrategy;
