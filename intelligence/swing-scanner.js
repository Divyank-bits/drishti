/**
 * @file swing-scanner.js
 * @description Phase 8: runs all swing setups against latest daily candles for SWING_UNIVERSE.
 *              Returns TRIGGERED signals sorted by risk/reward descending.
 */
'use strict';

const config    = require('../config');
const eventBus  = require('../core/event-bus');
const EVENTS    = require('../core/events');
const { readDailyCandles } = require('../data/db');
const { buildFeatures }    = require('../analysis/features');
const { getAll: getAllSetups } = require('../strategies/swing/registry');
const { computeSize }      = require('../core/risk');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [SwingScanner] [${level}] ${msg}`);
}

/**
 * Run all swing setups on the most recent bar of each symbol.
 *
 * @param {string[]} [symbols]  - defaults to config.SWING_UNIVERSE
 * @param {string[]} [setupIds] - defaults to all registered setups
 * @returns {{ signals: Array, asOf: string, scannedAt: string }}
 */
function scan(symbols, setupIds) {
  const symList  = symbols  || config.SWING_UNIVERSE;
  const setups   = getAllSetups().filter(s =>
    !setupIds || setupIds.length === 0 || setupIds.includes(s.id)
  );

  const today   = new Date().toISOString().slice(0, 10);
  const fromDate = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - config.SWING_HISTORY_YEARS);
    return d.toISOString().slice(0, 10);
  })();

  eventBus.emit(EVENTS.SWING_SCAN_STARTED, { symbols: symList, setups: setups.map(s => s.id) });

  const signals = [];

  for (const symbol of symList) {
    const daily = readDailyCandles(symbol, fromDate, today);
    if (daily.length < 30) {
      log('WARN', `${symbol}: insufficient data (${daily.length} bars) — skipping`);
      continue;
    }

    const features = buildFeatures(daily);
    const i        = daily.length - 1;

    for (const setup of setups) {
      for (const direction of ['LONG', 'SHORT']) {
        try {
          const result = setup.evaluate({ daily, features, i, direction });
          if (result.state !== 'TRIGGERED') continue;

          const size   = computeSize(daily[i].close, result.stopLoss, direction);
          const signal = {
            symbol,
            setupId:    setup.id,
            setupName:  setup.name,
            direction,
            subtype:    result.subtype || null,
            entry:      daily[i].close,
            stopLoss:   result.stopLoss,
            target:     result.target,
            riskReward: result.riskReward,
            asOf:       daily[i].date,
            size,
          };

          signals.push(signal);
          eventBus.emit(EVENTS.SWING_SIGNAL_TRIGGERED, signal);
        } catch (err) {
          log('WARN', `${symbol}/${setup.id}/${direction}: ${err.message}`);
        }
      }
    }
  }

  signals.sort((a, b) => (b.riskReward || 0) - (a.riskReward || 0));

  log('INFO', `Scan complete — ${signals.length} signal(s) across ${symList.length} symbol(s)`);
  eventBus.emit(EVENTS.SWING_SCAN_COMPLETED, { signals, count: signals.length, symbols: symList.length });

  return { signals, asOf: today, scannedAt: new Date().toISOString() };
}

module.exports = { scan };
