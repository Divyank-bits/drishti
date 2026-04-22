/**
 * @file position-tracker.js
 * @description Monitors active positions across all strategies. Starts after ORDER_FILLED,
 *              calls anti-hunt.evaluate() on each CANDLE_CLOSE_15M, handles square-off,
 *              and manages the full exit lifecycle through to TRADE_CLOSED.
 *              Phase 4: positions are keyed by strategyId; per-strategy and aggregate
 *              P&L are tracked and included in POSITION_UPDATED payloads.
 */
'use strict';

const eventBus       = require('../core/event-bus');
const EVENTS         = require('../core/events');
const StateMachine   = require('../core/state-machine');
const SessionContext  = require('../core/session-context');
const antiHunt       = require('./anti-hunt');
const config         = require('../config');
const executor       = config.EXECUTION_MODE === 'LIVE'
  ? require('../execution/dhan-executor')
  : require('../execution/paper-executor');
const journal        = require('../journal/trade-journal');

const stateMachine   = new StateMachine();
const sessionContext = SessionContext.shared;

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [PositionTracker] [${level}] ${msg}`);
}

function toIST(tsMs) {
  const istMs  = tsMs + 5.5 * 3600 * 1000;
  const hour   = Math.floor((istMs % (24 * 3600000)) / 3600000);
  const minute = Math.floor((istMs % 3600000) / 60000);
  return { hour, minute };
}

class PositionTracker {
  constructor() {
    this._activeFill    = null;
    this._entryTime     = null;
    this._lastKnownPnl  = 0;
    this._exiting       = false;
    this._candleVolumes = [];  // rolling 20 candle volumes for Rule 3 avg
    this._ceDelta       = null;
    this._peDelta       = null;

    // Phase 4: per-strategy realised P&L for the current session
    // Map<strategyName, number>
    this._strategyPnl = new Map();

    eventBus.on(EVENTS.ORDER_FILLED,               (fill)    => this._onFill(fill));
    eventBus.on(EVENTS.TICK_RECEIVED,              ({ ltp }) => this._onTick(ltp));
    eventBus.on(EVENTS.CANDLE_CLOSE_15M,           (candle)  => this._onCandle(candle));
    eventBus.on(EVENTS.INDICATORS_UPDATED,         (payload) => {
      if (payload.timeframe === 'options') {
        this._ceDelta = payload.indicators.ceDelta ?? null;
        this._peDelta = payload.indicators.peDelta ?? null;
      }
    });
    eventBus.on(EVENTS.EXIT_TRIGGERED,             ()        => this._exit('Manual/circuit exit'));
    eventBus.on(EVENTS.MANUAL_SQUAREOFF_REQUESTED, ()        => this._exit('Manual square-off via Telegram'));
  }

  /**
   * Returns per-strategy realised P&L map for the session.
   * @returns {Map<string, number>}
   */
  getStrategyPnl() {
    return new Map(this._strategyPnl);
  }

  /**
   * Returns aggregate realised P&L across all strategies this session.
   * @returns {number}
   */
  getAggregatePnl() {
    let total = 0;
    for (const pnl of this._strategyPnl.values()) total += pnl;
    return total;
  }

  _onFill(fill) {
    // Derive strikes from legs: SELL = short, BUY = long
    const shortCe = fill.legs.find(l => l.type === 'CE' && l.action === 'SELL')?.strike;
    const longCe  = fill.legs.find(l => l.type === 'CE' && l.action === 'BUY')?.strike;
    const shortPe = fill.legs.find(l => l.type === 'PE' && l.action === 'SELL')?.strike;
    const longPe  = fill.legs.find(l => l.type === 'PE' && l.action === 'BUY')?.strike;
    this._activeFill   = { ...fill, strikes: { shortCe, longCe, shortPe, longPe } };
    this._entryTime    = Date.now();
    this._lastKnownPnl = 0;
    this._exiting      = false;
    // Walk full chain from IDLE to ACTIVE (state machine enforces valid transitions)
    stateMachine.transition('SIGNAL_DETECTED');
    stateMachine.transition('AWAITING_APPROVAL');
    stateMachine.transition('ORDER_PLACING');
    stateMachine.transition('ACTIVE');
    log('INFO', `Monitoring position ${fill.orderId} [${fill.strategy || 'unknown'}] — premium ₹${fill.premiumCollected}`);
    journal.write('ORDER_FILLED', { legs: fill.legs, premiumCollected: fill.premiumCollected, strategy: fill.strategy });
  }

  _onTick(ltp) {
    if (!this._activeFill || this._exiting) return;
    eventBus.emit(EVENTS.POSITION_UPDATED, {
      orderId:        this._activeFill.orderId,
      strategy:       this._activeFill.strategy || 'unknown',
      unrealisedPnl:  this._lastKnownPnl,
      strategyPnl:    Object.fromEntries(this._strategyPnl),
      aggregatePnl:   this.getAggregatePnl(),
      ltp,
      timestamp:      Date.now(),
    });
  }

  _onOptionsChain(payload) {
    if (!this._activeFill || this._exiting) return;
    this._lastKnownPnl = executor.computeUnrealisedPnl(this._activeFill);
    journal.write('POSITION_UPDATED', { unrealisedPnl: this._lastKnownPnl, ltpAtUpdate: payload.underlyingValue });
  }

  _onCandle(candle) {
    if (!this._activeFill || this._exiting) return;

    // Update rolling volume history for Rule 3 avg
    if (candle.volume > 0) {
      this._candleVolumes.push(candle.volume);
      if (this._candleVolumes.length > 20) this._candleVolumes.shift();
    }
    const avgVolume = this._candleVolumes.length > 0
      ? this._candleVolumes.reduce((a, b) => a + b, 0) / this._candleVolumes.length
      : 0;

    // Square-off time check (15:15 IST)
    const { hour, minute } = toIST(candle.openTime);
    if (hour === 15 && minute >= 15) {
      log('INFO', 'Square-off time reached — exiting');
      this._exit('Square-off time 15:15 IST');
      return;
    }

    const position = {
      orderId:      this._activeFill.orderId,
      strikes:      this._activeFill.strikes,
      entryPremium: this._activeFill.premiumCollected,
      currentPnl:   this._lastKnownPnl,
      ceDelta:      this._ceDelta,
      peDelta:      this._peDelta,
      avgVolume,
    };

    const decision = antiHunt.evaluate(position, candle, sessionContext.snapshot());

    if (decision.flagged) {
      stateMachine.transition('FLAGGED');
      eventBus.emit(EVENTS.POSITION_FLAGGED, {
        orderId: this._activeFill.orderId,
        rule:    decision.rule,
        reason:  decision.reason,
        ceDelta: this._ceDelta,
        peDelta: this._peDelta,
      });
      journal.write('POSITION_FLAGGED', { rule: decision.rule, reason: decision.reason });
      log('WARN', `Position flagged: ${decision.reason}`);

      // Rule 8 — ask Claude whether this flag looks like a hunt (AI/HYBRID only)
      antiHunt.evaluateWithClaude(position, candle, sessionContext.snapshot())
        .then((huntResult) => {
          eventBus.emit(EVENTS.HUNT_DETECTION_RESULT, {
            orderId:     this._activeFill?.orderId,
            isLikelyHunt: huntResult.isLikelyHunt,
            confidence:  huntResult.confidence,
            reasoning:   huntResult.reasoning,
            action:      huntResult.action,
          });
          journal.write('HUNT_DETECTION', huntResult);
          log('INFO', `Rule 8: isLikelyHunt=${huntResult.isLikelyHunt} action=${huntResult.action} — ${huntResult.reasoning}`);

          // If Claude says EXIT and position is still active, honour it
          if (huntResult.action === 'EXIT' && this._activeFill && !this._exiting) {
            log('WARN', `Rule 8: Claude recommends EXIT — ${huntResult.reasoning}`);
            this._exit(`Rule 8 (Claude hunt detection): ${huntResult.reasoning}`);
          }
        })
        .catch((err) => {
          log('WARN', `Rule 8 evaluateWithClaude failed: ${err.message}`);
        });
    }

    if (decision.shouldExit) {
      log('WARN', `Exit signal: ${decision.reason}`);
      this._exit(decision.reason);
    }
  }

  async _exit(reason) {
    if (!this._activeFill || this._exiting) return;
    this._exiting = true;

    stateMachine.transition('EXITING');
    log('INFO', `Exiting position ${this._activeFill.orderId}: ${reason}`);

    try {
      const exitResult = await executor.exitOrder(this._activeFill.orderId);
      const duration   = Math.round((Date.now() - this._entryTime) / 1000);

      const strategyName = this._activeFill.strategy || 'unknown';

      // Accumulate per-strategy realised P&L
      const prev = this._strategyPnl.get(strategyName) || 0;
      this._strategyPnl.set(strategyName, prev + exitResult.realisedPnl);

      journal.write('ORDER_EXITED', { exitPrices: exitResult.legs, realisedPnl: exitResult.realisedPnl, strategy: strategyName });
      journal.write('TRADE_CLOSED', { realisedPnl: exitResult.realisedPnl, duration, reasoning: null, strategy: strategyName });

      stateMachine.transition('CLOSED');
      eventBus.emit(EVENTS.POSITION_CLOSED, {
        orderId:      this._activeFill.orderId,
        strategy:     strategyName,
        realisedPnl:  exitResult.realisedPnl,
        strategyPnl:  Object.fromEntries(this._strategyPnl),
        aggregatePnl: this.getAggregatePnl(),
        duration,
        reason,
      });

      log('INFO', `Position closed: P&L ₹${exitResult.realisedPnl}`);
      this._activeFill   = null;
      this._entryTime    = null;
      this._lastKnownPnl = 0;
      this._exiting      = false;

      stateMachine.transition('IDLE');
    } catch (err) {
      log('ERROR', `Exit failed: ${err.message}`);
      this._exiting = false;
    }
  }
}

// Wire OPTIONS_CHAIN_UPDATED after construction to avoid circular require at boot
const tracker = new PositionTracker();
eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED, (payload) => tracker._onOptionsChain(payload));

module.exports = tracker;
