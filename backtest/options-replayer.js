/**
 * @file options-replayer.js
 * @description Phase 9: for a given trade date + set of strikes, fetches the matching
 *              Bhavcopy rows from SQLite. Used by options-runner to get options prices
 *              for entry and exit simulation.
 *
 * Data model (EOD only):
 *   - Entry premium = open price of option on trade date
 *   - Exit premium  = close price of option on exit date
 *   - Stop check    = if intraday high (CE sold) or low (PE sold) exceeds buffer
 */
'use strict';

const { getOptionPrice, getOptionSeries } = require('../data/db');

/**
 * Get the premium for one option on a specific date.
 * Returns null if no Bhavcopy data exists for that date/strike.
 *
 * @param {{ symbol, optionType, strike, date }} opts
 * @returns {{ open, high, low, close, settle, expiry } | null}
 */
function getPremium({ symbol, optionType, strike, date }) {
  const row = getOptionPrice(symbol, optionType, strike, date, date);
  if (!row) return null;
  return {
    open:   row.open,
    high:   row.high,
    low:    row.low,
    close:  row.close,
    settle: row.settle,
    expiry: row.expiry,
  };
}

/**
 * Get the full price series for one option leg over [from, to].
 * Useful for tracking daily P&L of an open position.
 *
 * @param {{ symbol, optionType, strike, expiry, from, to }} opts
 * @returns {Array<{ date, open, high, low, close, settle }>}
 */
function getLegSeries({ symbol, optionType, strike, expiry, from, to }) {
  return getOptionSeries(symbol, optionType, strike, expiry, from, to);
}

/**
 * Compute the premium received for an Iron Condor entry.
 * Returns null for any leg that has no price data.
 *
 * @param {{ symbol, shortCe, longCe, shortPe, longPe, date }} legs
 * @returns {{ shortCePremium, longCePremium, shortPePremium, longPePremium, netCredit, expiry } | null}
 */
function getCondorEntry({ symbol, shortCe, longCe, shortPe, longPe, date }) {
  const sce = getPremium({ symbol, optionType: 'CE', strike: shortCe, date });
  const lce = getPremium({ symbol, optionType: 'CE', strike: longCe,  date });
  const spe = getPremium({ symbol, optionType: 'PE', strike: shortPe, date });
  const lpe = getPremium({ symbol, optionType: 'PE', strike: longPe,  date });

  if (!sce || !lce || !spe || !lpe) return null;

  // Use open price as entry premium (EOD proxy for opening fill)
  const shortCePremium = sce.open;
  const longCePremium  = lce.open;
  const shortPePremium = spe.open;
  const longPePremium  = lpe.open;

  if (!shortCePremium || !longCePremium || !shortPePremium || !longPePremium) return null;

  const netCredit = (shortCePremium - longCePremium) + (shortPePremium - longPePremium);

  return {
    shortCePremium,
    longCePremium,
    shortPePremium,
    longPePremium,
    netCredit,
    expiry: sce.expiry,
  };
}

/**
 * Compute exit premium for an open condor position.
 * exitType: 'EOD' | 'EXPIRY'
 *
 * @param {{ symbol, shortCe, longCe, shortPe, longPe, expiry, date }} legs
 * @returns {{ shortCePremium, longCePremium, shortPePremium, longPePremium, netDebit } | null}
 */
function getCondorExit({ symbol, shortCe, longCe, shortPe, longPe, expiry, date }) {
  const field = 'close';

  const sce = getPremium({ symbol, optionType: 'CE', strike: shortCe, date });
  const lce = getPremium({ symbol, optionType: 'CE', strike: longCe,  date });
  const spe = getPremium({ symbol, optionType: 'PE', strike: shortPe, date });
  const lpe = getPremium({ symbol, optionType: 'PE', strike: longPe,  date });

  if (!sce || !lce || !spe || !lpe) return null;

  const shortCePremium = sce[field] ?? sce.settle ?? 0;
  const longCePremium  = lce[field] ?? lce.settle ?? 0;
  const shortPePremium = spe[field] ?? spe.settle ?? 0;
  const longPePremium  = lpe[field] ?? lpe.settle ?? 0;

  const netDebit = (shortCePremium - longCePremium) + (shortPePremium - longPePremium);

  return { shortCePremium, longCePremium, shortPePremium, longPePremium, netDebit };
}

module.exports = { getPremium, getLegSeries, getCondorEntry, getCondorExit };
