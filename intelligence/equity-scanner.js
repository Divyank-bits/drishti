/**
 * @file equity-scanner.js
 * @description Phase 6 equity directional scanner. Orchestrates the full scan pipeline:
 *              fetch candles for 1m/5m/15m → compute indicators → fetch equity context
 *              → run all equity strategies per timeframe → score confluence → emit events.
 *
 *              Scan modes (set via flag param):
 *                'rules'   — rules only, no Claude call (default)
 *                'claude'  — skip rules, call Claude directly with raw data
 *                'confirm' — run rules first, pass findings to Claude for reasoning layer
 */

'use strict';

const { RSI, EMA, MACD, BollingerBands } = require('technicalindicators');
const eventBus       = require('../core/event-bus');
const EVENTS         = require('../core/events');
const config         = require('../config');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [EquityScanner] [${level}] ${msg}`);
}

// ── Indicator computation ─────────────────────────────────────────────────────

function _computeIndicators(candles) {
  if (!candles || candles.length < 14) {
    return { rsi: null, ema9: null, ema21: null, macd: null, bb: null, avgVolume: null };
  }

  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume ?? 0);

  const rsiArr  = RSI.calculate({ values: closes, period: 14 });
  const ema9Arr = EMA.calculate({ values: closes, period: 9 });
  const ema21Arr= EMA.calculate({ values: closes, period: 21 });
  const macdArr = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: false, SimpleMASignal: false });
  const bbArr   = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });

  const avgVolume = volumes.length > 0
    ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length)
    : null;

  return {
    rsi:       rsiArr.length   ? rsiArr[rsiArr.length - 1]   : null,
    ema9:      ema9Arr.length  ? ema9Arr[ema9Arr.length - 1] : null,
    ema21:     ema21Arr.length ? ema21Arr[ema21Arr.length - 1]: null,
    macd:      macdArr.length  ? macdArr[macdArr.length - 1] : null,
    bb:        bbArr.length    ? bbArr[bbArr.length - 1]     : null,
    avgVolume,
  };
}

// ── Candle fetching per timeframe ─────────────────────────────────────────────

async function _fetchCandles(symbol, timeframe) {
  const historical = require('../data/historical');
  try {
    const candles = await historical.fetchForSymbol(symbol);
    return candles;
  } catch (err) {
    log('WARN', `${symbol} candle fetch (${timeframe}m) failed: ${err.message}`);
    return [];
  }
}

// ── Main scan function ────────────────────────────────────────────────────────

class EquityScanner {
  /**
   * Runs a full equity directional scan for the given symbol.
   *
   * @param {string} symbol  - NSE equity symbol e.g. 'RELIANCE'
   * @param {string} [mode]  - 'rules' | 'claude' | 'confirm' (default: 'rules')
   * @returns {Promise<object>} scan result payload
   */
  async scan(symbol, mode = 'rules') {
    const sym = symbol.toUpperCase();
    log('INFO', `Scanning ${sym} [mode=${mode}]`);
    eventBus.emit(EVENTS.EQUITY_SCAN_STARTED, { symbol: sym, mode });

    try {
      // ── Fetch candles for all timeframes in parallel ───────────────────────
      const timeframes = config.EQUITY_SCAN_CANDLE_TIMEFRAMES || [1, 5, 15];
      const [candles15, candles5, candles1] = await Promise.all(
        timeframes.map(tf => _fetchCandles(sym, tf))
      );
      const candlesByTf = { 15: candles15, 5: candles5, 1: candles1 };

      // ── Fetch equity context (prev day OHLC + VWAP) ───────────────────────
      const equityContext = require('../data/equity-context');
      const context = await equityContext.getContext(sym);

      // ── Claude-only mode: skip rules, call Claude directly ────────────────
      if (mode === 'claude') {
        return await this._scanClaude(sym, candlesByTf, context);
      }

      // ── Run all equity strategies per timeframe ───────────────────────────
      const equityRegistry = require('../strategies/equity/registry');
      const confluenceScorer = require('./confluence-scorer');

      const resultsByTimeframe = {};
      for (const tf of timeframes) {
        const candles    = candlesByTf[tf] || [];
        const indicators = _computeIndicators(candles);
        resultsByTimeframe[tf] = equityRegistry.runAll({ candles, indicators, context, timeframe: tf });
      }

      // ── Score confluence ──────────────────────────────────────────────────
      const confluence = confluenceScorer.score(resultsByTimeframe);

      // Build flat strategy results list for payload
      const strategyResults = [];
      for (const [tf, results] of Object.entries(resultsByTimeframe)) {
        for (const { strategy, result } of results) {
          strategyResults.push({
            strategy:   strategy.name,
            timeframe:  Number(tf),
            state:      result.state,
            confidence: result.confidence,
            signals:    result.signals,
            failedConditions: result.failedConditions,
          });
        }
      }

      const payload = {
        symbol:          sym,
        mode,
        confluence,
        context,
        strategyResults,
        timestamp:       new Date().toISOString(),
      };

      // ── Confirm mode: add Claude reasoning on top of rules ────────────────
      if (mode === 'confirm' && confluence.state !== 'NONE') {
        try {
          const claudeReasoning = await this._callClaude(sym, candlesByTf, context, strategyResults, confluence);
          payload.claudeReasoning = claudeReasoning;
        } catch (err) {
          log('WARN', `Claude confirm call failed: ${err.message}`);
          payload.claudeReasoning = null;
        }
      }

      // ── Emit events ───────────────────────────────────────────────────────
      eventBus.emit(EVENTS.EQUITY_SCAN_RESULT, payload);

      if (confluence.state === 'CONFIRMED') {
        eventBus.emit(EVENTS.EQUITY_PATTERN_CONFIRMED, payload);
        log('INFO', `${sym} CONFIRMED — score=${confluence.score} pattern=${confluence.dominantPattern}`);
      } else if (confluence.state === 'FORMING') {
        eventBus.emit(EVENTS.EQUITY_PATTERN_FORMING, payload);
        log('INFO', `${sym} FORMING — score=${confluence.score} pattern=${confluence.dominantPattern}`);
      } else {
        log('INFO', `${sym} no signal — score=${confluence.score}`);
      }

      return payload;

    } catch (err) {
      log('ERROR', `${sym} scan failed: ${err.message}`);
      const errorPayload = { symbol: sym, mode, error: err.message, timestamp: new Date().toISOString() };
      eventBus.emit(EVENTS.EQUITY_SCAN_RESULT, errorPayload);
      return errorPayload;
    }
  }

  // ── Claude integration ────────────────────────────────────────────────────

  async _callClaude(symbol, candlesByTf, context, strategyResults, confluence) {
    const claudeClient   = require('./claude-client');
    const { buildEquityScanPrompt } = require('./prompt-builder');
    const indicators15 = _computeIndicators(candlesByTf[15] || []);
    const prompt = buildEquityScanPrompt(symbol, candlesByTf, indicators15, context, strategyResults, confluence);
    const raw    = await claudeClient.call(prompt);
    return claudeClient.parseJSON(raw);
  }

  async _scanClaude(symbol, candlesByTf, context) {
    const claudeClient   = require('./claude-client');
    const { buildEquityScanPrompt } = require('./prompt-builder');
    const indicators15 = _computeIndicators(candlesByTf[15] || []);
    const prompt = buildEquityScanPrompt(symbol, candlesByTf, indicators15, context, [], null);
    const raw    = await claudeClient.call(prompt);
    const claudeReasoning = claudeClient.parseJSON(raw);

    const payload = {
      symbol,
      mode: 'claude',
      confluence:     { score: null, state: 'NONE', timeframeScores: {}, dominantPattern: null, dominantDirection: null },
      context,
      strategyResults: [],
      claudeReasoning,
      timestamp: new Date().toISOString(),
    };
    eventBus.emit(EVENTS.EQUITY_SCAN_RESULT, payload);
    return payload;
  }
}

module.exports = new EquityScanner();
