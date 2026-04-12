/**
 * @file event-bus.js
 * @description Central event bus for Drishti. Thin wrapper around Node.js EventEmitter.
 *              Every module communicates exclusively through this bus — never via direct
 *              cross-module function calls. Exported as a singleton.
 *
 *              In development mode (NODE_ENV=development), every emitted event is logged
 *              with a timestamp for easy tracing.
 */

const EventEmitter = require('events');
const config = require('../config');

class DrishtiEventBus extends EventEmitter {
  constructor() {
    super();
    // Raise the listener limit — many modules subscribe to the same events
    this.setMaxListeners(50);

    if (config.IS_DEV) {
      this._attachDebugLogger();
    }
  }

  /**
   * Attaches a debug logger that prints every emitted event to stdout.
   * Uses EventEmitter.prototype.emit directly to avoid infinite recursion.
   * @private
   */
  _attachDebugLogger() {
    // Capture the original prototype method before overriding on the instance
    const originalEmit = EventEmitter.prototype.emit;
    const SKIP_EVENTS = new Set(['newListener', 'removeListener']);

    // Override only on this instance, not on the prototype
    this.emit = function debugEmit(event, ...args) {
      if (!SKIP_EVENTS.has(event)) {
        const ts = new Date().toTimeString().slice(0, 8);
        process.stdout.write(`[${ts}] [EventBus] [DEBUG] → ${event}\n`);
      }
      return originalEmit.apply(this, [event, ...args]);
    };
  }
}

// ── Export a single shared instance ────────────────────────────────────────
// All modules import this same object so events flow across the whole app.
const eventBus = new DrishtiEventBus();
module.exports = eventBus;
