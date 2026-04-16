/**
 * @file dhan-executor.js
 * @description Live order executor using Dhan REST API v2.
 *              Implements the same interface as PaperExecutor.
 *              Active when EXECUTION_MODE=LIVE. Each IC leg is placed as a
 *              separate MARKET order on NSE_FNO. All 4 legs must fill — any
 *              failure triggers rollback of successfully placed legs.
 */
'use strict';

const axios        = require('axios');
const { v4: uuidv4 } = require('uuid');
const OrderExecutor  = require('./order-executor');
const config         = require('../config');

// Deferred requires to avoid circular resolution issues.
let _eventBus = null;
let _EVENTS   = null;
const _noopEmitter = { emit: () => {}, on: () => {} };

function getEventBus() {
  if (_eventBus) return _eventBus;
  try { _eventBus = require('../core/event-bus'); } catch (_) { _eventBus = _noopEmitter; }
  return _eventBus;
}
function getEvents() {
  if (_EVENTS) return _EVENTS;
  try { _EVENTS = require('../core/events'); } catch (_) { _EVENTS = {}; }
  return _EVENTS;
}

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [DhanExecutor] [${level}] ${msg}`);
}

// ── Dhan order placement constants ─────────────────────────────────────────
const EXCHANGE_SEGMENT = 'NSE_FNO';
const PRODUCT_TYPE     = 'INTRADAY';
const ORDER_TYPE       = 'MARKET';
const ORDER_VALIDITY   = 'DAY';

// Polling config: check fill status every 500ms, give up after 30s
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS  = 30_000;

// Dhan order terminal states
const TERMINAL_STATES = new Set(['TRADED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'PART_TRADED']);

class DhanExecutor extends OrderExecutor {
  constructor() {
    super();
    this._lastStrikeData = {}; // { strike: { ce, pe, ceSecurityId, peSecurityId } }
    this._activeOrders   = {}; // internalId → fill object

    this._http = axios.create({
      baseURL: config.DHAN_REST_URL,
      headers: {
        'access-token': config.DHAN_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });

    setImmediate(() => {
      getEventBus().on(getEvents().OPTIONS_CHAIN_UPDATED, ({ strikeData }) => {
        if (strikeData) this._lastStrikeData = strikeData;
      });
    });
  }

  // ── Public interface ──────────────────────────────────────────────────────

  /**
   * Places all 4 IC legs as live MARKET orders on Dhan.
   * Rolls back any placed legs if a subsequent leg fails.
   *
   * @param {Array<{strike, type, action}>} legs
   * @returns {Promise<object>} fill object (mirrors PaperExecutor shape)
   */
  async placeOrder(legs) {
    const EVENTS   = getEvents();
    const eventBus = getEventBus();

    eventBus.emit(EVENTS.ORDER_PLACING, { legs });
    log('INFO', `Placing IC — ${legs.length} legs`);

    const placedDhanIds = []; // track for rollback
    const filledLegs    = [];

    try {
      for (const leg of legs) {
        const securityId = this._resolveSecurityId(leg);
        const qty        = (config.DEFAULT_LOTS || 1) * config.NIFTY_LOT_SIZE;

        const dhanOrderId = await this._placeOneLeg(leg, securityId, qty);
        placedDhanIds.push({ dhanOrderId, leg, action: leg.action });

        const fillDetails = await this._pollUntilFilled(dhanOrderId);
        filledLegs.push({
          ...leg,
          securityId,
          dhanOrderId,
          fillPrice: fillDetails.price,
          fillQty:   fillDetails.quantity,
        });

        log('INFO', `Leg filled: ${leg.action} ${leg.type} ${leg.strike} @ ₹${fillDetails.price}`);
      }
    } catch (err) {
      log('ERROR', `Leg placement failed: ${err.message} — rolling back ${placedDhanIds.length} placed legs`);
      await this._rollback(placedDhanIds);
      getEventBus().emit(EVENTS.ORDER_FAILED, { reason: err.message });
      getEventBus().emit(EVENTS.PARTIAL_FILL_ROLLBACK, { placedDhanIds });
      throw err;
    }

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
    log('INFO', `IC placed — premium collected ₹${premiumCollected}`);
    eventBus.emit(EVENTS.ORDER_FILLED, fill);
    return fill;
  }

  /**
   * Exits all 4 legs of an active IC by placing reverse MARKET orders.
   *
   * @param {string} orderId internal fill ID returned by placeOrder
   * @returns {Promise<object>} exit result with realisedPnl
   */
  async exitOrder(orderId) {
    const entryFill = this._activeOrders[orderId];
    if (!entryFill) throw new Error(`[DhanExecutor] Unknown orderId: ${orderId}`);

    log('INFO', `Exiting IC orderId=${orderId}`);
    const exitLegs = [];

    for (const leg of entryFill.legs) {
      const exitAction  = leg.action === 'SELL' ? 'BUY' : 'SELL';
      const qty         = leg.fillQty || (config.DEFAULT_LOTS || 1) * config.NIFTY_LOT_SIZE;

      const dhanOrderId = await this._placeOneLeg(
        { ...leg, action: exitAction },
        leg.securityId,
        qty,
      );
      const fillDetails = await this._pollUntilFilled(dhanOrderId);
      exitLegs.push({
        ...leg,
        exitAction,
        exitFillPrice: fillDetails.price,
        exitDhanOrderId: dhanOrderId,
      });
      log('INFO', `Exit leg filled: ${exitAction} ${leg.type} ${leg.strike} @ ₹${fillDetails.price}`);
    }

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
    log('INFO', `IC exited — realised P&L ₹${realisedPnl}`);
    getEventBus().emit(getEvents().ORDER_EXITED, exitResult);
    return exitResult;
  }

  /**
   * Computes unrealised P&L from current option prices in strikeData cache.
   * Falls back to entry fill price if current price is unavailable.
   *
   * @param {object} fill
   * @returns {number} unrealised P&L in rupees
   */
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

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolves the Dhan security_id for a leg from the last option chain snapshot.
   * @private
   */
  _resolveSecurityId(leg) {
    const strikeEntry = this._lastStrikeData[leg.strike];
    if (!strikeEntry) {
      throw new Error(`[DhanExecutor] No option chain data for strike ${leg.strike}`);
    }
    const secId = leg.type === 'CE' ? strikeEntry.ceSecurityId : strikeEntry.peSecurityId;
    if (!secId) {
      throw new Error(`[DhanExecutor] Missing security_id for ${leg.strike} ${leg.type}`);
    }
    return String(secId);
  }

  /**
   * Places one leg as a MARKET order on Dhan REST API.
   * Returns the Dhan order ID string.
   * @private
   */
  async _placeOneLeg(leg, securityId, qty) {
    const body = {
      dhanClientId:      config.DHAN_CLIENT_ID,
      transactionType:   leg.action,           // 'BUY' | 'SELL'
      exchangeSegment:   EXCHANGE_SEGMENT,      // 'NSE_FNO'
      productType:       PRODUCT_TYPE,          // 'INTRADAY'
      orderType:         ORDER_TYPE,            // 'MARKET'
      validity:          ORDER_VALIDITY,        // 'DAY'
      securityId,
      quantity:          qty,
      disclosedQuantity: 0,
      price:             0,                     // 0 for MARKET orders
      triggerPrice:      0,
      afterMarketOrder:  false,
    };

    try {
      const res = await this._http.post('/orders', body);
      const dhanOrderId = res.data?.orderId;
      if (!dhanOrderId) throw new Error(`Dhan returned no orderId: ${JSON.stringify(res.data)}`);
      log('INFO', `Order placed: ${leg.action} ${leg.type} ${leg.strike} → dhanOrderId=${dhanOrderId}`);
      return String(dhanOrderId);
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`_placeOneLeg failed for ${leg.action} ${leg.type} ${leg.strike}: ${detail}`);
    }
  }

  /**
   * Polls /orders/{id} until the order reaches a terminal state.
   * Returns { price, quantity } from the fill.
   * Throws if the order is rejected or times out.
   * @private
   */
  async _pollUntilFilled(dhanOrderId) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

      let res;
      try {
        res = await this._http.get(`/orders/${dhanOrderId}`);
      } catch (err) {
        log('WARN', `Poll GET failed for ${dhanOrderId}: ${err.message} — retrying`);
        continue;
      }

      const order  = res.data;
      const status = order?.orderStatus;

      if (!TERMINAL_STATES.has(status)) {
        log('DEBUG', `Order ${dhanOrderId} status=${status} — waiting`);
        continue;
      }

      if (status === 'TRADED') {
        return {
          price:    order.tradedPrice ?? order.price ?? 0,
          quantity: order.filledQty   ?? order.quantity ?? 0,
        };
      }

      // CANCELLED / REJECTED / EXPIRED
      throw new Error(`Order ${dhanOrderId} ended with status=${status}: ${order?.remarks || ''}`);
    }

    throw new Error(`Order ${dhanOrderId} did not fill within ${POLL_TIMEOUT_MS / 1000}s`);
  }

  /**
   * Cancels already-placed Dhan orders as part of a rollback.
   * Best-effort — logs failures but does not throw.
   * @private
   */
  async _rollback(placedDhanIds) {
    for (const { dhanOrderId, leg } of placedDhanIds) {
      try {
        await this._http.delete(`/orders/${dhanOrderId}`);
        log('INFO', `Rollback cancelled: ${leg.action} ${leg.type} ${leg.strike} dhanOrderId=${dhanOrderId}`);
      } catch (err) {
        // If already filled the cancel will fail — log and move on.
        log('WARN', `Rollback cancel failed for ${dhanOrderId}: ${err.message} — manual check required`);
      }
    }
  }
}

module.exports = new DhanExecutor();
