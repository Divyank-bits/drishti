/**
 * @file fetch-dhan-scrip-ids.js
 * @description One-time utility to fetch Dhan's scrip master CSV and extract
 *              security IDs for NSE equity symbols used in historical data fetching.
 *              Run: node scripts/fetch-dhan-scrip-ids.js [SYMBOL1 SYMBOL2 ...]
 *              Default symbols: RELIANCE TCS INFY HDFCBANK ICICIBANK SBIN WIPRO AXISBANK KOTAKBANK LT
 */

'use strict';

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const DHAN_SCRIP_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';

const DEFAULT_SYMBOLS = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
  'SBIN', 'WIPRO', 'AXISBANK', 'KOTAKBANK', 'LT',
  'BHARTIARTL', 'ITC', 'HINDUNILVR', 'BAJFINANCE', 'MARUTI',
  'TATAMOTORS', 'TATASTEEL', 'ADANIENT', 'SUNPHARMA', 'NTPC',
];

async function main() {
  const targets = process.argv.slice(2).length
    ? process.argv.slice(2).map(s => s.toUpperCase())
    : DEFAULT_SYMBOLS;

  console.log(`Downloading Dhan scrip master from ${DHAN_SCRIP_URL} ...`);

  const resp = await axios.get(DHAN_SCRIP_URL, { timeout: 30000, responseType: 'text' });
  const lines = resp.data.split('\n');
  const header = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));

  const idx = {
    tradingSymbol:   header.indexOf('SEM_TRADING_SYMBOL'),
    securityId:      header.indexOf('SEM_SMST_SECURITY_ID'),
    exchangeSegment: header.indexOf('SEM_EXM_EXCH_ID'),
    instrument:      header.indexOf('SEM_INSTRUMENT_NAME'),
  };

  if (Object.values(idx).some(i => i === -1)) {
    // Try alternate column names from older scrip master format
    idx.tradingSymbol   = header.indexOf('SM_SYMBOL_NAME') !== -1 ? header.indexOf('SM_SYMBOL_NAME') : header.findIndex(h => h.includes('SYMBOL'));
    idx.securityId      = header.findIndex(h => h.includes('SECURITY_ID') || h.includes('SCRIP_ID'));
    idx.exchangeSegment = header.findIndex(h => h.includes('EXCH') || h.includes('SEGMENT'));
    idx.instrument      = header.findIndex(h => h.includes('INSTRUMENT'));
    console.log('Using fallback column detection. Header:', header.slice(0, 10).join(', '));
  }

  const found = {};

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Handle quoted CSV fields
    const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));

    const symbol   = cols[idx.tradingSymbol]   || '';
    const segment  = cols[idx.exchangeSegment] || '';
    const instrument = cols[idx.instrument]    || '';

    // Only NSE equity (NSE_EQ or NSE segment, EQUITY instrument)
    const isNseEquity = (segment === 'NSE_EQ' || segment === 'NSE' || segment === '1') &&
                        (instrument === 'EQUITY' || instrument === 'EQ' || instrument === '');

    if (targets.includes(symbol) && isNseEquity && !found[symbol]) {
      found[symbol] = {
        securityId:      cols[idx.securityId],
        exchangeSegment: segment,
        instrument,
      };
    }
  }

  console.log('\n── Results ──────────────────────────────────');
  const missing = [];
  for (const sym of targets) {
    if (found[sym]) {
      console.log(`  ${sym.padEnd(15)} securityId: ${found[sym].securityId}  segment: ${found[sym].exchangeSegment}`);
    } else {
      missing.push(sym);
    }
  }

  if (missing.length) {
    console.log(`\nNot found (may need different segment filter): ${missing.join(', ')}`);
    console.log('Re-running without segment filter for missing symbols...');

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(',').map(c => c.trim().replace(/"/g, ''));
      const symbol = cols[idx.tradingSymbol] || '';
      if (missing.includes(symbol) && !found[symbol]) {
        found[symbol] = {
          securityId:      cols[idx.securityId],
          exchangeSegment: cols[idx.exchangeSegment] || '',
          instrument:      cols[idx.instrument] || '',
        };
        console.log(`  ${symbol.padEnd(15)} securityId: ${found[symbol].securityId}  segment: ${found[symbol].exchangeSegment}  instrument: ${found[symbol].instrument}`);
      }
    }
  }

  // Generate the DHAN_SECURITY_MAP snippet for historical.js
  const mapEntries = Object.entries(found)
    .map(([sym, info]) => `      ${sym.padEnd(15)}: { securityId: '${info.securityId}', segment: 'NSE_EQ' },`)
    .join('\n');

  const snippet = `\n// Add these to DHAN_SECURITY_MAP in data/historical.js:\n{\n${mapEntries}\n}`;
  console.log('\n── Paste into historical.js DHAN_SECURITY_MAP ──');
  console.log(snippet);

  // Also save to a file
  const outPath = path.join(__dirname, 'dhan-security-ids.json');
  fs.writeFileSync(outPath, JSON.stringify(found, null, 2));
  console.log(`\nFull results saved to ${outPath}`);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
