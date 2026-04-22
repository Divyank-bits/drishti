/**
 * @file test-dhan.js
 * @description Live integration tests for all three Dhan API surfaces:
 *              1. REST auth (fund limit endpoint)
 *              2. Historical charts API (15m candles)
 *              3. Option chain API (nearest expiry)
 *              4. WebSocket live feed (10-second smoke test)
 *
 * Run: node test-dhan.js
 * Requires: DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN in .env
 */

'use strict';

require('dotenv').config();
const axios     = require('axios');
const WebSocket = require('ws');

const CLIENT_ID    = process.env.DHAN_CLIENT_ID;
const ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN;
const REST_BASE    = 'https://api.dhan.co/v2';
const WS_URL       = 'wss://api-feed.dhan.co';

// NIFTY 50 index identifiers (same as config.js)
const SECURITY_ID      = '13';
const EXCHANGE_SEGMENT = 'IDX_I';

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✅ PASS  ${label}`);
  passed++;
}

function fail(label, err) {
  console.log(`  ❌ FAIL  ${label}`);
  console.log(`         ${err}`);
  failed++;
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(2, 54 - title.length))}`);
}

function dhanHeaders() {
  return {
    'access-token': ACCESS_TOKEN,
    'client-id':    CLIENT_ID,
    'Content-Type': 'application/json',
  };
}

// ── Guard ────────────────────────────────────────────────────────────────────

function checkCredentials() {
  section('Credentials');
  if (!CLIENT_ID)    { fail('DHAN_CLIENT_ID is set in .env',    'missing'); }
  else               { ok('DHAN_CLIENT_ID is set'); }
  if (!ACCESS_TOKEN) { fail('DHAN_ACCESS_TOKEN is set in .env', 'missing'); }
  else               { ok('DHAN_ACCESS_TOKEN is set'); }
  if (!CLIENT_ID || !ACCESS_TOKEN) {
    console.log('\n⛔  Missing credentials — set DHAN_CLIENT_ID and DHAN_ACCESS_TOKEN in .env\n');
    process.exit(1);
  }
}

// ── Test 1: REST Auth ────────────────────────────────────────────────────────

async function testAuth() {
  section('Test 1 — REST Auth (GET /v2/fundlimit)');
  try {
    const res = await axios.get(`${REST_BASE}/fundlimit`, {
      headers: dhanHeaders(),
      timeout: 10000,
    });
    if (res.status === 200) {
      ok(`HTTP 200 — authenticated`);
      const f = res.data;
      if (f.availabelBalance !== undefined || f.sodLimit !== undefined || f.availableBalance !== undefined) {
        const bal = f.availableBalance ?? f.availabelBalance ?? f.sodLimit ?? 'N/A';
        ok(`Fund data received — available balance: ₹${bal}`);
      } else {
        ok(`Fund data received (shape: ${Object.keys(f).join(', ')})`);
      }
    } else {
      fail(`HTTP ${res.status}`, `unexpected status`);
    }
  } catch (err) {
    const status = err.response?.status;
    const body   = JSON.stringify(err.response?.data || {}).slice(0, 200);
    fail('REST auth request', `HTTP ${status} — ${body || err.message}`);
  }
}

// ── Test 2: Historical Charts API ────────────────────────────────────────────

