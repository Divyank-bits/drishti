/**
 * @file test-phase2-journal.js
 * @description Phase 2 Gate 2 — Trade journal append-only NDJSON writer.
 */
'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n── Trade Journal Tests ──────────────────────────────────────────\n');

const TradeJournal = require('../journal/trade-journal');

// Use a temp file for tests
const tmpPath = path.join(os.tmpdir(), `drishti-test-journal-${Date.now()}.ndjson`);
TradeJournal._filePath = tmpPath;

(async () => {
  await testAsync('T01 write() appends a line to the file', async () => {
    await TradeJournal.write('TRADE_SIGNAL', { strikes: { shortCe: 24400 } });
    const content = fs.readFileSync(tmpPath, 'utf8').trim();
    assert(content.length > 0, 'file has content');
  });

  await testAsync('T02 written line is valid JSON', async () => {
    const lines = fs.readFileSync(tmpPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[0]);
    assert.strictEqual(entry.eventType, 'TRADE_SIGNAL');
    assert(typeof entry.timestamp === 'string');
  });

  await testAsync('T03 multiple writes append without overwriting', async () => {
    await TradeJournal.write('ORDER_FILLED', { premiumCollected: 500 });
    await TradeJournal.write('TRADE_CLOSED', { realisedPnl: 300, duration: 120, reasoning: null });
    const lines = fs.readFileSync(tmpPath, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, 3, 'three entries appended');
  });

  await testAsync('T04 readToday() returns entries for today', async () => {
    const entries = await TradeJournal.readToday();
    assert(Array.isArray(entries), 'returns array');
    assert(entries.length >= 1, 'has entries');
  });

  await testAsync('T05 readToday() filters out entries from other days', async () => {
    // Write an entry with a yesterday timestamp
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    const line = JSON.stringify({ timestamp: yesterday, eventType: 'OLD_EVENT', data: {} }) + '\n';
    fs.appendFileSync(tmpPath, line);
    const entries = await TradeJournal.readToday();
    const hasOld = entries.some(e => e.eventType === 'OLD_EVENT');
    assert(!hasOld, 'old entries excluded');
  });

  await testAsync('T06 restoreFromJournal() returns pnlToday and tradesToday', async () => {
    // Write a TRADE_CLOSED entry for today
    fs.writeFileSync(tmpPath, ''); // reset
    await TradeJournal.write('TRADE_CLOSED', { realisedPnl: 1200, duration: 300, reasoning: null });
    await TradeJournal.write('TRADE_CLOSED', { realisedPnl: -400, duration: 180, reasoning: null });
    const { pnlToday, tradesToday } = await TradeJournal.restoreFromJournal();
    assert.strictEqual(tradesToday, 2, 'tradesToday = 2');
    assert.strictEqual(pnlToday, 800, 'pnlToday = sum of realised P&L');
  });

  // Clean up
  fs.unlinkSync(tmpPath);

  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
