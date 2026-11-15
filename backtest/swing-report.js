/**
 * @file swing-report.js
 * @description Phase 7: computes per-setup metrics, prints the console report,
 *              and upserts rows into setup_stats.
 */

'use strict';

const config          = require('../config');
const { writeSetupStats } = require('../data/db');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [SwingReport] [${level}] ${msg}`);
}

// ── Metrics ───────────────────────────────────────────────────────────────────

/**
 * Compute metrics for a set of trade records (all same setup+direction+sample).
 */
function computeMetrics(trades) {
  if (trades.length === 0) {
    return {
      trades: 0, winRate: null, avgR: null, expectancyR: null,
      profitFactor: null, maxDrawdownR: null, maxConsecLoss: null, avgHoldDays: null,
      lowSample: true,
    };
  }

  const results = trades.map(t => t.resultR);
  const wins    = results.filter(r => r > 0);
  const losses  = results.filter(r => r <= 0);

  const winRate      = wins.length / results.length;
  const avgR         = results.reduce((s, r) => s + r, 0) / results.length;
  const expectancyR  = avgR;
  const sumWins      = wins.reduce((s, r) => s + r, 0);
  const sumLossAbs   = losses.reduce((s, r) => s + Math.abs(r), 0);
  const profitFactor = sumLossAbs > 0 ? sumWins / sumLossAbs : (sumWins > 0 ? Infinity : 0);

  // Max drawdown in R (peak-to-trough on cumulative R curve)
  let peak = 0, trough = 0, maxDD = 0, cum = 0;
  for (const r of results) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }

  // Max consecutive losses
  let maxConsecLoss = 0, streak = 0;
  for (const r of results) {
    if (r <= 0) { streak++; if (streak > maxConsecLoss) maxConsecLoss = streak; }
    else streak = 0;
  }

  const avgHoldDays = trades.reduce((s, t) => s + (t.holdDays || 0), 0) / trades.length;

  return {
    trades: trades.length,
    winRate,
    avgR,
    expectancyR,
    profitFactor,
    maxDrawdownR: -maxDD,
    maxConsecLoss,
    avgHoldDays,
    lowSample: trades.length < config.SWING_BT_MIN_TRADES,
  };
}

/**
 * Compute baseline R: mean forward return over the setup's median holding period,
 * sampled on all days in the candle array, in the trade's R units.
 *
 * @param {object[]} trades     — trades to get median hold days from
 * @param {object[]} allCandles — all candle data grouped by symbol
 * @returns {number|null}
 */
function computeBaseline(trades, allCandles) {
  if (trades.length === 0) return null;

  const holdDays = trades.map(t => t.holdDays || 0).sort((a, b) => a - b);
  const medianHold = holdDays[Math.floor(holdDays.length / 2)] || 1;

  // For each symbol, sample every bar and compute forward return over medianHold bars
  const returns = [];
  for (const { candles } of allCandles) {
    for (let i = 0; i < candles.length - medianHold; i++) {
      const fwdReturn = (candles[i + medianHold].close - candles[i].close) / candles[i].close;
      returns.push(fwdReturn);
    }
  }

  if (returns.length === 0) return null;

  const meanFwdReturn = returns.reduce((s, r) => s + r, 0) / returns.length;

  // Convert to R using the average 1R magnitude from trades
  const avgOneR = trades.reduce((s, t) => s + Math.abs(t.entryPrice - t.stopLoss), 0) / trades.length;
  const avgEntry = trades.reduce((s, t) => s + t.entryPrice, 0) / trades.length;
  if (avgEntry === 0 || avgOneR === 0) return null;

  return (meanFwdReturn * avgEntry) / avgOneR;
}

// ── Report printing ───────────────────────────────────────────────────────────

function fmt(v, digits = 2) {
  if (v === null || v === undefined || isNaN(v)) return '  --  ';
  if (!isFinite(v)) return '  ∞  ';
  return v.toFixed(digits);
}

function pad(s, n, right = false) {
  const str = String(s);
  if (right) return str.padStart(n);
  return str.padEnd(n);
}

/**
 * Prints the console report and upserts setup_stats rows.
 *
 * @param {object[]} trades      — all trade records from the backtester
 * @param {object}   opts
 * @param {string}   opts.sample — 'IS' | 'OOS' | 'BOTH'
 * @param {string}   opts.from
 * @param {string}   opts.to
 * @param {string}   opts.exitMode
 * @param {boolean}  opts.rrGate
 * @param {string[]} opts.symbols
 * @param {object[]} opts.allCandles  — [{ symbol, candles }] for baseline
 */
function printReport(trades, { sample, from, to, exitMode, rrGate, symbols, allCandles = [] }) {
  const samples = sample === 'BOTH' ? ['IS', 'OOS'] : [sample];
  const divider = '═'.repeat(76);
  const thinDiv = '─'.repeat(76);

  for (const smp of samples) {
    const sampleTrades = trades.filter(t => t.sample === smp);

    console.log('\n' + divider);
    console.log(`  Drishti Swing Backtest — ${smp}`);
    console.log(`  Period: ${from} → ${to}   Symbols: ${symbols.length}   Exit: ${exitMode}`);
    console.log(`  Costs: ${config.SWING_BT_COST_PCT}% round trip   RR gate: ${rrGate ? '> ' + config.SWING_MIN_RR : 'off'}`);
    console.log(divider);

    const header = `  ${'Setup'.padEnd(20)} ${'Dir'.padEnd(6)} ${'Trades'.padStart(6)} ${'Win%'.padStart(6)} ${'Avg R'.padStart(7)} ${'Expect'.padStart(7)} ${'PF'.padStart(5)} ${'MaxDD'.padStart(7)} ${'Blocked'.padStart(8)}  ${'Baseline'.padStart(8)}`;
    console.log(header);

    // Gather unique setup × direction combos
    const keys = [...new Set(sampleTrades.map(t => `${t.setupId}|${t.direction}`))].sort();

    for (const key of keys) {
      const [setupId, dir] = key.split('|');
      const subset = sampleTrades.filter(t => t.setupId === setupId && t.direction === dir);
      const m = computeMetrics(subset);
      const blockedCount = trades.filter(t =>
        t.setupId === setupId && t.direction === dir && t.sample === smp && t.blockedBy
      ).length;
      const baseline = computeBaseline(subset, allCandles);

      const lowFlag = m.lowSample ? '  LOW_SAMPLE' : '';
      const line = `  ${pad(setupId, 20)} ${pad(dir, 6)} ${pad(m.trades, 6, true)} ` +
        `${pad((m.winRate !== null ? (m.winRate * 100).toFixed(0) + '%' : '--'), 6, true)} ` +
        `${pad(fmt(m.avgR), 7, true)} ${pad(fmt(m.expectancyR), 7, true)} ` +
        `${pad(fmt(m.profitFactor), 5, true)} ${pad(fmt(m.maxDrawdownR) + 'R', 7, true)} ` +
        `${pad(blockedCount, 8, true)}  ${pad(fmt(baseline), 8, true)}${lowFlag}`;
      console.log(line);

      // Upsert into setup_stats
      const runAt = new Date().toISOString();
      writeSetupStats({
        setup_id:        setupId,
        direction:       dir,
        sample:          smp,
        run_at:          runAt,
        period_from:     from,
        period_to:       to,
        exit_mode:       exitMode,
        trades:          m.trades,
        win_rate:        m.winRate,
        avg_r:           m.avgR,
        expectancy_r:    m.expectancyR,
        profit_factor:   m.profitFactor,
        max_drawdown_r:  m.maxDrawdownR,
        max_consec_loss: m.maxConsecLoss,
        avg_hold_days:   m.avgHoldDays,
        baseline_r:      baseline,
        low_sample:      m.lowSample ? 1 : 0,
      });
    }

    console.log(thinDiv);

    // Subtype breakdown for setups that have subtypes
    const subtypeSummary = {};
    for (const t of sampleTrades) {
      if (!t.subtype) continue;
      const k = `${t.setupId}|${t.direction}|${t.subtype}`;
      if (!subtypeSummary[k]) subtypeSummary[k] = [];
      subtypeSummary[k].push(t.resultR);
    }
    for (const [k, results] of Object.entries(subtypeSummary)) {
      const [sid, dir, sub] = k.split('|');
      const avg = results.reduce((s, r) => s + r, 0) / results.length;
      console.log(`  ${sid} ${dir} by subtype:  ${sub} ${results.length} (${avg >= 0 ? '+' : ''}${avg.toFixed(2)}R)`);
    }

    console.log('  Short trades use cash prices as a futures proxy.');
    console.log('  Universe is today\'s large caps (survivorship bias) — results are optimistic.');
    console.log(divider + '\n');
  }
}

module.exports = { computeMetrics, printReport };
