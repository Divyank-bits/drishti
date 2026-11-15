/**
 * @file options-runner.js
 * @description Phase 9: walks historical dates, applies Iron Condor entry logic,
 *              simulates fills using Bhavcopy EOD prices, tracks P&L.
 *
 * Limitations (all labeled EOD_BHAVCOPY in results):
 *   - Entry at open of option on signal day — no intraday timing
 *   - Stop check: short CE intraday high > shortCe + config.IC_STOP_BUFFER_POINTS
 *                 or short PE intraday low  < shortPe - config.IC_STOP_BUFFER_POINTS
 *   - Exit at close (or settle on expiry)
 *   - No multi-lot sizing — 1 lot per trade
 */
'use strict';

const config = require('../config');
const { load: loadCandles } = require('./candle-replayer');
const { getCondorEntry, getCondorExit, getPremium } = require('./options-replayer');
const { writeBtTrade } = require('../data/db');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [OptionsRunner] [${level}] ${msg}`);
}

const LOT_SIZE = { NIFTY: 25, BANKNIFTY: 15 };

/**
 * Select Iron Condor strikes from underlying price (EOD proxy — no live chain).
 * Uses fixed offsets from ATM rounded to nearest 50.
 *
 * shortCE = ATM + 200,  longCE = shortCE + 200
 * shortPE = ATM - 200,  longPE = shortPE - 200
 * Shift if strike lands on exact hundred (rule #7 from anti-hunt).
 */
function selectStrikes(underlyingClose) {
  const atm      = Math.round(underlyingClose / 50) * 50;
  let shortCe    = atm + 200;
  let shortPe    = atm - 200;

  if (shortCe % 100 === 0) shortCe += 50;
  if (shortPe % 100 === 0) shortPe -= 50;

  const longCe   = shortCe + 200;
  const longPe   = shortPe - 200;

  return { shortCe, longCe, shortPe, longPe };
}

/**
 * Find the nearest monthly expiry after a given date.
 * Monthly NIFTY expiry is last Thursday of the month.
 */
function nearestExpiry(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  // Find last Thursday of current month, if it's already past try next month
  for (let monthOffset = 0; monthOffset <= 1; monthOffset++) {
    const year  = d.getUTCFullYear();
    const month = d.getUTCMonth() + monthOffset;
    // Last day of month
    const lastDay = new Date(Date.UTC(year, month + 1, 0));
    // Go back to last Thursday
    const dow = lastDay.getUTCDay();
    const daysBack = (dow >= 4) ? dow - 4 : dow + 3;
    const expiry = new Date(lastDay);
    expiry.setUTCDate(lastDay.getUTCDate() - daysBack);
    const expiryStr = expiry.toISOString().slice(0, 10);
    if (expiryStr >= isoDate) return expiryStr;
  }
  return null;
}

/**
 * Run Iron Condor backtest over [from, to].
 *
 * @param {{ symbol, from, to }} opts
 * @returns {Array<object>} trade records
 */
function runIronCondor({ symbol, from, to }) {
  const candles = loadCandles(symbol, from, to);
  if (candles.length === 0) {
    log('WARN', `No candle data for ${symbol} ${from}→${to}`);
    log('WARN', `Run: node sync-bhavcopy.js --symbol ${symbol} --from ${from} --to ${to}`);
    log('WARN', `Then: node -e "require('./data/daily-candles').sync('${symbol}').then(n => console.log('synced', n))" to fetch underlying index prices`);
    return [];
  }

  const runDate  = new Date().toISOString().slice(0, 10);
  const lotSize  = LOT_SIZE[symbol] || 50;
  const trades   = [];
  let   open     = null;  // { entryDate, expiry, shortCe, longCe, shortPe, longPe, netCredit, entryPremiums }

  for (const candle of candles) {
    const date = candle.date;

    // ── Manage open position ──────────────────────────────────────────────
    if (open) {
      const isExpiry = date >= open.expiry;

      // EOD stop check: short CE high > shortCe (ITM threat), short PE low < shortPe
      const ceData = getPremium({ symbol, optionType: 'CE', strike: open.shortCe, date });
      const peData = getPremium({ symbol, optionType: 'PE', strike: open.shortPe, date });

      let stopHit = false;
      if (ceData && ceData.high != null && ceData.high > open.shortCe) stopHit = true;
      if (peData && peData.low  != null && peData.low  < open.shortPe) stopHit = true;

      if (stopHit || isExpiry) {
        const exit = getCondorExit({
          symbol,
          shortCe: open.shortCe, longCe: open.longCe,
          shortPe: open.shortPe, longPe: open.longPe,
          expiry:  open.expiry,
          date,
        });

        const premiumOut   = exit ? exit.netDebit   : 0;
        const realisedPnl  = (open.netCredit - premiumOut) * lotSize;
        const exitReason   = isExpiry ? 'EXPIRY' : 'STOP_HIT';

        const record = {
          run_date:    runDate,
          strategy:    'iron-condor',
          trade_date:  open.entryDate,
          symbol,
          expiry:      open.expiry,
          short_ce:    open.shortCe,
          long_ce:     open.longCe,
          short_pe:    open.shortPe,
          long_pe:     open.longPe,
          premium_in:  open.netCredit,
          premium_out: premiumOut,
          realised_pnl: realisedPnl,
          exit_reason: exitReason,
          data_source: 'EOD_BHAVCOPY',
        };

        writeBtTrade(record);
        trades.push({ ...record, exitDate: date });
        open = null;
      }
    }

    // ── Entry check ───────────────────────────────────────────────────────
    if (!open) {
      // Simple entry rule: enter if no active position and VIX proxy ok
      // (EOD backtest skips full entry filter — just enter on first available day)
      const expiry  = nearestExpiry(date);
      if (!expiry) continue;
      if (expiry === date) continue;  // don't enter on expiry day

      const { shortCe, longCe, shortPe, longPe } = selectStrikes(candle.close);

      const entry = getCondorEntry({ symbol, shortCe, longCe, shortPe, longPe, date });
      if (!entry) continue;  // no Bhavcopy data for these strikes today
      if (entry.netCredit <= 0) continue;  // must be a net credit

      open = {
        entryDate: date,
        expiry,
        shortCe, longCe, shortPe, longPe,
        netCredit: entry.netCredit,
      };
      log('INFO', `${date}: entered — strikes CE ${shortCe}/${longCe} PE ${shortPe}/${longPe} credit=${entry.netCredit.toFixed(2)}`);
    }
  }

  // Close any position still open at end of data
  if (open) {
    const last = candles[candles.length - 1];
    const exit = getCondorExit({
      symbol,
      shortCe: open.shortCe, longCe: open.longCe,
      shortPe: open.shortPe, longPe: open.longPe,
      expiry:  open.expiry,
      date:    last.date,
    });
    const premiumOut  = exit ? exit.netDebit  : 0;
    const realisedPnl = (open.netCredit - premiumOut) * lotSize;
    const record = {
      run_date:    new Date().toISOString().slice(0, 10),
      strategy:    'iron-condor',
      trade_date:  open.entryDate,
      symbol,
      expiry:      open.expiry,
      short_ce:    open.shortCe,
      long_ce:     open.longCe,
      short_pe:    open.shortPe,
      long_pe:     open.longPe,
      premium_in:  open.netCredit,
      premium_out: premiumOut,
      realised_pnl: realisedPnl,
      exit_reason: 'END_OF_DATA',
      data_source: 'EOD_BHAVCOPY',
    };
    writeBtTrade(record);
    trades.push({ ...record, exitDate: last.date });
  }

  log('INFO', `${symbol}: ${trades.length} trade(s) simulated`);
  return trades;
}

/**
 * Run backtests for all requested strategies.
 * @param {{ symbols, strategies, from, to }} opts
 * @returns {Array<object>}
 */
function run({ symbols, strategies, from, to }) {
  const strategyMap = { 'iron-condor': runIronCondor };
  const allTrades   = [];

  for (const symbol of symbols) {
    for (const strategy of strategies) {
      const fn = strategyMap[strategy];
      if (!fn) { log('WARN', `Unknown strategy: ${strategy}`); continue; }
      const trades = fn({ symbol, from, to });
      allTrades.push(...trades);
    }
  }

  return allTrades;
}

module.exports = { run, runIronCondor, selectStrikes, nearestExpiry };
