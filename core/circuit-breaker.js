/**
 * @file circuit-breaker.js
 * @description Implements all 7 circuit breakers for Drishti. These are hardcoded
 *              safety limits that cannot be disabled via config. When any breaker
 *              trips, isTripped() returns true, new entries are blocked, and the
 *              CIRCUIT_BREAKER_HIT event is emitted on the event bus.
 *
 *              Breakers:
 *                1. daily_loss          — pnlToday crosses -MAX_DAILY_LOSS
 *                2. consecutive_loss    — N consecutive losing trades
 *                3. fill_price_deviation — fill > 5% from expected price
 *                4. websocket_timeout   — WS down >30s with open position
 *                5. claude_api          — Claude API unavailable
 *                6. absolute_pnl_stop   — position loss > 50% of max daily loss
 *                7. manual_pause        — /pause command from Telegram
 *
 *              Phase 4: per-strategy daily loss limit (checkStrategyDailyLoss).
 *                Tripping a strategy breaker blocks only that strategy — it does NOT
 *                set isTripped() true and does not affect other strategies.
 *                Each strategy gets MAX_DAILY_LOSS * STRATEGY_CAPITAL_PCT as its cap.
 */

const eventBus = require('./event-bus');
const EVENTS = require('./events');
const config = require('../config');

// Maximum allowed fill price deviation from expected (5%)
const MAX_FILL_DEVIATION = 0.05;

class CircuitBreaker {
  constructor() {
    // Each breaker: { triggered, reason, triggeredAt }
    this._breakers = {
      daily_loss:           { triggered: false, reason: null, triggeredAt: null },
      consecutive_loss:     { triggered: false, reason: null, triggeredAt: null },
      fill_price_deviation: { triggered: false, reason: null, triggeredAt: null },
      websocket_timeout:    { triggered: false, reason: null, triggeredAt: null },
      claude_api:           { triggered: false, reason: null, triggeredAt: null },
      absolute_pnl_stop:    { triggered: false, reason: null, triggeredAt: null },
      manual_pause:         { triggered: false, reason: null, triggeredAt: null },
    };

    // Phase 4: per-strategy daily loss breakers — keyed by strategy name.
    // Tripping one does NOT affect isTripped() — other strategies continue unaffected.
    // Map<strategyName, { triggered, reason, triggeredAt }>
    this._strategyBreakers = new Map();
  }

  // ── Internal trip helper ─────────────────────────────────────────────────

