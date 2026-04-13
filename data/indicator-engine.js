/**
 * @file indicator-engine.js
 * @description Computes RSI, EMA, MACD, BB, ATR, ADX from candle buffers on every
 *              CANDLE_CLOSE_5M / CANDLE_CLOSE_15M event. Also computes Black-Scholes
 *              delta on OPTIONS_CHAIN_UPDATED. Emits INDICATORS_UPDATED.
 */

'use strict';

const { RSI, EMA, MACD, BollingerBands, ATR, ADX } = require('technicalindicators');
const bs          = require('black-scholes');
const eventBus    = require('../core/event-bus');
const EVENTS      = require('../core/events');
const candleBuilder = require('./candle-builder');

class IndicatorEngine {
  constructor() {
    this._lastOptionsChain = null;
    this._lastAtr          = null;
    this._hookEvents();
  }

  _hookEvents() {
    eventBus.on(EVENTS.CANDLE_CLOSE_5M,        () => this._compute(5));
    eventBus.on(EVENTS.CANDLE_CLOSE_15M,       () => this._compute(15));
    eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED,  (chain) => {
      this._lastOptionsChain = chain;
      this._computeDelta();
    });
  }

  _compute(timeframe) {
    const candles = candleBuilder.getBuffer(timeframe);
    const closes  = candles.map((c) => c.close);
    const highs   = candles.map((c) => c.high);
    const lows    = candles.map((c) => c.low);

    const indicators = {
      rsi:  this._rsi(closes),
      ema9: this._ema(closes, 9),
      ema21:this._ema(closes, 21),
      macd: null,
      bb:   null,
      atr:  null,
      adx:  null,
    };

    if (timeframe === 15) {
      indicators.macd = this._macd(closes);
      indicators.bb   = this._bb(closes);
      indicators.atr  = this._atr(highs, lows, closes);
      indicators.adx  = this._adx(highs, lows, closes);
      if (indicators.atr !== null) this._lastAtr = indicators.atr;
    }

    eventBus.emit(EVENTS.INDICATORS_UPDATED, {
      timeframe,
      timestamp: new Date().toISOString(),
      indicators,
    });
  }

  _rsi(closes) {
    if (closes.length < 14) return null;
    const r = RSI.calculate({ values: closes, period: 14 });
    return r.length ? r[r.length - 1] : null;
  }

  _ema(closes, period) {
    if (closes.length < period) return null;
    const r = EMA.calculate({ values: closes, period });
    return r.length ? r[r.length - 1] : null;
  }

  _macd(closes) {
    if (closes.length < 35) return null;
    const r = MACD.calculate({
      values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
    });
    if (!r.length) return null;
    const last = r[r.length - 1];
    return { macd: last.MACD, signal: last.signal, histogram: last.histogram };
  }

  _bb(closes) {
    if (closes.length < 20) return null;
    const r = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    if (!r.length) return null;
    const last  = r[r.length - 1];
    const width = last.middle > 0 ? ((last.upper - last.lower) / last.middle) * 100 : null;
    return { upper: last.upper, middle: last.middle, lower: last.lower, width };
  }

  _atr(highs, lows, closes) {
    if (closes.length < 15) return null;
    const r = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    return r.length ? r[r.length - 1] : null;
  }

  _adx(highs, lows, closes) {
    if (closes.length < 28) return null;
    const r = ADX.calculate({ high: highs, low: lows, close: closes, period: 14 });
    return r.length ? r[r.length - 1].adx : null;
  }

  _computeDelta() {
    const chain = this._lastOptionsChain;
    if (!chain || this._lastAtr === null) return;

    const S          = chain.underlyingValue;
    const r          = 0.065; // approximate Indian risk-free rate
    const msPerYear  = 365 * 24 * 60 * 60 * 1000;
    const T          = Math.max(
      (new Date(chain.expiry).getTime() - Date.now()) / msPerYear,
      0.001
    );
    // Annualised vol proxy: ATR/S × √(252 trading days × 25 bars/day at 15m)
    const sigma = (this._lastAtr / S) * Math.sqrt(252 * 25);

    // black-scholes package: bs.blackScholes(s,k,t,v,r,callPut) for price
    // Delta = dPrice/dS; approximate via finite difference if getDelta unavailable
    const callPrice = (strike) => bs.blackScholes(S, strike, T, sigma, r, 'call');
    const putPrice  = (strike) => bs.blackScholes(S, strike, T, sigma, r, 'put');
    const dS        = 1;
    const ceDelta   = (callPrice(chain.maxCeOiStrike) - bs.blackScholes(S - dS, chain.maxCeOiStrike, T, sigma, r, 'call')) / dS;
    const peDelta   = (putPrice(chain.maxPeOiStrike)  - bs.blackScholes(S - dS, chain.maxPeOiStrike,  T, sigma, r, 'put'))  / dS;

    eventBus.emit(EVENTS.INDICATORS_UPDATED, {
      timeframe:  'options',
      timestamp:  new Date().toISOString(),
      indicators: { ceDelta, peDelta },
    });
  }
}

module.exports = new IndicatorEngine();
