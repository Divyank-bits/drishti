/**
 * @file options-chain.js
 * @description Fetches NSE NIFTY option chain using stock-nse-india.
 * Emits OPTIONS_CHAIN_UPDATED on success with PCR, Max OI, and ATM strike.
 */

'use strict';

const cron     = require('node-cron');
const { NseIndia } = require('stock-nse-india');
const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const config   = require('../config');

const nse = new NseIndia();

// Market hours in UTC (IST - 5:30)
const MARKET_OPEN_UTC_H  = 3;  // 09:15 IST
const MARKET_OPEN_UTC_M  = 45;
const MARKET_CLOSE_UTC_H = 10; // 15:30 IST
const MARKET_CLOSE_UTC_M = 0;

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [OptionsChain] [${level}] ${msg}`);
}

class OptionsChain {
  constructor() {
    this._lastGoodResult   = null;
    this._lastGoodAt       = null;
  }

  start() {
    // Run every 15 minutes as per config; cron syntax handles interval and weekdays
    cron.schedule(`*/${config.OPTIONS_CHAIN_INTERVAL} * * * 1-5`, () => this._tick());
    log('INFO', `Option chain polling scheduled every ${config.OPTIONS_CHAIN_INTERVAL}m`);
    
    // Trigger initial fetch on boot (after a short delay for session warm-up)
    setTimeout(() => this._tick(), 5000);
  }

  async _tick() {
    if (!this._isDuringMarketHours()) return;
    
    try {
      log('INFO', 'Fetching NIFTY option chain...');
      const raw = await nse.getOptionChain("NIFTY");
      const result = this._parseOptionChain(raw);
      
      this._lastGoodResult = result;
      this._lastGoodAt     = Date.now();
      
      eventBus.emit(EVENTS.OPTIONS_CHAIN_UPDATED, result);
      log('INFO', `Updated: NIFTY ATM:${result.atmStrike} PCR:${result.pcr} MaxCE:${result.maxCeOiStrike} MaxPE:${result.maxPeOiStrike}`);
    } catch (err) {
      log('ERROR', `Fetch failed: ${err.message}`);
      eventBus.emit(EVENTS.OPTIONS_CHAIN_STALE, {
        reason: err.message,
        lastGoodTimestamp: this._lastGoodAt,
      });
    }
  }

  _isDuringMarketHours() {
    const now = new Date();
    const h   = now.getUTCHours();
    const m   = now.getUTCMinutes();
    const after  = h > MARKET_OPEN_UTC_H  || (h === MARKET_OPEN_UTC_H  && m >= MARKET_OPEN_UTC_M);
    const before = h < MARKET_CLOSE_UTC_H || (h === MARKET_CLOSE_UTC_H && m <= MARKET_CLOSE_UTC_M);
    return after && before;
  }

  _parseOptionChain(raw) {
    const records = raw.records;
    const filtered = raw.filtered;
    const expiry = records.expiryDates[0]; // Get nearest expiry

    // Find Max OI strikes in the filtered data (current expiry)
    let maxCeOI = 0, maxCeStrike = 0;
    let maxPeOI = 0, maxPeStrike = 0;

    for (const leg of filtered.data) {
      if (leg.CE && leg.CE.openInterest > maxCeOI) {
        maxCeOI = leg.CE.openInterest;
        maxCeStrike = leg.strikePrice;
      }
      if (leg.PE && leg.PE.openInterest > maxPeOI) {
        maxPeOI = leg.PE.openInterest;
        maxPeStrike = leg.strikePrice;
      }
    }

    // PCR Calculation from filtered totals
    const totalCeOI = filtered.CE.totOI || 1;
    const totalPeOI = filtered.PE.totOI || 0;
    const pcr = totalPeOI / totalCeOI;

    // ATM Calculation: find strike closest to underlyingValue
    const underlying = records.underlyingValue;
    const strikes = filtered.data.map(l => l.strikePrice);
    const atmStrike = strikes.reduce((prev, curr) =>
      Math.abs(curr - underlying) < Math.abs(prev - underlying) ? curr : prev
    );

    // Build strike → option price lookup for paper executor
    const strikeData = {};
    for (const leg of filtered.data) {
      strikeData[leg.strikePrice] = {
        ce: leg.CE ? leg.CE.lastPrice : null,
        pe: leg.PE ? leg.PE.lastPrice : null,
      };
    }

    return {
      symbol:          'NIFTY',
      expiry,
      underlyingValue: underlying,
      vix:             records.vix || null,
      pcr:             Math.round(pcr * 1000) / 1000,
      maxCeOiStrike:   maxCeStrike,
      maxPeOiStrike:   maxPeStrike,
      atmStrike,
      strikeData,
      timestamp:       new Date().toISOString(),
    };
  }
}

module.exports = new OptionsChain();