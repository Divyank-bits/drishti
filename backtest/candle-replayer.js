/**
 * @file candle-replayer.js
 * @description Phase 9: streams historical daily candles as CANDLE_CLOSE_15 events,
 *              one trading day at a time, for use by the options backtester.
 *              Each emitted candle represents end-of-day state.
 */
'use strict';

const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const { readDailyCandles } = require('../data/db');

/**
 * Replay daily candles for a symbol over [from, to].
 * Emits CANDLE_CLOSE_15 for each day (EOD proxy).
 *
 * @param {string} symbol
 * @param {string} from   - YYYY-MM-DD
 * @param {string} to     - YYYY-MM-DD
 * @param {Function} onDay - callback(candle, index, total) called synchronously for each day
 */
function replay(symbol, from, to, onDay) {
  const candles = readDailyCandles(symbol, from, to);
  if (candles.length === 0) return;

  for (let i = 0; i < candles.length; i++) {
    const candle = {
      symbol,
      timeframe: 15,
      open:   candles[i].open,
      high:   candles[i].high,
      low:    candles[i].low,
      close:  candles[i].close,
      volume: candles[i].volume,
      date:   candles[i].date,
    };

    eventBus.emit(EVENTS.CANDLE_CLOSE_15, candle);

    if (onDay) onDay(candle, i, candles.length);
  }
}

/**
 * Returns all daily candles for a symbol in [from, to] without emitting events.
 * Useful when the caller wants to iterate without side effects.
 */
function load(symbol, from, to) {
  return readDailyCandles(symbol, from, to);
}

module.exports = { replay, load };
