/**
 * @file base.strategy.js
 * @description Abstract base class for all Drishti trading strategies.
 *              Every strategy must extend this class and implement all methods.
 *              The registry validates this at startup — missing implementations
 *              will throw immediately, not silently at runtime.
 *
 *              To add a new strategy:
 *                1. Create [name].strategy.js in /strategies
 *                2. Extend BaseStrategy
 *                3. Implement all abstract methods below
 *                4. registry.js auto-discovers and registers it on boot
 */

class BaseStrategy {
  // ── Identity ──────────────────────────────────────────────────────────────

  /**
   * Human-readable name of the strategy.
   * @returns {string} e.g. "Iron Condor"
   */
  get name() {
    throw new Error(`[${this.constructor.name}] getter 'name' must be implemented`);
  }

  /**
   * Which market regimes this strategy is eligible to run in.
   * @returns {string | string[]} "A" | "B" | "C" | ["A", "B"]
   */
  get regime() {
    throw new Error(`[${this.constructor.name}] getter 'regime' must be implemented`);
  }

  /**
   * Plain-text description sent to Claude as part of the system prompt.
   * Explain what the strategy is, why it works, and what conditions it needs.
   * @returns {string}
   */
  get claudeDescription() {
    throw new Error(`[${this.constructor.name}] getter 'claudeDescription' must be implemented`);
  }

  // ── Core Interface ────────────────────────────────────────────────────────

  /**
   * Evaluates whether current market conditions are suitable for this strategy.
   * Must be a pure function — no side effects, no API calls.
   *
   * @param {object} marketData - Full market snapshot (see rule-engine.md for shape)
   * @returns {{ eligible: boolean, score: number, reasons: Array, failedConditions: Array }}
   *   eligible        — true only if ALL hard gates pass AND score >= threshold
   *   score           — 0–100 representing how strongly conditions align
   *   reasons         — array of { condition, value, points, max, note }
   *   failedConditions— array of hard-gate names that failed
   */
  checkConditions(marketData) {
    throw new Error(`[${this.constructor.name}] checkConditions() must be implemented`);
  }

  /**
   * Constructs the trade legs given current market data.
   * Called only after checkConditions() returns eligible: true.
   *
   * @param {object} marketData
   * @returns {{
   *   legs: Array<{ type: string, strike: number, expiry: string, side: string, lots: number }>,
   *   expectedPremium: number,
   *   maxLoss: number,
   *   maxProfit: number,
   *   riskRewardRatio: number
   * }}
   */
  buildTrade(marketData) {
    throw new Error(`[${this.constructor.name}] buildTrade() must be implemented`);
  }

  /**
   * Assembles the strategy-specific portion of a Claude prompt.
   * Combined with market data by prompt-builder.js.
   *
   * @param {object} marketData
   * @returns {string} Markdown-formatted context block for Claude
   */
  buildClaudePrompt(marketData) {
    throw new Error(`[${this.constructor.name}] buildClaudePrompt() must be implemented`);
  }

  /**
   * Returns exit conditions for an active trade.
   *
   * @param {object} trade - The trade returned by buildTrade()
   * @returns {{
   *   exitIfNiftyClosesAbove: number,
   *   exitIfNiftyClosesBelow: number,
   *   deltaCeThreshold: number,
   *   deltaPeThreshold: number,
   *   absolutePnlStop: number,
   *   squareOffTime: string,
   *   exitTimeframe: string
   * }}
   */
  getExitConditions(trade) {
    throw new Error(`[${this.constructor.name}] getExitConditions() must be implemented`);
  }

  /**
   * Validates whether a partial fill scenario is acceptable (i.e. can proceed
   * with the filled legs, or must rollback everything).
   * For Iron Condor: any partial fill → rollback (all 4 legs or nothing).
   *
   * @param {Array} filledLegs - Legs that have been filled so far
   * @returns {boolean} true = proceed with partial fill, false = rollback all
   */
  validatePartialFill(filledLegs) {
    throw new Error(`[${this.constructor.name}] validatePartialFill() must be implemented`);
  }

  // ── Helper available to all strategies ───────────────────────────────────

  /**
   * Returns the allowed regimes as an array regardless of how regime was defined.
   * @returns {string[]}
   */
  getAllowedRegimes() {
    return Array.isArray(this.regime) ? this.regime : [this.regime];
  }

  /**
   * Returns true if this strategy is eligible for a given regime.
   * @param {string} regime
   * @returns {boolean}
   */
  supportsRegime(regime) {
    return this.getAllowedRegimes().includes(regime);
  }
}

module.exports = BaseStrategy;
