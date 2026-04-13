/**
 * @file tick-stream.js
 * @description Factory: loads the correct market data source based on DATA_SOURCE config.
 *              DATA_SOURCE='NSE'  → data/sources/nse-source.js  (Phase 1, polling)
 *              DATA_SOURCE='DHAN' → data/sources/dhan-source.js (Phase 3, WebSocket)
 *              All sources emit identical TICK_RECEIVED events — nothing downstream
 *              knows or cares which source is active.
 */

'use strict';

const config = require('../config');

if (config.DATA_SOURCE === 'DHAN') {
  module.exports = require('./sources/dhan-source');
} else {
  module.exports = require('./sources/nse-source');
}
