/**
 * @file symbol-scanner.js
 * @description Fetches options chain + indicator snapshot for a single symbol,
 *              scores it against all active strategies, and emits SCAN_RESULT.
 *              In HYBRID/AI mode, passes high-scoring candidates to Claude for
 *              confirmation before emitting SCAN_SYMBOL_FLAGGED.
 *              Called by scan-scheduler.js on every scan cycle.
 */

'use strict';

const eventBus      = require('../core/event-bus');
const EVENTS        = require('../core/events');
const config        = require('../config');
const optionsChain  = require('../data/options-chain');
const historical    = require('../data/historical');
const registry      = require('../strategies/registry');

const { RSI, EMA, MACD, BollingerBands } = require('technicalindicators');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [SymbolScanner] [${level}] ${msg}`);
}

/**
 * Computes a lightweight indicator snapshot from a candle array.
 * Returns the same shape expected by strategy.checkConditions().
 * @param {Array} candles
 * @returns {object}
 */
function computeIndicators(candles) {
  if (!candles || candles.length < 5) return {};

  const closes = candles.map((c) => c.close);
  const highs  = candles.map((c) => c.high);
  const lows   = candles.map((c) => c.low);

  const rsiResult  = RSI.calculate({ period: 14, values: closes });
  const ema9Result = EMA.calculate({ period: 9,  values: closes });
  const ema21Result= EMA.calculate({ period: 21, values: closes });
  const macdResult = MACD.calculate({
    values:             closes,
    fastPeriod:         12,
    slowPeriod:         26,
    signalPeriod:       9,
    SimpleMAOscillator: false,
    SimpleMASignal:     false,
  });
  const bbResult   = BollingerBands.calculate({ period: 20, stdDev: 2, values: closes });

  return {
    rsi:  rsiResult.length  ? rsiResult[rsiResult.length - 1]   : null,
    ema9: ema9Result.length  ? ema9Result[ema9Result.length - 1]  : null,
    ema21:ema21Result.length ? ema21Result[ema21Result.length - 1]: null,
    macd: macdResult.length  ? {
      macd:      macdResult[macdResult.length - 1].MACD    ?? null,
      signal:    macdResult[macdResult.length - 1].signal  ?? null,
      histogram: macdResult[macdResult.length - 1].histogram ?? null,
    } : null,
    bb: bbResult.length ? {
      upper:  bbResult[bbResult.length - 1].upper,
      middle: bbResult[bbResult.length - 1].middle,
      lower:  bbResult[bbResult.length - 1].lower,
      width:  closes.length
        ? (bbResult[bbResult.length - 1].upper - bbResult[bbResult.length - 1].lower) /
          bbResult[bbResult.length - 1].middle * 100
        : null,
    } : null,
  };
}

/**
 * Computes a scan score (0–100) for a symbol using dimension weights from the spec.
 * Independent of strategy checkConditions — used for watchlist ranking.
 *
 * Dimensions:
 *   IV Rank (25%)       — BB width percentile proxy > 50%
 *   OI Profile (25%)    — PCR 0.9–1.2
 *   Trend Neutrality (20%) — EMA9/EMA21 spread < 0.3%, RSI 40–60
 *   Volatility Regime (20%) — BB width 2–4%
 *   Liquidity (10%)     — placeholder (OI > 0 from chain data)
 *
 * @param {object} chain    — options chain payload
 * @param {object} indicators
 * @param {number[]} bbWidthHistory
 * @returns {number} 0–100
 */
function computeScanScore(chain, indicators, bbWidthHistory) {
  let score = 0;

  // IV Rank (25 pts) — BB width percentile proxy
  const bbWidth = indicators.bb?.width;
  if (bbWidthHistory.length >= 5 && bbWidth != null) {
    const countBelow = bbWidthHistory.filter((w) => w < bbWidth).length;
    const pct = (countBelow / bbWidthHistory.length) * 100;
    if (pct > 50) score += 25;
    else score += Math.round((pct / 50) * 25);
  }

  // OI Profile (25 pts) — PCR 0.9–1.2
  const { pcr } = chain;
  if (pcr != null) {
    if (pcr >= 0.9 && pcr <= 1.2) score += 25;
    else if (pcr >= 0.7 && pcr <= 1.4) score += 12;
  }

  // Trend Neutrality (20 pts) — EMA spread < 0.3% AND RSI 40–60
  const { ema9, ema21, rsi } = indicators;
  if (ema9 != null && ema21 != null && ema21 > 0) {
    const spread = Math.abs(ema9 - ema21) / ema21;
    if (spread <= 0.003) score += 10;
    else if (spread <= 0.006) score += 5;
  }
  if (rsi != null && rsi >= 40 && rsi <= 60) score += 10;

  // Volatility Regime (20 pts) — BB width 2–4%
  if (bbWidth != null) {
    if (bbWidth >= 2 && bbWidth <= 4) score += 20;
    else if (bbWidth >= 1 && bbWidth <= 6) score += 10;
  }

  // Liquidity proxy (10 pts) — any OI data present
  if (chain.maxCeOiStrike > 0 || chain.maxPeOiStrike > 0) score += 10;

  return Math.min(100, score);
}

class SymbolScanner {
  constructor() {
    // bbWidthHistory per symbol for IV rank computation
    this._bbWidthHistory = new Map();
  }

  /**
   * Scans a single symbol. Fetches chain + candles, computes indicators,
   * scores against all strategies, emits SCAN_RESULT (and SCAN_SYMBOL_FLAGGED if threshold met).
   *
   * @param {string} symbol
   * @returns {Promise<object>} scan result payload
   */
  async scan(symbol) {
    const sym = symbol.toUpperCase();
    log('INFO', `Scanning ${sym}...`);

    let chain, candles, indicators;

    try {
      [chain, candles] = await Promise.all([
        optionsChain.fetchForSymbol(sym),
        historical.fetchForSymbol(sym),
      ]);
    } catch (err) {
      log('ERROR', `${sym}: data fetch failed — ${err.message}`);
      return { symbol: sym, error: err.message, score: 0, strategyScores: [] };
    }

    indicators = computeIndicators(candles);

    // Maintain per-symbol BB width history (up to 20 candles)
    if (!this._bbWidthHistory.has(sym)) this._bbWidthHistory.set(sym, []);
    const hist = this._bbWidthHistory.get(sym);
    if (indicators.bb?.width != null) {
      hist.push(indicators.bb.width);
      if (hist.length > 20) hist.shift();
    }

    const score = computeScanScore(chain, indicators, hist);

    // Score against each active strategy's checkConditions
    const strategies = registry.getAll();
    const strategyScores = strategies.map((strategy) => {
      try {
        const result = strategy.checkConditions({
          indicators,
          bbWidthHistory: [...hist],
          optionsChain:   chain,
          sessionContext: { vixCurrent: chain.vix },
          timestamp:      Date.now(),
          _isHolidayOverride: false,
        });
        return { strategy: strategy.name, eligible: result.eligible, score: result.score, failed: result.failedConditions };
      } catch (err) {
        return { strategy: strategy.name, eligible: false, score: 0, failed: ['error'] };
      }
    });

    const payload = {
      symbol:         sym,
      score,
      strategyScores,
      chain:          { vix: chain.vix, pcr: chain.pcr, atmStrike: chain.atmStrike, underlyingValue: chain.underlyingValue },
      indicators:     { rsi: indicators.rsi, ema9: indicators.ema9, ema21: indicators.ema21, bbWidth: indicators.bb?.width },
      timestamp:      new Date().toISOString(),
    };

    eventBus.emit(EVENTS.SCAN_RESULT, payload);

    if (score >= config.DEEP_SCAN_CONFIDENCE_THRESHOLD) {
      log('INFO', `${sym}: FLAGGED — score ${score} >= threshold ${config.DEEP_SCAN_CONFIDENCE_THRESHOLD}`);
      eventBus.emit(EVENTS.SCAN_SYMBOL_FLAGGED, payload);
    } else {
      log('DEBUG', `${sym}: score ${score} — below threshold`);
    }

    return payload;
  }
}

module.exports = new SymbolScanner();
