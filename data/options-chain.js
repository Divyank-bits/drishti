/**
 * @file options-chain.js
 * @description Fetches NSE NIFTY option chain using stock-nse-india.
 * Emits OPTIONS_CHAIN_UPDATED on success with PCR, Max OI, and ATM strike.
 */

'use strict';

const cron     = require('node-cron');
const axios    = require('axios');
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
      const result = config.DATA_SOURCE === 'DHAN'
        ? await this._fetchFromDhan()
        : await this._fetchFromNSE();

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

  async _fetchFromNSE() {
    const raw = await nse.getIndexOptionChain('NIFTY');
    return this._parseOptionChain(raw);
  }

  // Fetches nearest active expiry from Dhan, then fetches option chain for it.
  // POST /v2/optionchain/expirylist → pick dates[0]
  // POST /v2/optionchain            → parse data.oc (keyed by strike string)
  async _fetchFromDhan() {
    if (!config.DHAN_CLIENT_ID || !config.DHAN_ACCESS_TOKEN) {
      throw new Error('DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN not set');
    }

    const headers = {
      'access-token': config.DHAN_ACCESS_TOKEN,
      'client-id':    config.DHAN_CLIENT_ID,
      'Content-Type': 'application/json',
    };
    const underlying = { UnderlyingScrip: 13, UnderlyingSeg: config.DHAN_EXCHANGE_SEGMENT };

    // Step 1: fetch expiry list and pick nearest active expiry
    const expiryRes = await axios.post(
      `${config.DHAN_REST_URL}/optionchain/expirylist`,
      underlying,
      { headers, timeout: 10000 }
    );
    const expiries = expiryRes.data?.data;
    if (!Array.isArray(expiries) || expiries.length === 0) {
      throw new Error('Dhan expiry list returned no dates');
    }
    const expiry = expiries[0]; // nearest active expiry

    // Step 2: fetch option chain for that expiry
    const res = await axios.post(
      `${config.DHAN_REST_URL}/optionchain`,
      { ...underlying, Expiry: expiry },
      { headers, timeout: 10000 }
    );

    if (res.data?.status !== 'success') {
      throw new Error(`Dhan option chain error: ${JSON.stringify(res.data).slice(0, 200)}`);
    }

    return this._parseDhanOptionChain(res.data.data, expiry);
  }

  // Response shape: { last_price, oc: { "25650.000000": { ce: { last_price, oi, security_id, greeks }, pe: {...} } } }
  _parseDhanOptionChain(data, expiry) {
    const underlying = data.last_price || 0;
    const oc         = data.oc || {};

    let maxCeOI = 0, maxCeStrike = 0;
    let maxPeOI = 0, maxPeStrike = 0;
    let totalCeOI = 0, totalPeOI = 0;
    const strikeData = {};

    for (const [strikeStr, legs] of Object.entries(oc)) {
      const strike = parseFloat(strikeStr);
      const ceOI   = legs.ce?.oi         || 0;
      const peOI   = legs.pe?.oi         || 0;
      const ceLtp  = legs.ce?.last_price ?? null;
      const peLtp  = legs.pe?.last_price ?? null;

      totalCeOI += ceOI;
      totalPeOI += peOI;

      if (ceOI > maxCeOI) { maxCeOI = ceOI; maxCeStrike = strike; }
      if (peOI > maxPeOI) { maxPeOI = peOI; maxPeStrike = strike; }

      strikeData[strike] = {
        ce:          ceLtp,
        pe:          peLtp,
        ceSecurityId: legs.ce?.security_id ?? null,
        peSecurityId: legs.pe?.security_id ?? null,
      };
    }

    const strikes   = Object.keys(oc).map(parseFloat);
    const atmStrike = strikes.length
      ? strikes.reduce((prev, curr) =>
          Math.abs(curr - underlying) < Math.abs(prev - underlying) ? curr : prev)
      : 0;

    return {
      symbol:          'NIFTY',
      expiry,
      underlyingValue: underlying,
      vix:             null, // Dhan option chain does not include VIX
      pcr:             totalCeOI > 0 ? Math.round((totalPeOI / totalCeOI) * 1000) / 1000 : 0,
      maxCeOiStrike:   maxCeStrike,
      maxPeOiStrike:   maxPeStrike,
      atmStrike,
      strikeData,
      timestamp:       new Date().toISOString(),
    };
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