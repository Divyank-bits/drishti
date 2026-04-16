/**
 * @file dhan-source.js
 * @description Dhan WebSocket live tick feed for NIFTY 50.
 *              Connects to Dhan's binary feed API (authType=2, version=2).
 *              Parses binary packets and emits TICK_RECEIVED events identical
 *              in shape to nse-source.js — nothing downstream knows the difference.
 *              Handles reconnection; trips WEBSOCKET_RECONNECT_FAILED after
 *              WEBSOCKET_RECONNECT_TIMEOUT seconds without a successful packet.
 */

'use strict';

const WebSocket = require('ws');
const eventBus  = require('../../core/event-bus');
const EVENTS    = require('../../core/events');
const config    = require('../../config');

// ── Dhan binary feed packet response codes ────────────────────────────────
const PACKET = {
  TICKER:       2,   // LTP packet
  PREV_CLOSE:   6,   // Previous close
  DISCONNECT:   50,  // Server-initiated disconnect with reason code
};

// ── Reconnect strategy ────────────────────────────────────────────────────
const RECONNECT_DELAY_MS  = 5000;   // wait 5s before each reconnect attempt
const MAX_RECONNECT_TRIES = 5;      // after 5 fails, emit WEBSOCKET_RECONNECT_FAILED

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [DhanSource] [${level}] ${msg}`);
}

class DhanSource {
  constructor() {
    this._ws               = null;
    this._reconnectTries   = 0;
    this._reconnectTimer   = null;
    this._deadlineTimer    = null;  // circuit-breaker timer: WEBSOCKET_RECONNECT_TIMEOUT
    this._connectedEmitted = false;
    this._stopped          = false;
    this._lastLtp          = null;
  }

  start() {
    if (!config.DHAN_CLIENT_ID || !config.DHAN_ACCESS_TOKEN) {
      throw new Error('[DhanSource] DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN must be set in .env');
    }
    this._stopped = false;
    this._connect();
  }

  stop() {
    this._stopped = true;
    this._clearTimers();
    if (this._ws) {
      this._ws.removeAllListeners();
      this._ws.terminate();
      this._ws = null;
    }
    log('INFO', 'Dhan feed stopped');
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _connect() {
    const url = `${config.DHAN_WS_URL}?version=2&token=${config.DHAN_ACCESS_TOKEN}&clientId=${config.DHAN_CLIENT_ID}&authType=2`;
    log('INFO', `Connecting to Dhan feed (attempt ${this._reconnectTries + 1})...`);

    this._ws = new WebSocket(url);

    this._ws.on('open',    () => this._onOpen());
    this._ws.on('message', (data) => this._onMessage(data));
    this._ws.on('ping',    () => this._ws.pong());
    this._ws.on('error',   (err) => this._onError(err));
    this._ws.on('close',   (code, reason) => this._onClose(code, reason));

    // Start the circuit-breaker deadline: if we don't get a tick within
    // WEBSOCKET_RECONNECT_TIMEOUT seconds, emit WEBSOCKET_RECONNECT_FAILED
    this._startDeadline();
  }

  _onOpen() {
    log('INFO', 'WebSocket open — subscribing to NIFTY 50');
    this._reconnectTries = 0;

    const subscribe = {
      RequestCode:     15,
      InstrumentCount: 1,
      InstrumentList: [
        {
          ExchangeSegment: config.DHAN_EXCHANGE_SEGMENT,
          SecurityId:      config.DHAN_SECURITY_ID,
        },
      ],
    };

    this._ws.send(JSON.stringify(subscribe));
  }

  _onMessage(data) {
    if (!Buffer.isBuffer(data)) return;

    const responseCode = data.readUInt8(0);

    switch (responseCode) {
      case PACKET.TICKER: {
        if (data.length < 16) return;
        const ltp = data.readFloatLE(8);
        const ltt = data.readInt32LE(12); // unix seconds

        if (!ltp || ltp <= 0) return;
        this._lastLtp = ltp;

        // First valid tick — clear deadline, emit connected
        this._clearDeadline();
        if (!this._connectedEmitted) {
          eventBus.emit(EVENTS.WEBSOCKET_CONNECTED, { timestamp: Date.now() });
          this._connectedEmitted = true;
          log('INFO', `First tick received — WEBSOCKET_CONNECTED emitted. NIFTY: ₹${ltp.toFixed(2)}`);
        }

        eventBus.emit(EVENTS.TICK_RECEIVED, {
          symbol:    'NIFTY',
          ltp:       parseFloat(ltp.toFixed(2)),
          volume:    0, // Index feed does not carry volume; candle-level volume from Dhan charts
          timestamp: ltt ? ltt * 1000 : Date.now(),
        });
        break;
      }

      case PACKET.PREV_CLOSE: {
        if (data.length < 12) return;
        const prevClose = data.readFloatLE(8);
        log('DEBUG', `Prev close received: ₹${prevClose.toFixed(2)}`);
        break;
      }

      case PACKET.DISCONNECT: {
        const reason = data.length >= 10 ? data.readInt16LE(8) : -1;
        log('WARN', `Server-initiated disconnect — reason code: ${reason}`);
        break;
      }

      default:
        // Unknown packet type — safe to ignore
        break;
    }
  }

  _onError(err) {
    log('ERROR', `WebSocket error: ${err.message}`);
  }

  _onClose(code, reason) {
    if (this._stopped) return;

    const reasonStr = reason ? reason.toString() : '';
    log('WARN', `WebSocket closed: ${code}${reasonStr ? ` | ${reasonStr}` : ''}`);
    eventBus.emit(EVENTS.WEBSOCKET_DISCONNECTED, { code, reason: reasonStr, timestamp: Date.now() });

    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._stopped) return;

    this._reconnectTries++;
    if (this._reconnectTries > MAX_RECONNECT_TRIES) {
      log('ERROR', `${MAX_RECONNECT_TRIES} reconnect attempts exhausted — emitting WEBSOCKET_RECONNECT_FAILED`);
      eventBus.emit(EVENTS.WEBSOCKET_RECONNECT_FAILED, {
        reason:    `Dhan WebSocket failed to reconnect after ${MAX_RECONNECT_TRIES} attempts`,
        timestamp: Date.now(),
      });
      return;
    }

    log('INFO', `Reconnecting in ${RECONNECT_DELAY_MS / 1000}s (attempt ${this._reconnectTries}/${MAX_RECONNECT_TRIES})...`);
    this._reconnectTimer = setTimeout(() => {
      if (!this._stopped) {
        eventBus.emit(EVENTS.WEBSOCKET_RECONNECTED, { attempt: this._reconnectTries, timestamp: Date.now() });
        this._connect();
      }
    }, RECONNECT_DELAY_MS);
  }

  // Circuit-breaker deadline: if no tick arrives within WEBSOCKET_RECONNECT_TIMEOUT
  // seconds while a position may be open, the circuit breaker in index.js handles it.
  _startDeadline() {
    this._clearDeadline();
    const timeoutMs = config.WEBSOCKET_RECONNECT_TIMEOUT * 1000;
    this._deadlineTimer = setTimeout(() => {
      if (!this._connectedEmitted) {
        log('WARN', `No tick received within ${config.WEBSOCKET_RECONNECT_TIMEOUT}s — emitting WEBSOCKET_RECONNECT_FAILED`);
        eventBus.emit(EVENTS.WEBSOCKET_RECONNECT_FAILED, {
          reason:    `No tick from Dhan feed within ${config.WEBSOCKET_RECONNECT_TIMEOUT}s of connect`,
          timestamp: Date.now(),
        });
      }
    }, timeoutMs);
  }

  _clearDeadline() {
    if (this._deadlineTimer) {
      clearTimeout(this._deadlineTimer);
      this._deadlineTimer = null;
    }
  }

  _clearTimers() {
    this._clearDeadline();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }
}

module.exports = new DhanSource();
