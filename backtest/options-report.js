/**
 * @file options-report.js
 * @description Phase 9: computes per-strategy metrics and prints a console report
 *              for the options backtester.
 */
'use strict';

function computeMetrics(trades) {
  if (trades.length === 0) return null;

  const pnls    = trades.map(t => t.realised_pnl ?? t.realisedPnl ?? 0);
  const wins    = pnls.filter(p => p > 0);
  const losses  = pnls.filter(p => p <= 0);

  const totalPnl    = pnls.reduce((s, p) => s + p, 0);
  const winRate     = wins.length / trades.length;
  const avgPnl      = totalPnl / trades.length;
  const grossWin    = wins.reduce((s, p)  => s + p, 0);
  const grossLoss   = Math.abs(losses.reduce((s, p) => s + p, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // Max drawdown (running)
  let peak = 0, cumPnl = 0, maxDD = 0;
  for (const p of pnls) {
    cumPnl += p;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDD) maxDD = dd;
  }

  // Max consecutive losses
  let maxConsecLoss = 0, curLoss = 0;
  for (const p of pnls) {
    if (p <= 0) { curLoss++; if (curLoss > maxConsecLoss) maxConsecLoss = curLoss; }
    else curLoss = 0;
  }

  const byYear = {};
  for (const t of trades) {
    const year = (t.trade_date || t.exitDate || '').slice(0, 4);
    if (!byYear[year]) byYear[year] = { trades: 0, pnl: 0, wins: 0 };
    byYear[year].trades++;
    byYear[year].pnl += t.realised_pnl ?? t.realisedPnl ?? 0;
    if ((t.realised_pnl ?? t.realisedPnl ?? 0) > 0) byYear[year].wins++;
  }

  return { totalPnl, winRate, avgPnl, profitFactor, maxDrawdown: maxDD, maxConsecLoss, byYear };
}

function printReport(trades, { from, to, symbols, strategies }) {
  const pad = (s, n) => String(s).padEnd(n);
  const r   = (n, d = 0) => typeof n === 'number' ? n.toFixed(d) : 'N/A';

  console.log('\n' + '═'.repeat(72));
  console.log(`  Drishti Options Backtest Report  [EOD_BHAVCOPY]`);
  console.log(`  Period: ${from} → ${to}   Symbols: ${symbols.join(', ')}`);
  console.log(`  Strategies: ${strategies.join(', ')}`);
  console.log('═'.repeat(72));

  if (trades.length === 0) {
    console.log('  No trades — ensure Bhavcopy data is synced for this period.');
    console.log('═'.repeat(72) + '\n');
    return;
  }

  const m = computeMetrics(trades);

  console.log(`  Total trades : ${trades.length}`);
  console.log(`  Win rate     : ${(m.winRate * 100).toFixed(1)}%`);
  console.log(`  Total P&L    : ₹${r(m.totalPnl, 0)}`);
  console.log(`  Avg P&L/trade: ₹${r(m.avgPnl, 0)}`);
  console.log(`  Profit factor: ${r(m.profitFactor, 2)}`);
  console.log(`  Max drawdown : ₹${r(m.maxDrawdown, 0)}`);
  console.log(`  Max consec L : ${m.maxConsecLoss}`);

  // Per-year breakdown
  if (Object.keys(m.byYear).length > 1) {
    console.log('\n  ── By year ──');
    console.log(`  ${pad('Year', 6)} ${pad('Trades', 8)} ${pad('Win%', 7)} ${'P&L (₹)'}`);
    for (const [year, y] of Object.entries(m.byYear).sort()) {
      const wr = ((y.wins / y.trades) * 100).toFixed(0) + '%';
      console.log(`  ${pad(year, 6)} ${pad(y.trades, 8)} ${pad(wr, 7)} ₹${y.pnl.toFixed(0)}`);
    }
  }

  // Exit reason breakdown
  const byReason = {};
  for (const t of trades) {
    const r = t.exit_reason || 'UNKNOWN';
    if (!byReason[r]) byReason[r] = 0;
    byReason[r]++;
  }
  if (Object.keys(byReason).length > 0) {
    console.log('\n  ── Exit reasons ──');
    for (const [reason, cnt] of Object.entries(byReason)) {
      console.log(`  ${pad(reason, 16)} ${cnt}`);
    }
  }

  console.log('\n  ⚠  Results use EOD Bhavcopy prices only (no intraday simulation).');
  console.log('═'.repeat(72) + '\n');
}

module.exports = { computeMetrics, printReport };
