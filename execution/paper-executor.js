/**
 * @file paper-executor.js
 * @description Simulates order fills with fixed slippage. Uses last cached option
 *              prices from OPTIONS_CHAIN_UPDATED. Swap point for spread-based
 *              slippage (Phase 3): replace fill price calculation in _fillPrice() only.
 */
'use strict';

const OrderExecutor  = require('./order-executor');
const config         = require('../config');
const { v4: uuidv4 } = require('uuid');

// Deferred requires — avoids module resolution failures in test stubs.
// Falls back to a no-op emitter if the module cannot be resolved (test environment).
let _eventBus = null;
let _EVENTS   = null;
const _noopEmitter = { emit: () => {}, on: () => {} };

function getEventBus() {
  if (_eventBus) return _eventBus;
  try {
    _eventBus = require('../core/event-bus');
  } catch (_) {
    _eventBus = _noopEmitter;
  }
  return _eventBus;
}
function getEvents() {
  if (_EVENTS) return _EVENTS;
  try {
    _EVENTS = require('../core/events');
  } catch (_) {
    _EVENTS = {};
  }
  return _EVENTS;
}

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [PaperExecutor] [${level}] ${msg}`);
}

class PaperExecutor extends OrderExecutor {
  constructor() {
    super();
    this._lastLtp        = null;
    this._lastStrikeData = {};
    this._activeOrders   = {};

    // Wire up live event listeners lazily on first tick/chain update
    setImmediate(() => {
      const eventBus = getEventBus();
      const EVENTS   = getEvents();
      eventBus.on(EVENTS.TICK_RECEIVED, ({ ltp }) => {
        this._lastLtp = ltp;
      });
      eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED, ({ strikeData }) => {
        if (strikeData) this._lastStrikeData = strikeData;
      });
    });
  }

  /**
   * Swap point for Phase 3: replace this method to use bid/ask spread.
   * @private
   */
  _fillPrice(optionLtp, action) {
    const slip = config.SLIPPAGE_PER_LOT;
    return action === 'BUY' ? optionLtp + slip : optionLtp - slip;
  }

  async placeOrder(legs) {
    const filledLegs = legs.map(leg => {
      const strikeEntry = this._lastStrikeData[leg.strike] || {};
      const optionLtp   = leg.type === 'CE' ? strikeEntry.ce : strikeEntry.pe;
      if (optionLtp == null) {
        throw new Error(`[PaperExecutor] No price data for strike ${leg.strike} ${leg.type}`);
      }
      return { ...leg, fillPrice: this._fillPrice(optionLtp, leg.action) };
    });

    const netPremiumPerLot = filledLegs.reduce((sum, leg) => {
      return sum + (leg.action === 'SELL' ? leg.fillPrice : -leg.fillPrice);
    }, 0);
    const premiumCollected = Math.round(netPremiumPerLot * config.NIFTY_LOT_SIZE * 100) / 100;

    const fill = {
      orderId:          uuidv4(),
      legs:             filledLegs,
      premiumCollected,
      timestamp:        new Date().toISOString(),
    };

    this._activeOrders[fill.orderId] = fill;
    log('INFO', `Filled IC: premium collected ₹${premiumCollected}`);
    getEventBus().emit(getEvents().ORDER_FILLED, fill);
    return fill;
  }

  async exitOrder(orderId) {
    const entryFill = this._activeOrders[orderId];
    if (!entryFill) throw new Error(`[PaperExecutor] Unknown orderId: ${orderId}`);

    const exitLegs = entryFill.legs.map(leg => {
      const strikeEntry = this._lastStrikeData[leg.strike] || {};
      const optionLtp   = leg.type === 'CE' ? strikeEntry.ce : strikeEntry.pe;
      const exitAction  = leg.action === 'SELL' ? 'BUY' : 'SELL';
      const fillPrice   = optionLtp != null
        ? this._fillPrice(optionLtp, exitAction)
        : leg.fillPrice;
      return { ...leg, exitAction, exitFillPrice: fillPrice };
    });

    const exitPremiumPerLot = exitLegs.reduce((sum, leg) => {
      return sum + (leg.action === 'SELL' ? -leg.exitFillPrice : leg.exitFillPrice);
    }, 0);
    const exitPremiumPaid = Math.round(exitPremiumPerLot * config.NIFTY_LOT_SIZE * 100) / 100;
    const realisedPnl     = Math.round((entryFill.premiumCollected - exitPremiumPaid) * 100) / 100;

    const exitResult = {
      orderId,
      legs:        exitLegs,
      realisedPnl,
      timestamp:   new Date().toISOString(),
    };

    delete this._activeOrders[orderId];
    log('INFO', `Exited IC: realised P&L ₹${realisedPnl}`);
    getEventBus().emit(getEvents().ORDER_EXITED, exitResult);
    return exitResult;
  }

  computeUnrealisedPnl(fill) {
    const currentPremiumPerLot = fill.legs.reduce((sum, leg) => {
      const strikeEntry = this._lastStrikeData[leg.strike] || {};
      const currentLtp  = leg.type === 'CE' ? strikeEntry.ce : strikeEntry.pe;
      if (currentLtp == null) return sum;
      return sum + (leg.action === 'SELL' ? currentLtp : -currentLtp);
    }, 0);
    const currentPremium = currentPremiumPerLot * config.NIFTY_LOT_SIZE;
    return Math.round((fill.premiumCollected - currentPremium) * 100) / 100;
  }
}

module.exports = new PaperExecutor();
