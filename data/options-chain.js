/**
 * @file options-chain.js
 * @description Fetches NSE NIFTY option chain every OPTIONS_CHAIN_INTERVAL minutes
 *              during market hours. Handles cookie refresh with one silent retry.
 *              Emits OPTIONS_CHAIN_UPDATED on success, OPTIONS_CHAIN_STALE on double failure.
 */

'use strict';

const cron     = require('node-cron');
const axios    = require('axios');
const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const config   = require('../config');

const NSE_BASE     = 'https://www.nseindia.com';
const NSE_CHAIN    = `${NSE_BASE}/api/option-chain-indices?symbol=NIFTY`;
const UA           = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

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
    this._cookie           = null;
    this._lastGoodResult   = null;
    this._lastGoodAt       = null;
  }

  start() {
    // Run every 15 minutes on weekdays; handler checks market hours internally
    cron.schedule(`*/${config.OPTIONS_CHAIN_INTERVAL} * * * 1-5`, () => this._tick());
    log('INFO', `Polling every ${config.OPTIONS_CHAIN_INTERVAL}m on weekdays`);
  }

  async _tick() {
    if (!this._isDuringMarketHours()) return;
    await this._fetchWithRetry();
  }

  _isDuringMarketHours() {
    const now = new Date();
    const h   = now.getUTCHours();
    const m   = now.getUTCMinutes();
    const after  = h > MARKET_OPEN_UTC_H  || (h === MARKET_OPEN_UTC_H  && m >= MARKET_OPEN_UTC_M);
    const before = h < MARKET_CLOSE_UTC_H || (h === MARKET_CLOSE_UTC_H && m <= MARKET_CLOSE_UTC_M);
    return after && before;
  }

  async _fetchWithRetry() {
    try {
      const raw    = await this._fetchFromNSE();
      const result = this._parseOptionChain(raw);
      this._lastGoodResult = result;
      this._lastGoodAt     = Date.now();
      eventBus.emit(EVENTS.OPTIONS_CHAIN_UPDATED, result);
    } catch (firstErr) {
      log('WARN', `First attempt failed (${firstErr.message}), refreshing cookie and retrying`);
      this._cookie = null; // force cookie refresh on retry
      try {
        const raw    = await this._fetchFromNSE();
        const result = this._parseOptionChain(raw);
        this._lastGoodResult = result;
        this._lastGoodAt     = Date.now();
        eventBus.emit(EVENTS.OPTIONS_CHAIN_UPDATED, result);
      } catch (secondErr) {
        log('ERROR', `Both attempts failed: ${secondErr.message}`);
        eventBus.emit(EVENTS.OPTIONS_CHAIN_STALE, {
          reason:            secondErr.message,
          lastGoodTimestamp: this._lastGoodAt,
        });
      }
    }
  }

  async _fetchFromNSE() {
    if (!this._cookie) {
      const r = await axios.get(NSE_BASE, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        timeout: 8000,
      });
      this._cookie = (r.headers['set-cookie'] || []).join('; ');
    }

    const res = await axios.get(NSE_CHAIN, {
      headers: {
        'User-Agent': UA,
        'Referer':    NSE_BASE,
        'Cookie':     this._cookie,
      },
      timeout: 10000,
    });

    if (!res.data || !res.data.records) throw new Error('Malformed NSE response');
    return res.data;
  }

  // Pure parser — testable without any HTTP calls
  _parseOptionChain(raw) {
    const records = raw.records;
    const expiry  = records.expiryDates[0]; // nearest expiry

    const legs = records.data.filter((d) => d.expiryDate === expiry);

    let maxCeOI = 0, maxCeStrike = 0;
    let maxPeOI = 0, maxPeStrike = 0;

    for (const leg of legs) {
      if (leg.CE && leg.CE.openInterest > maxCeOI) {
        maxCeOI = leg.CE.openInterest; maxCeStrike = leg.strikePrice;
      }
      if (leg.PE && leg.PE.openInterest > maxPeOI) {
        maxPeOI = leg.PE.openInterest; maxPeStrike = leg.strikePrice;
      }
    }

    const totalCeOI = raw.filtered.CE.totOI || 1;
    const totalPeOI = raw.filtered.PE.totOI || 0;
    const pcr       = totalPeOI / totalCeOI;

    // ATM = nearest strike to underlying
    const underlying = records.underlyingValue;
    const strikes    = [...new Set(legs.map((l) => l.strikePrice))].sort((a, b) => a - b);
    const atmStrike  = strikes.reduce((prev, curr) =>
      Math.abs(curr - underlying) < Math.abs(prev - underlying) ? curr : prev
    );

    return {
      symbol:          'NIFTY',
      expiry,
      underlyingValue: underlying,
      vix:             records.vix || null,
      pcr:             Math.round(pcr * 1000) / 1000,
      maxCeOiStrike:   maxCeStrike,
      maxPeOiStrike:   maxPeStrike,
      atmStrike,
      timestamp:       new Date().toISOString(),
    };
  }
}

module.exports = new OptionsChain();
