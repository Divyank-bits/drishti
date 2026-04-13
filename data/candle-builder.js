/**
 * @file candle-builder.js
 * @description Builds 1m/5m/15m OHLCV candles from raw TICK_RECEIVED events.
 *              Emits CANDLE_CLOSE_1M, CANDLE_CLOSE_5M, CANDLE_CLOSE_15M on close.
 *              Maintains a rolling buffer of CANDLE_HISTORY_SIZE candles per timeframe.
 */

'use strict';

const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const config   = require('../config');

const TIMEFRAMES   = config.CANDLE_TIMEFRAMES;   // [1, 5, 15]
const HISTORY_SIZE = config.CANDLE_HISTORY_SIZE; // 200

const CLOSE_EVENTS = {
  1:  EVENTS.CANDLE_CLOSE_1M,
  5:  EVENTS.CANDLE_CLOSE_5M,
  15: EVENTS.CANDLE_CLOSE_15M,
};

class CandleBuilder {
  constructor() {
    this._state = {};
    for (const tf of TIMEFRAMES) {
      this._state[tf] = { current: null, buffer: [] };
    }
    this._hookEvents();
  }

  _hookEvents() {
    eventBus.on(EVENTS.TICK_RECEIVED, (tick) => this._onTick(tick));
  }

  // Exposed for tests — allows injecting synthetic ticks without eventBus
  _onTick({ ltp, volume, timestamp }) {
    for (const tf of TIMEFRAMES) {
      this._processTick(tf, ltp, volume, timestamp);
    }
  }

  _processTick(tf, ltp, volume, timestamp) {
    const state    = this._state[tf];
    const boundary = this._getBoundary(tf, timestamp);

    if (!state.current) {
      state.current = { open: ltp, high: ltp, low: ltp, close: ltp, volume, openTime: boundary };
      return;
    }

    if (boundary > state.current.openTime) {
      this._closeCandle(tf, state.current);
      state.current = { open: ltp, high: ltp, low: ltp, close: ltp, volume, openTime: boundary };
    } else {
      if (ltp > state.current.high) state.current.high = ltp;
      if (ltp < state.current.low)  state.current.low  = ltp;
      state.current.close   = ltp;
      state.current.volume += volume;
    }
  }

  // Epoch-based boundary: timezone-independent, aligns IST market hours correctly
  // because IST = UTC+5:30 and 330 is divisible by both 5 and 15.
  _getBoundary(tf, timestamp) {
    const tfMs = tf * 60 * 1000;
    return Math.floor(timestamp / tfMs) * tfMs;
  }

  _closeCandle(tf, candle) {
    const state = this._state[tf];
    state.buffer.push({ ...candle });
    if (state.buffer.length > HISTORY_SIZE) state.buffer.shift();
    eventBus.emit(CLOSE_EVENTS[tf], { ...candle });
  }

  // Called by historical.js at boot to seed indicator history
  seedBuffer(timeframe, candles) {
    this._state[timeframe].buffer = candles.slice(-HISTORY_SIZE);
  }

  // Called by indicator-engine.js — intra-domain read, not a cross-domain call
  getBuffer(timeframe) {
    return [...this._state[timeframe].buffer];
  }
}

module.exports = new CandleBuilder();
