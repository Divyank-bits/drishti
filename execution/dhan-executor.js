/**
 * @file dhan-executor.js
 * @description Live order executor using Dhan REST API v2.
 *              Implements the same interface as PaperExecutor.
 *              Active when EXECUTION_MODE=LIVE. Uses Dhan basket order API
 *              to place all legs atomically in a single request. Falls back
 *              to sequential _placeOneLeg() if basket API is unavailable.
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

// Basket order endpoint (Dhan v2) — places all legs atomically
const BASKET_ORDER_PATH = '/orders/basket';

// Non-terminal order states used in reconciliation
const OPEN_STATES = new Set(['PENDING', 'TRANSIT', 'PARTIALLY_TRADED']);

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
   * Places all legs as live MARKET orders on Dhan using the basket order API.
   * Falls back to sequential placement if basket API returns 404/not-supported.
   *
   * @param {Array<{strike, type, action}>} legs
   * @returns {Promise<object>} fill object (mirrors PaperExecutor shape)
   */
  async placeOrder(legs) {
    const EVENTS   = getEvents();
    const eventBus = getEventBus();

    eventBus.emit(EVENTS.ORDER_PLACING, { legs });
    log('INFO', `Placing order — ${legs.length} legs (basket mode)`);

    let filledLegs;
    try {
      filledLegs = await this._placeBasket(legs);
    } catch (err) {
      if (err._basketUnsupported) {
        log('WARN', `Basket API unavailable — falling back to sequential placement`);
        filledLegs = await this._placeSequential(legs);
      } else {
        log('ERROR', `Basket placement failed: ${err.message}`);
        eventBus.emit(EVENTS.ORDER_FAILED, { reason: err.message });
        throw err;
      }
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
    log('INFO', `Order placed — premium collected ₹${premiumCollected}`);
    eventBus.emit(EVENTS.ORDER_FILLED, fill);
    return fill;
  }

  /**
   * Exits all legs of an active position by placing reverse MARKET orders as a basket.
   * Falls back to sequential exit if basket API is unavailable.
   *
   * @param {string} orderId internal fill ID returned by placeOrder
   * @returns {Promise<object>} exit result with realisedPnl
   */
  async exitOrder(orderId) {
    const entryFill = this._activeOrders[orderId];
    if (!entryFill) throw new Error(`[DhanExecutor] Unknown orderId: ${orderId}`);

    log('INFO', `Exiting position orderId=${orderId} — ${entryFill.legs.length} legs (basket mode)`);

    // Build exit legs (reverse action, reuse securityId from entry fill)
    const exitLegDefs = entryFill.legs.map(leg => ({
      ...leg,
      action:     leg.action === 'SELL' ? 'BUY' : 'SELL',
      _entryLeg:  leg,   // stash original for result assembly
    }));

    let filledExitLegs;
    try {
      filledExitLegs = await this._placeBasket(exitLegDefs);
    } catch (err) {
      if (err._basketUnsupported) {
        log('WARN', `Basket exit unavailable — falling back to sequential exit`);
        filledExitLegs = await this._placeSequential(exitLegDefs);
      } else {
        log('ERROR', `Basket exit failed: ${err.message}`);
        throw err;
      }
    }

    // Reassemble exit result with original leg metadata
    const exitLegs = filledExitLegs.map((filled, i) => ({
      ...entryFill.legs[i],
      exitAction:      filled.action,
      exitFillPrice:   filled.fillPrice,
      exitDhanOrderId: filled.dhanOrderId,
    }));

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
    log('INFO', `Position exited — realised P&L ₹${realisedPnl}`);
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
   * Places all legs as a single atomic basket order via POST /orders/basket.
   * Each order in the basket is a MARKET order. Polls all order IDs in parallel
   * after placement. Throws with _basketUnsupported=true if Dhan returns 404/422.
   * @private
   */
  async _placeBasket(legs) {
    const qty = (config.DEFAULT_LOTS || 1) * config.NIFTY_LOT_SIZE;

    const orders = legs.map(leg => ({
      dhanClientId:      config.DHAN_CLIENT_ID,
      transactionType:   leg.action,
      exchangeSegment:   EXCHANGE_SEGMENT,
      productType:       PRODUCT_TYPE,
      orderType:         ORDER_TYPE,
      validity:          ORDER_VALIDITY,
      securityId:        leg.securityId || this._resolveSecurityId(leg),
      quantity:          leg.fillQty || qty,
      disclosedQuantity: 0,
      price:             0,
      triggerPrice:      0,
      afterMarketOrder:  false,
    }));

    let res;
    try {
      res = await this._http.post(BASKET_ORDER_PATH, { orders });
    } catch (err) {
      const status = err.response?.status;
      if (status === 404 || status === 422) {
        const unsupported = new Error(`Basket API not supported (HTTP ${status})`);
        unsupported._basketUnsupported = true;
        throw unsupported;
      }
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`_placeBasket POST failed: ${detail}`);
    }

    // Dhan basket response: array of { orderId, orderStatus, ... } in same order as input
    const basketResults = res.data?.orders ?? res.data;
    if (!Array.isArray(basketResults) || basketResults.length !== legs.length) {
      throw new Error(`_placeBasket unexpected response shape: ${JSON.stringify(res.data)}`);
    }

    // Check for any immediate rejections before polling
    for (let i = 0; i < basketResults.length; i++) {
      const r = basketResults[i];
      if (r.orderStatus === 'REJECTED' || r.orderStatus === 'CANCELLED') {
        throw new Error(`Basket leg ${i} (${legs[i].action} ${legs[i].type} ${legs[i].strike}) rejected: ${r.remarks || r.orderStatus}`);
      }
    }

    log('INFO', `Basket placed — ${basketResults.length} legs, polling for fills`);

    // Poll all legs in parallel
    const fills = await Promise.all(
      basketResults.map(async (r, i) => {
        const dhanOrderId = String(r.orderId);
        const fillDetails = await this._pollUntilFilled(dhanOrderId);
        const leg = legs[i];
        const securityId = leg.securityId || this._resolveSecurityId(leg);
        log('INFO', `Basket leg filled: ${leg.action} ${leg.type} ${leg.strike} @ ₹${fillDetails.price}`);
        return {
          ...leg,
          securityId,
          dhanOrderId,
          fillPrice: fillDetails.price,
          fillQty:   fillDetails.quantity,
        };
      })
    );

    return fills;
  }

  /**
   * Places legs sequentially — fallback when basket API is unavailable.
   * Rolls back on failure. Use _placeBasket() instead wherever possible.
   * @private
   */
  async _placeSequential(legs) {
    const qty = (config.DEFAULT_LOTS || 1) * config.NIFTY_LOT_SIZE;
    const placedDhanIds = [];
    const filledLegs    = [];

    try {
      for (const leg of legs) {
        const securityId  = leg.securityId || this._resolveSecurityId(leg);
        const legQty      = leg.fillQty || qty;

        const dhanOrderId = await this._placeOneLeg(leg, securityId, legQty);
        placedDhanIds.push({ dhanOrderId, leg });

        const fillDetails = await this._pollUntilFilled(dhanOrderId);
        filledLegs.push({
          ...leg,
          securityId,
          dhanOrderId,
          fillPrice: fillDetails.price,
          fillQty:   fillDetails.quantity,
        });

        log('INFO', `Sequential leg filled: ${leg.action} ${leg.type} ${leg.strike} @ ₹${fillDetails.price}`);
      }
    } catch (err) {
      log('ERROR', `Sequential leg failed: ${err.message} — rolling back ${placedDhanIds.length} placed legs`);
      await this._rollback(placedDhanIds);
      const EVENTS = getEvents();
      getEventBus().emit(EVENTS.ORDER_FAILED, { reason: err.message });
      getEventBus().emit(EVENTS.PARTIAL_FILL_ROLLBACK, { placedDhanIds });
      throw err;
    }

    return filledLegs;
  }

  /**
   * Fetches all open NSE_FNO orders from Dhan for today.
   * Used by boot reconciliation (Block 3).
   * @returns {Promise<Array>} orders in non-terminal states
   */
  async fetchOpenOrders() {
    try {
      const res = await this._http.get('/orders');
      const all = res.data ?? [];
      return all.filter(o =>
        o.exchangeSegment === EXCHANGE_SEGMENT &&
        !TERMINAL_STATES.has(o.orderStatus) ||
        o.orderStatus === 'TRADED'   // include filled-today for reconciliation completeness
      );
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`fetchOpenOrders failed: ${detail}`);
    }
  }

  /**
   * Compares open Dhan orders against the last known journal position state.
   * Returns a reconciliation report — does NOT take action itself.
   *
   * @param {{ openOrderIds: string[] }} journalState
   * @returns {Promise<{ clean: boolean, orphanedOrders: Array, missingOrders: string[] }>}
   */
  async reconcile(journalState) {
    const dhanOrders   = await this.fetchOpenOrders();
    const journalIds   = new Set(journalState.openOrderIds || []);
    const dhanIds      = new Set(dhanOrders.map(o => String(o.orderId)));

    // Dhan has orders not in journal → orphaned (crash mid-fill)
    const orphanedOrders = dhanOrders.filter(o => !journalIds.has(String(o.orderId)));

    // Journal references orders Dhan doesn't know about → stale journal entries
    const missingOrders = [...journalIds].filter(id => !dhanIds.has(id));

    const clean = orphanedOrders.length === 0 && missingOrders.length === 0;

    if (!clean) {
      log('WARN', `Reconciliation mismatch — orphaned: ${orphanedOrders.length}, missing: ${missingOrders.length}`);
    } else {
      log('INFO', 'Reconciliation clean — no orphaned or missing orders');
    }

    return { clean, orphanedOrders, missingOrders };
  }

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