async function testHistorical() {
  section('Test 2 — Historical Charts (POST /v2/charts/historical)');
  try {
    const toDate   = new Date();
    // Fetch 5 days back to ensure we span enough market sessions for 15m candles
    const fromDate = new Date(toDate - 5 * 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);

    const res = await axios.post(
      `${REST_BASE}/charts/historical`,
      {
        securityId:      SECURITY_ID,
        exchangeSegment: EXCHANGE_SEGMENT,
        instrument:      'INDEX',
        expiryCode:      0,
        oi:              false,
        interval:        '15',   // 15-minute candles
        fromDate:        fmt(fromDate),
        toDate:          fmt(toDate),
      },
      { headers: dhanHeaders(), timeout: 15000 }
    );

    const d = res.data;
    if (!Array.isArray(d.timestamp) || d.timestamp.length === 0) {
      fail('Response has timestamp array', `Got: ${JSON.stringify(d).slice(0, 200)}`);
      return;
    }
    ok(`Response has ${d.timestamp.length} candle timestamps`);

    const required = ['open', 'high', 'low', 'close'];
    for (const field of required) {
      if (Array.isArray(d[field]) && d[field].length === d.timestamp.length) {
        ok(`Field '${field}' present (${d[field].length} values)`);
      } else {
        fail(`Field '${field}' present`, `missing or length mismatch`);
      }
    }

    // Spot-check last candle
    const last = d.timestamp.length - 1;
    const ts   = new Date(d.timestamp[last] * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const c    = d.close[last];
    ok(`Last candle: close=₹${c?.toFixed(2)} at ${ts} IST`);

    if (d.volume) {
      ok(`Volume data present (${d.volume[last]} on last candle)`);
    } else {
      console.log(`  ℹ️  INFO  Volume not included in response (normal for index)`);
    }

  } catch (err) {
    const status = err.response?.status;
    const body   = JSON.stringify(err.response?.data || {}).slice(0, 200);
    fail('Historical charts request', `HTTP ${status} — ${body || err.message}`);
  }
}

// ── Test 3: Option Chain API ─────────────────────────────────────────────────

async function testOptionChain() {
  section('Test 3a — Expiry List (POST /v2/optionchain/expirylist)');
  let expiry = null;

  try {
    const res = await axios.post(
      `${REST_BASE}/optionchain/expirylist`,
      { UnderlyingScrip: 13, UnderlyingSeg: EXCHANGE_SEGMENT },
      { headers: dhanHeaders(), timeout: 10000 }
    );

    const dates = res.data?.data;
    if (!Array.isArray(dates) || dates.length === 0) {
      fail('Expiry list has entries', `Got: ${JSON.stringify(res.data).slice(0, 200)}`);
      return;
    }
    ok(`${dates.length} expiry dates available`);
    expiry = dates[0]; // nearest active expiry
    ok(`Nearest expiry: ${expiry}`);
  } catch (err) {
    const status = err.response?.status;
    const body   = JSON.stringify(err.response?.data || {}).slice(0, 300);
    fail('Expiry list request', `HTTP ${status} — ${body || err.message}`);
    return;
  }

  section(`Test 3b — Option Chain (POST /v2/optionchain, expiry ${expiry})`);
  try {
    const res = await axios.post(
      `${REST_BASE}/optionchain`,
      {
        UnderlyingScrip: 13,          // int, not string
        UnderlyingSeg:   EXCHANGE_SEGMENT,
        Expiry:          expiry,
      },
      { headers: dhanHeaders(), timeout: 10000 }
    );

    const payload = res.data;
    if (payload.status !== 'success') {
      fail('status == success', `Got: ${JSON.stringify(payload).slice(0, 200)}`);
      return;
    }
    ok(`status: success`);

    // Underlying LTP
    const ltp = payload.data?.last_price;
    if (ltp > 0) {
      ok(`Underlying LTP: ₹${ltp}`);
    } else {
      fail('data.last_price > 0', `Got: ${ltp}`);
    }

    // OC object keyed by strike string e.g. "25650.000000"
    const oc = payload.data?.oc;
    if (!oc || typeof oc !== 'object') {
      fail('data.oc object present', `Got: ${typeof oc}`);
      return;
    }
    const strikes = Object.keys(oc);
    ok(`${strikes.length} strikes in option chain`);

    // Spot-check one strike
    const sampleStrike = strikes[Math.floor(strikes.length / 2)];
    const sampleData   = oc[sampleStrike];
    ok(`Sample strike: ${parseFloat(sampleStrike).toFixed(0)}`);

    if (sampleData.ce) {
      ok(`CE present — LTP: ₹${sampleData.ce.last_price}, OI: ${sampleData.ce.oi}, security_id: ${sampleData.ce.security_id}`);
      if (sampleData.ce.greeks) ok(`CE greeks present — delta: ${sampleData.ce.greeks.delta?.toFixed(4)}`);
      else console.log(`  ℹ️  INFO  CE greeks not present on this strike`);
    } else {
      console.log(`  ℹ️  INFO  CE not present on strike ${sampleStrike} (normal for deep OTM)`);
    }

    if (sampleData.pe) {
      ok(`PE present — LTP: ₹${sampleData.pe.last_price}, OI: ${sampleData.pe.oi}, security_id: ${sampleData.pe.security_id}`);
    } else {
      console.log(`  ℹ️  INFO  PE not present on strike ${sampleStrike}`);
    }

  } catch (err) {
    const status = err.response?.status;
    const body   = JSON.stringify(err.response?.data || {}).slice(0, 300);
    fail('Option chain request', `HTTP ${status} — ${body || err.message}`);
  }
}

// ── Test 4: WebSocket Live Feed ───────────────────────────────────────────────

function testWebSocket() {
  section('Test 4 — WebSocket Feed (10-second live tick test)');
  return new Promise((resolve) => {
    const url = `${WS_URL}?version=2&token=${ACCESS_TOKEN}&clientId=${CLIENT_ID}&authType=2`;
    const ws  = new WebSocket(url);
    let tickCount     = 0;
    let connected     = false;
    let timer;

    const done = () => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.terminate();
      resolve();
    };

    // 10-second window — outside market hours this will still connect but send 0 ticks
    timer = setTimeout(() => {
      if (!connected) {
        fail('WebSocket connected within 10s', 'timeout — no open event');
      } else if (tickCount === 0) {
        console.log(`  ℹ️  INFO  Connected but 0 ticks received (market may be closed — normal outside 09:15–15:30 IST)`);
        ok('WebSocket connected and subscription sent');
      } else {
        ok(`WebSocket connected and ${tickCount} TICKER packet(s) received`);
      }
      done();
    }, 10000);

    ws.on('open', () => {
      connected = true;
      ok('WebSocket open');

      const subscribe = {
        RequestCode:     15,
        InstrumentCount: 1,
        InstrumentList:  [{ ExchangeSegment: EXCHANGE_SEGMENT, SecurityId: SECURITY_ID }],
      };
      ws.send(JSON.stringify(subscribe));
      ok('Subscription message sent (RequestCode=15, NIFTY SecurityId=13)');
    });

    ws.on('message', (data) => {
      if (!Buffer.isBuffer(data)) return;
      const code = data.readUInt8(0);

      if (code === 2 && data.length >= 16) {         // TICKER
        const ltp = data.readFloatLE(8);
        const ltt = data.readInt32LE(12);
        tickCount++;
        const time = new Date(ltt * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
        ok(`TICKER packet: NIFTY ₹${ltp.toFixed(2)} at ${time} IST`);
        if (tickCount >= 3) done(); // 3 ticks is enough proof
      } else if (code === 6) {                        // PREV_CLOSE
        const prevClose = data.readFloatLE(8);
        console.log(`  ℹ️  INFO  PREV_CLOSE packet: ₹${prevClose.toFixed(2)}`);
      } else if (code === 50) {                       // DISCONNECT
        const reason = data.length >= 10 ? data.readInt16LE(8) : -1;
        fail('No server disconnect', `Disconnect packet received, reason code: ${reason}`);
        done();
      }
    });

    ws.on('ping', () => ws.pong());

    ws.on('error', (err) => {
      fail('WebSocket no error', err.message);
      done();
    });

    ws.on('close', (code, reason) => {
      if (!connected) {
        fail('WebSocket connected', `Closed before open: code=${code} reason=${reason.toString()}`);
        done();
      }
    });
  });
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║        Drishti — Dhan API Integration Tests         ║');
  console.log('╚══════════════════════════════════════════════════════╝');

  checkCredentials();
  await testAuth();
  await testHistorical();
  await testOptionChain();
  await testWebSocket();

  console.log('\n' + '═'.repeat(56));
  console.log(`  ${passed} passed   ${failed} failed`);
  console.log('═'.repeat(56));

  if (failed > 0) {
    console.log('\n⚠️  Fix the failures above before starting Block 2.\n');
    process.exit(1);
  } else {
    console.log('\n✅  All Dhan API surfaces verified — safe to start Block 2.\n');
  }
}

main().catch((err) => {
  console.error('\n[FATAL]', err.message);
  console.error(err.stack);
  process.exit(1);
});
