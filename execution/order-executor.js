/**
 * @file order-executor.js
 * @description Abstract base class for order executors. PaperExecutor and future
 *              DhanExecutor both implement this interface. All trading logic above
 *              this layer is identical regardless of which executor is active.
 */
'use strict';

class OrderExecutor {
  async placeOrder(legs) {
    throw new Error(`[${this.constructor.name}] placeOrder() must be implemented`);
  }
  async exitOrder(orderId) {
    throw new Error(`[${this.constructor.name}] exitOrder() must be implemented`);
  }
  computeUnrealisedPnl(fill) {
    throw new Error(`[${this.constructor.name}] computeUnrealisedPnl() must be implemented`);
  }
}

module.exports = OrderExecutor;