  /**
   * Trips a named breaker. Emits CIRCUIT_BREAKER_HIT if not already tripped.
   * @private
   */
  _trip(breakerName, reason) {
    if (this._breakers[breakerName].triggered) return; // already tripped

    const ts = new Date().toTimeString().slice(0, 8);
    this._breakers[breakerName] = {
      triggered: true,
      reason,
      triggeredAt: new Date().toISOString(),
    };

    console.error(`[${ts}] [CircuitBreaker] [ERROR] TRIPPED: ${breakerName} — ${reason}`);

    eventBus.emit(EVENTS.CIRCUIT_BREAKER_HIT, {
      breakerName,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  // ── Public check methods ─────────────────────────────────────────────────

  /**
   * Breaker 1: Trip if today's P&L is worse than -MAX_DAILY_LOSS.
   * @param {number} pnlToday - Current day P&L in rupees (negative = loss)
   */
  checkDailyLoss(pnlToday) {
    if (pnlToday < -config.MAX_DAILY_LOSS) {
      this._trip(
        'daily_loss',
        `Daily loss ₹${Math.abs(pnlToday).toFixed(0)} exceeded limit ₹${config.MAX_DAILY_LOSS}`
      );
    }
  }

  /**
   * Breaker 2: Trip if consecutive losing trades reach the configured threshold.
   * Can be reset manually via Telegram /resume.
   * @param {number} count - Current consecutive loss count
   */
  checkConsecutiveLoss(count) {
    if (count >= config.CONSECUTIVE_LOSS_PAUSE) {
      this._trip(
        'consecutive_loss',
        `${count} consecutive losses — pausing new entries. Send /resume to re-enable.`
      );
    }
  }

  /**
   * Breaker 3: Trip if a fill price deviates more than 5% from expected.
   * Rejects the fill and alerts. Does NOT auto-reset.
   * @param {number} expectedPrice
   * @param {number} actualFillPrice
   * @returns {boolean} true if deviation is acceptable, false if fill should be rejected
   */
  checkFillPrice(expectedPrice, actualFillPrice) {
    const deviation = Math.abs(actualFillPrice - expectedPrice) / expectedPrice;
    if (deviation > MAX_FILL_DEVIATION) {
      this._trip(
        'fill_price_deviation',
        `Fill ₹${actualFillPrice} deviates ${(deviation * 100).toFixed(1)}% from expected ₹${expectedPrice}`
      );
      return false; // caller should reject this fill
    }
    return true; // fill is acceptable
  }

  /**
   * Breaker 4: Trip if WebSocket has been down for longer than the configured
   * timeout AND there is an open position.
   * @param {number} secondsDown - How many seconds the WS has been disconnected
   * @param {boolean} hasOpenPosition
   */
  checkWebsocketTimeout(secondsDown, hasOpenPosition) {
    if (hasOpenPosition && secondsDown >= config.WEBSOCKET_RECONNECT_TIMEOUT) {
      this._trip(
        'websocket_timeout',
        `WebSocket disconnected for ${secondsDown}s with open position — triggering emergency exit`
      );
    }
  }

  /**
   * Breaker 5: Trip when Claude API is unavailable.
   * App falls back to RULES-only mode for the rest of the session.
   * @param {string} reason
   */
  tripClaudeApi(reason) {
    this._trip('claude_api', reason || 'Claude API unavailable');
  }

  /**
   * Breaker 6: Trip if the current position loss exceeds ABSOLUTE_PNL_STOP_PCT
   * of MAX_DAILY_LOSS. Immediate exit — bypasses all anti-hunt rules.
   * @param {number} positionLoss - Current open position loss in rupees (positive number)
   */
  checkAbsolutePnlStop(positionLoss) {
    if (positionLoss >= config.ABSOLUTE_PNL_STOP_RUPEES) {
      this._trip(
        'absolute_pnl_stop',
        `Position loss ₹${positionLoss.toFixed(0)} hit absolute stop ₹${config.ABSOLUTE_PNL_STOP_RUPEES}`
      );
    }
  }

  /**
   * Breaker 7: Manual pause/resume via Telegram /pause and /resume commands.
   * @param {boolean} paused - true to pause (trip), false to resume (reset)
   */
  toggleManualPause(paused) {
    if (paused) {
      this._trip('manual_pause', 'Manual pause requested via Telegram /pause');
    } else {
      this.reset('manual_pause');
      this.reset('consecutive_loss'); // /resume also clears consecutive loss
    }
  }

  // ── State queries ────────────────────────────────────────────────────────

  /**
   * Returns true if ANY breaker is currently tripped.
   * @returns {boolean}
   */
  isTripped() {
    return Object.values(this._breakers).some((b) => b.triggered);
  }

  /**
   * Returns true if a specific breaker is tripped.
   * @param {string} breakerName
   * @returns {boolean}
   */
  isBreaker(breakerName) {
    return this._breakers[breakerName]?.triggered === true;
  }

  /**
   * Returns a snapshot of all breaker states.
   * @returns {object}
   */
  getStatus() {
    return JSON.parse(JSON.stringify(this._breakers));
  }

  /**
   * Returns only the tripped breakers.
   * @returns {Array<{name, reason, triggeredAt}>}
   */
  getTripped() {
    return Object.entries(this._breakers)
      .filter(([, b]) => b.triggered)
      .map(([name, b]) => ({ name, reason: b.reason, triggeredAt: b.triggeredAt }));
  }

  // ── Per-strategy breakers (Phase 4) ─────────────────────────────────────

  /**
   * Breaker 8 (per-strategy): Trip if a single strategy's realised loss for the
   * day exceeds its capital allocation cap. Blocks only that strategy — does NOT
   * trip isTripped() and does not affect other strategies.
   *
   * Cap = MAX_DAILY_LOSS * STRATEGY_CAPITAL_PCT[strategyName]
   * Falls back to MAX_DAILY_LOSS if strategy is not in the PCT map.
   *
   * @param {string} strategyName
   * @param {number} strategyLossToday - Realised loss for this strategy today (positive number)
   */
  checkStrategyDailyLoss(strategyName, strategyLossToday) {
    const pct = config.STRATEGY_CAPITAL_PCT?.[strategyName] ?? 1.0;
    const cap = config.MAX_DAILY_LOSS * pct;

    if (strategyLossToday >= cap) {
      if (this._strategyBreakers.get(strategyName)?.triggered) return; // already tripped

      const reason = `${strategyName} daily loss ₹${strategyLossToday.toFixed(0)} exceeded cap ₹${cap.toFixed(0)}`;
      const ts = new Date().toTimeString().slice(0, 8);
      console.error(`[${ts}] [CircuitBreaker] [ERROR] STRATEGY TRIPPED: ${strategyName} — ${reason}`);

      this._strategyBreakers.set(strategyName, {
        triggered:   true,
        reason,
        triggeredAt: new Date().toISOString(),
      });

      eventBus.emit(EVENTS.CIRCUIT_BREAKER_HIT, {
        breakerName: `strategy_daily_loss:${strategyName}`,
        reason,
        timestamp:   new Date().toISOString(),
      });
    }
  }

  /**
   * Returns true if a specific strategy's daily loss breaker is tripped.
   * Used by strategy-allocator to block a single strategy while others continue.
   * @param {string} strategyName
   * @returns {boolean}
   */
  isStrategyTripped(strategyName) {
    return this._strategyBreakers.get(strategyName)?.triggered === true;
  }

  /**
   * Resets a per-strategy breaker. Called at start of new trading day.
   * @param {string} strategyName
   */
  resetStrategy(strategyName) {
    if (!this._strategyBreakers.has(strategyName)) return;
    this._strategyBreakers.delete(strategyName);
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`[${ts}] [CircuitBreaker] [INFO] Strategy breaker reset: ${strategyName}`);
  }

  /**
   * Resets all per-strategy breakers. Called at start of new trading day alongside resetAll().
   */
  resetAllStrategyBreakers() {
    this._strategyBreakers.clear();
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`[${ts}] [CircuitBreaker] [INFO] All strategy breakers reset for new session`);
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  /**
   * Resets a specific breaker. Use with care — most breakers should only be
   * reset via controlled paths (e.g. /resume for manual_pause).
   * @param {string} breakerName
   */
  reset(breakerName) {
    if (!this._breakers[breakerName]) {
      throw new Error(`[CircuitBreaker] Unknown breaker: ${breakerName}`);
    }
    const wasTripped = this._breakers[breakerName].triggered;
    this._breakers[breakerName] = { triggered: false, reason: null, triggeredAt: null };

    if (wasTripped) {
      const ts = new Date().toTimeString().slice(0, 8);
      console.log(`[${ts}] [CircuitBreaker] [INFO] Reset: ${breakerName}`);
      eventBus.emit(EVENTS.CIRCUIT_BREAKER_RESET, {
        breakerName,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Resets all breakers. Only use at start of new trading day.
   */
  resetAll() {
    Object.keys(this._breakers).forEach((name) => {
      this._breakers[name] = { triggered: false, reason: null, triggeredAt: null };
    });
    const ts = new Date().toTimeString().slice(0, 8);
    console.log(`[${ts}] [CircuitBreaker] [INFO] All breakers reset for new session`);
  }
}

module.exports = CircuitBreaker;
