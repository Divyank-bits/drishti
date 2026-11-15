/**
 * @file risk.js
 * @description Phase 8: position-sizing for swing trades. Pure function — no I/O.
 */
'use strict';

const config = require('../config');

/**
 * Compute position size given entry/stop and account risk parameters.
 * @param {number} entry     - proposed entry price (close of signal bar)
 * @param {number} stopLoss  - stop-loss level from setup
 * @param {string} direction - 'LONG' | 'SHORT'
 * @returns {{ shares, capitalRequired, riskRupees, oneR }}
 */
function computeSize(entry, stopLoss, direction) {
  const riskRupees = config.SWING_ACCOUNT_SIZE * (config.SWING_RISK_PCT_PER_TRADE / 100);
  const oneR       = Math.abs(entry - stopLoss);

  if (oneR === 0) return { shares: 0, capitalRequired: 0, riskRupees, oneR: 0 };

  const shares          = Math.floor(riskRupees / oneR);
  const capitalRequired = shares * entry;

  return { shares, capitalRequired, riskRupees, oneR };
}

module.exports = { computeSize };
