/**
 * @file session-context.js
 * @description Tracks all accumulated context for the current trading day.
 *              Initialised at market open, reset at end of day.
 *              Phase 1 will hook this into CANDLE_CLOSE_1M (first hour tracking)
 *              and INDICATORS_UPDATED (VIX updates). For Phase 0, hooks are stubs.
 */

const eventBus = require('./event-bus');
const EVENTS = require('./events');

class SessionContext {
  constructor() {
    this._data = this._defaultData();
    this._hookEvents();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Returns a fresh data object with all fields at zero/null.
   * @private
   */
  _defaultData() {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    return {
      date: dateStr,

      // Price reference points (set from first tick / historical data)
      dayOpen: null,
      dayHigh: null,
      dayLow: null,

      // First hour (09:15–10:15 IST) — tracked by Phase 1 data layer
      firstHourHigh: null,
      firstHourLow: null,
      firstHourComplete: false,

      // VIX
      vixAtOpen: null,
      vixCurrent: null,

      // Regime
      currentRegime: null,     // "A" | "B" | "C" | null
      lastRegime: null,
      regimeChangesToday: 0,

      // Trade tracking
      tradesToday: 0,
      pnlToday: 0,             // rupees, net (including costs)
      grossPnlToday: 0,        // rupees, before brokerage/taxes
      consecutiveLosses: 0,
      wins: 0,
      losses: 0,

      // Session flags
      isPaused: false,         // set by /pause Telegram command
      claudeAvailable: true,   // false when Claude circuit breaker trips
    };
  }

  /**
   * Wires event bus listeners for Phase 1 data layer events.
   * @private
   */
  _hookEvents() {
    // IST offset helper — avoids timezone dependency on host machine
    const toIST = (ts) => {
      const istMs = ts + 5.5 * 60 * 60 * 1000;
      return {
        hour:   Math.floor((istMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)),
        minute: Math.floor((istMs % (60 * 60 * 1000))      / (60 * 1000)),
      };
    };

    eventBus.on(EVENTS.TICK_RECEIVED, ({ ltp }) => {
      if (this._data.dayOpen === null)                              this._data.dayOpen = ltp;
      if (this._data.dayHigh === null || ltp > this._data.dayHigh) this._data.dayHigh = ltp;
      if (this._data.dayLow  === null || ltp < this._data.dayLow)  this._data.dayLow  = ltp;
    });

    eventBus.on(EVENTS.CANDLE_CLOSE_1M, ({ openTime, high, low }) => {
      const { hour, minute } = toIST(openTime);
      // Track first-hour highs/lows for candles starting at 09:15–10:14 IST
      const inFirstHour = (hour === 9 && minute >= 15) || (hour === 10 && minute < 15);
      if (inFirstHour) {
        if (this._data.firstHourHigh === null || high > this._data.firstHourHigh)
          this._data.firstHourHigh = high;
        if (this._data.firstHourLow  === null || low  < this._data.firstHourLow)
          this._data.firstHourLow  = low;
      }
      // Mark first hour complete when the 10:15 IST candle closes
      if (hour === 10 && minute === 15) this._data.firstHourComplete = true;
    });

    eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED, ({ vix }) => {
      if (this._data.vixAtOpen === null) this._data.vixAtOpen = vix;
      this._data.vixCurrent = vix;
    });

    // Phase 2: hook POSITION_CLOSED → update pnlToday, consecutiveLosses, wins/losses
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Updates one or more fields in the session context.
   * @param {Partial<SessionData>} updates - Key/value pairs to update
   */
  update(updates) {
    if (typeof updates !== 'object' || updates === null) {
      throw new Error('[SessionContext] update() requires a plain object');
    }
    Object.assign(this._data, updates);
  }

  /**
   * Records a completed trade and updates running P&L and streak counters.
   * @param {number} netPnl - Net P&L in rupees (negative = loss)
   * @param {number} grossPnl - Gross P&L before costs
   */
  recordTrade(netPnl, grossPnl) {
    this._data.tradesToday += 1;
    this._data.pnlToday += netPnl;
    this._data.grossPnlToday += grossPnl;

    if (netPnl >= 0) {
      this._data.wins += 1;
      this._data.consecutiveLosses = 0;
    } else {
      this._data.losses += 1;
      this._data.consecutiveLosses += 1;
    }
  }

  /**
   * Updates the market regime and increments change counter if it changed.
   * @param {string} newRegime - "A" | "B" | "C"
   */
  updateRegime(newRegime) {
    if (this._data.currentRegime && this._data.currentRegime !== newRegime) {
      this._data.lastRegime = this._data.currentRegime;
      this._data.regimeChangesToday += 1;
      const ts = new Date().toTimeString().slice(0, 8);
      console.log(
        `[${ts}] [SessionContext] [INFO] Regime change: ${this._data.currentRegime} → ${newRegime} (${this._data.regimeChangesToday} today)`
      );
    }
    this._data.currentRegime = newRegime;
  }

  /**
   * Returns a deep copy of the current session data.
   * @returns {object}
   */
  snapshot() {
    return JSON.parse(JSON.stringify(this._data));
  }

  /**
   * Resets all data for a new trading day. Called at end of session or on boot.
   */
  reset() {
    this._data = this._defaultData();
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`[${ts}] [SessionContext] [INFO] Session context reset for ${this._data.date}`);
  }

  // ── Convenience getters ───────────────────────────────────────────────────

  get tradesToday()       { return this._data.tradesToday; }
  get pnlToday()          { return this._data.pnlToday; }
  get consecutiveLosses() { return this._data.consecutiveLosses; }
  get currentRegime()     { return this._data.currentRegime; }
  get vixCurrent()        { return this._data.vixCurrent; }
  get isPaused()          { return this._data.isPaused; }
}

module.exports = SessionContext;

// Shared singleton — use this everywhere outside of tests.
// Tests create isolated instances via `new SessionContext()` directly.
module.exports.shared = new SessionContext();
