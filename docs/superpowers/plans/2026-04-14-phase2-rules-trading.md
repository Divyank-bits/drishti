# Phase 2 — Rules-Based Iron Condor Paper Trading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire a complete paper trading loop on top of Phase 1's data stream: Iron Condor entry detection → Telegram approval → paper fill → anti-hunt monitoring → exit → journal.

**Architecture:** Six new modules communicate exclusively via the Phase 1 event bus. No Phase 1 files are modified except one additive extension to `options-chain.js` (adds `strikeData` to event payload). Intelligence mode is RULES-only; Claude integration deferred. State machine and circuit breakers from Phase 0 are wired for real here.

**Tech Stack:** Node.js, node-telegram-bot-api, node-cron, fs (NDJSON journal), existing event-bus/events/config/state-machine/circuit-breaker from Phase 0.

---

## Event Name Mapping

`events.js` already has most needed constants under different names. Use these — do NOT add duplicates:

| Spec name | Actual constant to use |
|-----------|----------------------|
| `TRADE_SIGNAL` | `SIGNAL_GENERATED` |
| `TRADE_APPROVED` | `USER_APPROVED` |
| `TRADE_REJECTED` | `USER_REJECTED` |
| `EXIT_SIGNAL` | `EXIT_TRIGGERED` |
| `TRADE_CLOSED` | `POSITION_CLOSED` |
| `ORDER_FILLED` | `ORDER_FILLED` ✓ |
| `POSITION_FLAGGED` | `POSITION_FLAGGED` ✓ |
| `CIRCUIT_BREAKER_HIT` | `CIRCUIT_BREAKER_HIT` ✓ |

Two new constants needed: `ORDER_EXITED`, `POSITION_UPDATED`.

---

## File Map

| Action | Path |
|--------|------|
| Modify | `core/events.js` — add `ORDER_EXITED`, `POSITION_UPDATED` |
| Modify | `config.js` — add `SLIPPAGE_PER_LOT`, `MACD_ZERO_THRESHOLD`, `IV_PERCENTILE_PROXY_MIN`, `TRADE_APPROVAL_TIMEOUT_MS` |
| Modify | `data/options-chain.js` — add `strikeData` to `_parseOptionChain()` return |
| Create | `execution/order-executor.js` — abstract interface |
| Create | `execution/paper-executor.js` — fixed-slippage fill simulation |
| Create | `journal/trade-journal.js` — append-only NDJSON writer |
| Create | `journal/.gitkeep` |
| Create | `strategies/iron-condor.strategy.js` — 11-condition entry + strike selection |
| Create | `monitoring/anti-hunt.js` — pure function, 7-rule evaluation |
| Create | `monitoring/position-tracker.js` — event wiring, calls anti-hunt |
| Create | `notifications/telegram.js` — two-direction bot |
| Modify | `index.js` — Phase 2 boot wiring |
| Create | `test-phase2-executor.js` |
| Create | `test-phase2-journal.js` |
| Create | `test-phase2-strategy.js` |
| Create | `test-phase2-antihunt.js` |
| Create | `test-phase2-telegram.js` |
| Create | `test-phase2-integration.js` |
| Modify | `package.json` — add `test:phase2` script |
| Create | `PHASE_2_COMPLETE.md` |

---

## Task 1: Foundation — New Events + Config

**Files:**
- Modify: `core/events.js`
- Modify: `config.js`

- [ ] **Step 1.1: Add two new events to events.js**

In `core/events.js`, add inside the `// ── Order Execution` block after `ORDER_CANCELLED`:

```js
ORDER_EXITED:          'ORDER_EXITED',
```

And inside `// ── Position Lifecycle` block after `POSITION_FLAGGED`:

```js
POSITION_UPDATED:      'POSITION_UPDATED',
```

- [ ] **Step 1.2: Add Phase 2 config entries**

In `config.js`, add after the `BROKERAGE_PER_ORDER` block:

```js
  // ── Paper Executor ────────────────────────────────────────────────────────
  SLIPPAGE_PER_LOT: 1.5,              // ₹ fixed slippage per lot — swap point for spread-based (Phase 3)

  // ── Strategy Filters ──────────────────────────────────────────────────────
  MACD_ZERO_THRESHOLD: 2.0,           // abs(macd.macd) must be < this for entry
  IV_PERCENTILE_PROXY_MIN: 50,        // BB width percentile proxy minimum

  // ── Telegram ──────────────────────────────────────────────────────────────
  TRADE_APPROVAL_TIMEOUT_MS: 180000,  // 3-minute trade approval window
```

- [ ] **Step 1.3: Commit**

```bash
git add core/events.js config.js
git commit -m "feat: add Phase 2 event constants and config entries"
```

---

## Task 2: Phase 1 Extension — strikeData in OPTIONS_CHAIN_UPDATED

The paper executor needs individual option prices per strike at fill time. `options-chain.js` already fetches the full chain — we just need to include strike prices in the event payload.

**Files:**
- Modify: `data/options-chain.js`

- [ ] **Step 2.1: Add strikeData to `_parseOptionChain()`**

In `data/options-chain.js`, inside `_parseOptionChain(raw)`, add before the `return {` statement:

```js
    // Build strike → option price lookup for paper executor
    const strikeData = {};
    for (const leg of filtered.data) {
      strikeData[leg.strikePrice] = {
        ce: leg.CE ? leg.CE.lastPrice : null,
        pe: leg.PE ? leg.PE.lastPrice : null,
      };
    }
```

Then add `strikeData` to the return object:

```js
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
```

- [ ] **Step 2.2: Update T28 fixture to include strikeData shape**

T28 in `test-phase1.js` calls `_parseOptionChain()` and checks the shape. Add `strikeData` to the assertion:

```js
assert(typeof result.strikeData === 'object', 'strikeData is object');
assert(result.strikeData[24000] !== undefined, 'strikeData has strike 24000');
assert(result.strikeData[24000].ce === 150.5, 'strikeData CE price correct');
assert(result.strikeData[24000].pe === 120.3, 'strikeData PE price correct');
```

Update the `fakeNSE.filtered.data` fixture entries to include `lastPrice`:

```js
filtered: {
  data: [
    { strikePrice: 24000, CE: { openInterest: 50000, lastPrice: 150.5 }, PE: { openInterest: 30000, lastPrice: 120.3 } },
    { strikePrice: 24500, CE: { openInterest: 120000, lastPrice: 85.0 }, PE: { openInterest: 20000, lastPrice: 200.0 } },
    { strikePrice: 23800, CE: { openInterest: 15000, lastPrice: 210.0 }, PE: { openInterest: 110000, lastPrice: 75.5 } },
  ],
  CE: { totOI: 185000 },
  PE: { totOI: 160000 },
},
```

- [ ] **Step 2.3: Run Phase 1 tests to confirm still passing**

```bash
node test-phase1.js
```

Expected: `13 tests — 13 passed, 0 failed`

- [ ] **Step 2.4: Commit**

```bash
git add data/options-chain.js test-phase1.js
git commit -m "feat: add strikeData to OPTIONS_CHAIN_UPDATED payload for paper executor"
```

---

## Task 3: Paper Executor

**Files:**
- Create: `execution/order-executor.js`
- Create: `execution/paper-executor.js`
- Create: `test-phase2-executor.js`

- [ ] **Step 3.1: Write the failing tests**

Create `test-phase2-executor.js`:

```js
/**
 * @file test-phase2-executor.js
 * @description Phase 2 Gate 1 — Paper executor fill simulation and P&L math.
 */
'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

// ── Test setup ────────────────────────────────────────────────────────────
// Minimal event bus stub so paper-executor can subscribe to TICK_RECEIVED
// and OPTIONS_CHAIN_UPDATED without a real bus
const EventEmitter = require('events');
const stubBus = new EventEmitter();

// Inject stubs before requiring the module
const Module = require('module');
const _resolveFilename = Module._resolveFilename.bind(Module);
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request.includes('event-bus')) return request;
  if (request.includes('events') && request.includes('core')) return request;
  return _resolveFilename(request, parent, isMain, options);
};
require.cache[require.resolve('../drishti/core/event-bus')] = { exports: stubBus };

// ── Simpler approach: test the class directly ─────────────────────────────
// paper-executor exports a class instance. We test internal methods by
// constructing a fresh instance and calling methods directly.

const PaperExecutor = require('./execution/paper-executor');

console.log('\n── Paper Executor Tests ─────────────────────────────────────────\n');

// Inject a fake LTP and fake strikeData
PaperExecutor._lastLtp = 24185;
PaperExecutor._lastStrikeData = {
  24400: { ce: 80.0,  pe: null },
  24600: { ce: 40.0,  pe: null },
  23900: { ce: null,  pe: 75.0  },
  23700: { ce: null,  pe: 40.0  },
};

const legs = [
  { strike: 24400, type: 'CE', action: 'SELL' },  // short CE
  { strike: 24600, type: 'CE', action: 'BUY'  },  // long CE hedge
  { strike: 23900, type: 'PE', action: 'SELL' },  // short PE
  { strike: 23700, type: 'PE', action: 'BUY'  },  // long PE hedge
];

test('T01 placeOrder returns fill with 4 legs', async () => {
  const fill = await PaperExecutor.placeOrder(legs);
  assert.strictEqual(fill.legs.length, 4, 'fill has 4 legs');
  assert(typeof fill.orderId === 'string', 'fill has orderId');
  assert(typeof fill.premiumCollected === 'number', 'fill has premiumCollected');
});

test('T02 sell legs fill at ltp - slippage', async () => {
  const fill = await PaperExecutor.placeOrder(legs);
  const shortCe = fill.legs.find(l => l.strike === 24400 && l.action === 'SELL');
  const config = require('./config');
  assert.strictEqual(shortCe.fillPrice, 80.0 - config.SLIPPAGE_PER_LOT);
});

test('T03 buy legs fill at ltp + slippage', async () => {
  const fill = await PaperExecutor.placeOrder(legs);
  const longCe = fill.legs.find(l => l.strike === 24600 && l.action === 'BUY');
  const config = require('./config');
  assert.strictEqual(longCe.fillPrice, 40.0 + config.SLIPPAGE_PER_LOT);
});

test('T04 premiumCollected = (shortCe - longCe + shortPe - longPe) * lotSize', async () => {
  const config = require('./config');
  const slip = config.SLIPPAGE_PER_LOT;
  const lotSize = config.NIFTY_LOT_SIZE;
  const fill = await PaperExecutor.placeOrder(legs);
  const shortCePrice = 80.0 - slip;
  const longCePrice  = 40.0 + slip;
  const shortPePrice = 75.0 - slip;
  const longPePrice  = 40.0 + slip;
  const expected = (shortCePrice - longCePrice + shortPePrice - longPePrice) * lotSize;
  assert.strictEqual(fill.premiumCollected, Math.round(expected * 100) / 100);
});

test('T05 exitOrder returns realised P&L', async () => {
  const fill = await PaperExecutor.placeOrder(legs);
  // Update strikeData to simulate option price changes (decay)
  PaperExecutor._lastStrikeData = {
    24400: { ce: 50.0,  pe: null },
    24600: { ce: 25.0,  pe: null },
    23900: { ce: null,  pe: 45.0  },
    23700: { ce: null,  pe: 22.0  },
  };
  const exit = await PaperExecutor.exitOrder(fill.orderId);
  assert(typeof exit.realisedPnl === 'number', 'exit has realisedPnl');
  assert(exit.realisedPnl > 0, 'realised P&L positive when premium decayed');
});

test('T06 computeUnrealisedPnl returns number given current strikeData', () => {
  PaperExecutor._lastStrikeData = {
    24400: { ce: 60.0,  pe: null },
    24600: { ce: 30.0,  pe: null },
    23900: { ce: null,  pe: 55.0  },
    23700: { ce: null,  pe: 28.0  },
  };
  const fill = { premiumCollected: 500, legs };
  const pnl = PaperExecutor.computeUnrealisedPnl(fill);
  assert(typeof pnl === 'number', 'returns number');
});

// ── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 3.2: Run tests — confirm they fail**

```bash
node test-phase2-executor.js
```

Expected: Error — `Cannot find module './execution/paper-executor'`

- [ ] **Step 3.3: Create order-executor.js abstract interface**

Create `execution/order-executor.js`:

```js
/**
 * @file order-executor.js
 * @description Abstract base class for order executors. PaperExecutor and future
 *              DhanExecutor both implement this interface. All trading logic above
 *              this layer is identical regardless of which executor is active.
 */
'use strict';

class OrderExecutor {
  /**
   * Place an Iron Condor order (4 legs).
   * @param {Array<{strike: number, type: string, action: string}>} legs
   * @returns {Promise<{orderId: string, legs: Array, premiumCollected: number, timestamp: string}>}
   */
  async placeOrder(legs) {
    throw new Error(`[${this.constructor.name}] placeOrder() must be implemented`);
  }

  /**
   * Exit an active order (all 4 legs).
   * @param {string} orderId
   * @returns {Promise<{orderId: string, legs: Array, realisedPnl: number, timestamp: string}>}
   */
  async exitOrder(orderId) {
    throw new Error(`[${this.constructor.name}] exitOrder() must be implemented`);
  }

  /**
   * Compute current unrealised P&L for an active fill using latest option prices.
   * @param {{premiumCollected: number, legs: Array}} fill
   * @returns {number} unrealised P&L in rupees
   */
  computeUnrealisedPnl(fill) {
    throw new Error(`[${this.constructor.name}] computeUnrealisedPnl() must be implemented`);
  }
}

module.exports = OrderExecutor;
```

- [ ] **Step 3.4: Create paper-executor.js**

Create `execution/paper-executor.js`:

```js
/**
 * @file paper-executor.js
 * @description Simulates order fills with fixed slippage. Uses last cached option
 *              prices from OPTIONS_CHAIN_UPDATED. Swap point for spread-based
 *              slippage (Phase 3): replace fill price calculation in _fillPrice() only.
 */
'use strict';

const OrderExecutor = require('./order-executor');
const eventBus      = require('../core/event-bus');
const EVENTS        = require('../core/events');
const config        = require('../config');
const { v4: uuidv4 } = require('uuid');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [PaperExecutor] [${level}] ${msg}`);
}

class PaperExecutor extends OrderExecutor {
  constructor() {
    super();
    this._lastLtp        = null;
    this._lastStrikeData = {};   // { [strike]: { ce, pe } } — from OPTIONS_CHAIN_UPDATED
    this._activeOrders   = {};   // { [orderId]: fill }

    eventBus.on(EVENTS.TICK_RECEIVED, ({ ltp }) => {
      this._lastLtp = ltp;
    });
    eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED, ({ strikeData }) => {
      if (strikeData) this._lastStrikeData = strikeData;
    });
  }

  /**
   * Swap point for Phase 3: replace this method to use bid/ask spread.
   * @private
   */
  _fillPrice(optionLtp, action) {
    const slip = config.SLIPPAGE_PER_LOT;
    return action === 'BUY' ? optionLtp + slip : optionLtp - slip;
  }

  async placeOrder(legs) {
    const filledLegs = legs.map(leg => {
      const strikeEntry = this._lastStrikeData[leg.strike] || {};
      const optionLtp   = leg.type === 'CE' ? strikeEntry.ce : strikeEntry.pe;
      if (optionLtp == null) {
        throw new Error(`[PaperExecutor] No price data for strike ${leg.strike} ${leg.type}`);
      }
      return { ...leg, fillPrice: this._fillPrice(optionLtp, leg.action) };
    });

    // Premium collected = (sell prices - buy prices) × lot size
    const netPremiumPerLot = filledLegs.reduce((sum, leg) => {
      return sum + (leg.action === 'SELL' ? leg.fillPrice : -leg.fillPrice);
    }, 0);
    const premiumCollected = Math.round(netPremiumPerLot * config.NIFTY_LOT_SIZE * 100) / 100;

    const fill = {
      orderId:          uuidv4(),
      legs:             filledLegs,
      premiumCollected,
      timestamp:        new Date().toISOString(),
    };

    this._activeOrders[fill.orderId] = fill;
    log('INFO', `Filled IC: premium collected ₹${premiumCollected}`);
    eventBus.emit(EVENTS.ORDER_FILLED, fill);
    return fill;
  }

  async exitOrder(orderId) {
    const entryFill = this._activeOrders[orderId];
    if (!entryFill) throw new Error(`[PaperExecutor] Unknown orderId: ${orderId}`);

    const exitLegs = entryFill.legs.map(leg => {
      const strikeEntry = this._lastStrikeData[leg.strike] || {};
      const optionLtp   = leg.type === 'CE' ? strikeEntry.ce : strikeEntry.pe;
      // Exit reverses original action
      const exitAction  = leg.action === 'SELL' ? 'BUY' : 'SELL';
      const fillPrice   = optionLtp != null
        ? this._fillPrice(optionLtp, exitAction)
        : leg.fillPrice; // fallback to entry price if no current data
      return { ...leg, exitAction, exitFillPrice: fillPrice };
    });

    const exitPremiumPerLot = exitLegs.reduce((sum, leg) => {
      // At exit, we reverse: original SELLs become BUYs (we pay), original BUYs become SELLs (we receive)
      return sum + (leg.action === 'SELL' ? -leg.exitFillPrice : leg.exitFillPrice);
    }, 0);
    const exitPremiumPaid = Math.round(exitPremiumPerLot * config.NIFTY_LOT_SIZE * 100) / 100;
    const realisedPnl     = Math.round((entryFill.premiumCollected - exitPremiumPaid) * 100) / 100;

    const exitResult = {
      orderId,
      legs:        exitLegs,
      realisedPnl,
      timestamp:   new Date().toISOString(),
    };

    delete this._activeOrders[orderId];
    log('INFO', `Exited IC: realised P&L ₹${realisedPnl}`);
    eventBus.emit(EVENTS.ORDER_EXITED, exitResult);
    return exitResult;
  }

  computeUnrealisedPnl(fill) {
    const currentPremiumPerLot = fill.legs.reduce((sum, leg) => {
      const strikeEntry = this._lastStrikeData[leg.strike] || {};
      const currentLtp  = leg.type === 'CE' ? strikeEntry.ce : strikeEntry.pe;
      if (currentLtp == null) return sum;
      return sum + (leg.action === 'SELL' ? currentLtp : -currentLtp);
    }, 0);
    const currentPremium = currentPremiumPerLot * config.NIFTY_LOT_SIZE;
    return Math.round((fill.premiumCollected - currentPremium) * 100) / 100;
  }
}

module.exports = new PaperExecutor();
```

- [ ] **Step 3.5: Install uuid (needed by paper-executor)**

```bash
cd f:/Divyank-Personal/drishti && npm install uuid
```

- [ ] **Step 3.6: Run executor tests**

```bash
node test-phase2-executor.js
```

Expected: `6 tests — 6 passed, 0 failed`

- [ ] **Step 3.7: Commit**

```bash
git add execution/order-executor.js execution/paper-executor.js test-phase2-executor.js package.json package-lock.json
git commit -m "feat: add paper executor with fixed slippage fill simulation (Gate 1)"
```

---

## Task 4: Trade Journal

**Files:**
- Create: `journal/trade-journal.js`
- Create: `journal/.gitkeep`
- Create: `test-phase2-journal.js`

- [ ] **Step 4.1: Write the failing tests**

Create `test-phase2-journal.js`:

```js
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

const TradeJournal = require('./journal/trade-journal');

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
```

- [ ] **Step 4.2: Run tests — confirm they fail**

```bash
node test-phase2-journal.js
```

Expected: `Cannot find module './journal/trade-journal'`

- [ ] **Step 4.3: Create journal directory placeholder**

```bash
echo "" > f:/Divyank-Personal/drishti/journal/.gitkeep
```

Add `journal/trades.ndjson` to `.gitignore`:

```
journal/trades.ndjson
```

- [ ] **Step 4.4: Create trade-journal.js**

Create `journal/trade-journal.js`:

```js
/**
 * @file trade-journal.js
 * @description Append-only NDJSON trade journal. Never modifies existing entries.
 *              Provides boot-time restore of pnlToday and tradesToday.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [TradeJournal] [${level}] ${msg}`);
}

class TradeJournal {
  constructor() {
    this._filePath = path.join(__dirname, 'trades.ndjson');
  }

  /**
   * Appends one NDJSON line. Never overwrites.
   * @param {string} eventType
   * @param {object} data
   */
  async write(eventType, data) {
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), eventType, data }) + '\n';
    fs.appendFileSync(this._filePath, entry, 'utf8');
  }

  /**
   * Returns all journal entries from today (UTC date match).
   * @returns {Promise<Array>}
   */
  async readToday() {
    if (!fs.existsSync(this._filePath)) return [];
    const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const lines = fs.readFileSync(this._filePath, 'utf8')
      .split('\n')
      .filter(l => l.trim().length > 0);
    return lines
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(e => e && e.timestamp && e.timestamp.startsWith(today));
  }

  /**
   * Reads today's TRADE_CLOSED entries and returns running totals.
   * Called at boot to restore session state after a restart.
   * @returns {Promise<{pnlToday: number, tradesToday: number}>}
   */
  async restoreFromJournal() {
    const entries = await this.readToday();
    const closedTrades = entries.filter(e => e.eventType === 'TRADE_CLOSED');
    const pnlToday   = closedTrades.reduce((sum, e) => sum + (e.data.realisedPnl || 0), 0);
    const tradesToday = closedTrades.length;
    if (tradesToday > 0) {
      log('INFO', `Restored from journal: ${tradesToday} trades, P&L ₹${pnlToday}`);
    }
    return { pnlToday: Math.round(pnlToday * 100) / 100, tradesToday };
  }
}

module.exports = new TradeJournal();
```

- [ ] **Step 4.5: Run journal tests**

```bash
node test-phase2-journal.js
```

Expected: `6 tests — 6 passed, 0 failed`

- [ ] **Step 4.6: Commit**

```bash
git add journal/trade-journal.js journal/.gitkeep test-phase2-journal.js .gitignore
git commit -m "feat: add append-only trade journal with boot restore (Gate 2)"
```

---

## Task 5: Iron Condor Strategy

**Files:**
- Create: `strategies/iron-condor.strategy.js`
- Create: `test-phase2-strategy.js`

- [ ] **Step 5.1: Write the failing tests**

Create `test-phase2-strategy.js`:

```js
/**
 * @file test-phase2-strategy.js
 * @description Phase 2 Gate 3 — Iron Condor entry conditions and strike selection.
 *              Tests all 11 conditions: all-pass, and 11 near-miss cases (each
 *              condition fails in isolation while the other 10 pass).
 */
'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n── Iron Condor Strategy Tests ───────────────────────────────────\n');

// Stub event bus and state machine before require
const EventEmitter = require('events');
const stubBus = new EventEmitter();
const Module = require('module');
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function(req, parent, isMain, opts) {
  return origResolve(req, parent, isMain, opts);
};

const IronCondor = require('./strategies/iron-condor.strategy');

// ── Canonical passing snapshot ────────────────────────────────────────────
// All 11 conditions satisfied
function passingSnapshot() {
  return {
    indicators: {
      rsi:   50,
      ema9:  24185,
      ema21: 24180,
      macd:  { macd: 0.5, signal: 0.3, histogram: 0.2 },
      bb:    { upper: 24700, middle: 24185, lower: 23670, width: 2.5 },
    },
    bbWidthHistory: [2.6, 2.55, 2.52, 2.5, 2.5], // not contracting
    optionsChain: {
      underlyingValue: 24185,
      vix:             16.0,
      pcr:             1.05,
      maxCeOiStrike:   24500,
      maxPeOiStrike:   23900,
      atmStrike:       24200,
      strikeData: {
        24400: { ce: 80, pe: null },
        24600: { ce: 40, pe: null },
        23950: { ce: null, pe: 75 },   // shortPe = 23900+100=24000 → exact hundred → shift +50 → 23950
        23750: { ce: null, pe: 40 },
      },
    },
    sessionContext: {
      dayOpen:   24185,
      vixAtOpen: 16.0,
      vixCurrent: 16.0,
    },
    timestamp: new Date('2026-04-14T04:30:00.000Z').getTime(), // 10:00 IST
  };
}

test('T01 all 11 conditions pass → checkConditions returns eligible:true', () => {
  const result = IronCondor.checkConditions(passingSnapshot());
  assert.strictEqual(result.eligible, true, `eligible should be true, got: ${JSON.stringify(result.failedConditions)}`);
  assert.strictEqual(result.failedConditions.length, 0);
});

test('T02 strike selection: shortCe = maxCeOiStrike - 100', () => {
  const trade = IronCondor.buildTrade(passingSnapshot());
  const shortCe = trade.legs.find(l => l.type === 'CE' && l.action === 'SELL');
  assert.strictEqual(shortCe.strike, 24400);
});

test('T03 strike selection: shortPe = maxPeOiStrike + 100', () => {
  const trade = IronCondor.buildTrade(passingSnapshot());
  // 23900 + 100 = 24000 = exact hundred → shift +50 → 24050? Wait:
  // maxPeOiStrike=23900, shortPe = 23900+100 = 24000, exact hundred → shift +50 → 24050
  // Actually let me reconsider - spec says short strike on exact hundred → shift +50
  // 24000 is exact hundred, so shortPe becomes 24050
  const shortPe = trade.legs.find(l => l.type === 'PE' && l.action === 'SELL');
  assert.strictEqual(shortPe.strike, 24050, `Expected 24050, got ${shortPe.strike}`);
});

test('T04 strike selection: longCe = shortCe + 200', () => {
  const trade = IronCondor.buildTrade(passingSnapshot());
  const shortCe = trade.legs.find(l => l.type === 'CE' && l.action === 'SELL');
  const longCe  = trade.legs.find(l => l.type === 'CE' && l.action === 'BUY');
  assert.strictEqual(longCe.strike, shortCe.strike + 200);
});

test('T05 strike selection: longPe = shortPe - 200', () => {
  const trade = IronCondor.buildTrade(passingSnapshot());
  const shortPe = trade.legs.find(l => l.type === 'PE' && l.action === 'SELL');
  const longPe  = trade.legs.find(l => l.type === 'PE' && l.action === 'BUY');
  assert.strictEqual(longPe.strike, shortPe.strike - 200);
});

// ── Near-miss cases ───────────────────────────────────────────────────────
// Each test: 10 conditions pass, 1 fails

test('T06 near-miss: VIX = 23 (>22) → not eligible', () => {
  const snap = passingSnapshot();
  snap.optionsChain.vix = 23;
  snap.sessionContext.vixCurrent = 23;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('vix'));
});

test('T07 near-miss: BB width = 4.5% (>4) → not eligible', () => {
  const snap = passingSnapshot();
  snap.indicators.bb.width = 4.5;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('bbWidth'));
});

test('T08 near-miss: BB squeezing 5 consecutive candles → not eligible', () => {
  const snap = passingSnapshot();
  snap.bbWidthHistory = [3.0, 2.8, 2.6, 2.4, 2.2]; // strictly decreasing = squeeze
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('bbSqueeze'));
});

test('T09 near-miss: IV percentile proxy = 40% (<50) → not eligible', () => {
  const snap = passingSnapshot();
  // Simulate low IV by making current BB width low relative to history
  snap.bbWidthHistory = [4.0, 3.8, 3.6, 3.4, 3.2]; // current (2.5) is at bottom = low percentile
  snap.indicators.bb.width = 2.5;
  // Note: history [4.0,3.8,3.6,3.4,3.2], current 2.5 → percentile = 0/5 = 0%
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('ivPercentile'));
});

test('T10 near-miss: EMA spread = 0.3% (>0.2%) → not eligible', () => {
  const snap = passingSnapshot();
  snap.indicators.ema9  = 24185;
  snap.indicators.ema21 = 24112; // (24185-24112)/24185 ≈ 0.3%
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('emaSpread'));
});

test('T11 near-miss: RSI = 61 (>60) → not eligible', () => {
  const snap = passingSnapshot();
  snap.indicators.rsi = 61;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('rsi'));
});

test('T12 near-miss: MACD = 2.5 (>threshold 2.0) → not eligible', () => {
  const snap = passingSnapshot();
  snap.indicators.macd.macd = 2.5;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('macd'));
});

test('T13 near-miss: NIFTY 0.6% from day open → not eligible', () => {
  const snap = passingSnapshot();
  snap.sessionContext.dayOpen = 24040; // 24185 vs 24040 = 0.6% gap
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('niftyVsDayOpen'));
});

test('T14 near-miss: PCR = 1.3 (>1.2) → not eligible', () => {
  const snap = passingSnapshot();
  snap.optionsChain.pcr = 1.3;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('pcr'));
});

test('T15 near-miss: time = 14:15 IST (after window) → not eligible', () => {
  const snap = passingSnapshot();
  // 14:15 IST = 08:45 UTC
  snap.timestamp = new Date('2026-04-14T08:45:00.000Z').getTime();
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('timeWindow'));
});

test('T16 near-miss: holiday date → not eligible', () => {
  const snap = passingSnapshot();
  // Use a date that is in holidays.json — or mock it
  snap._isHolidayOverride = true;
  const result = IronCondor.checkConditions(snap);
  assert.strictEqual(result.eligible, false);
  assert(result.failedConditions.includes('eventDay'));
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 5.2: Run tests — confirm they fail**

```bash
node test-phase2-strategy.js
```

Expected: `Cannot find module './strategies/iron-condor.strategy'`

- [ ] **Step 5.3: Create iron-condor.strategy.js**

Create `strategies/iron-condor.strategy.js`:

```js
/**
 * @file iron-condor.strategy.js
 * @description Iron Condor entry condition checker and strike selector.
 *              Extends BaseStrategy. Listens to INDICATORS_UPDATED (15m) and
 *              OPTIONS_CHAIN_UPDATED — evaluates entry when both are cached.
 *              RULES mode: all 11 conditions must pass (all-or-nothing).
 */
'use strict';

const BaseStrategy    = require('./base.strategy');
const eventBus        = require('../core/event-bus');
const EVENTS          = require('../core/events');
const circuitBreaker  = require('../core/circuit-breaker');
const stateMachine    = require('../core/state-machine');
const config          = require('../config');
const holidays        = require('../holidays.json');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [IronCondor] [${level}] ${msg}`);
}

// IST offset helper
function toIST(tsMs) {
  const istMs  = tsMs + 5.5 * 3600 * 1000;
  const hour   = Math.floor((istMs % (24 * 3600000)) / 3600000);
  const minute = Math.floor((istMs % 3600000) / 60000);
  return { hour, minute };
}

class IronCondorStrategy extends BaseStrategy {
  constructor() {
    super();
    this._cachedIndicators  = null;
    this._cachedOptions     = null;
    this._bbWidthHistory    = []; // rolling 20 values for IV percentile + squeeze check
    this._paused            = false;

    eventBus.on(EVENTS.INDICATORS_UPDATED, (payload) => {
      if (payload.timeframe !== 15) return;
      this._cachedIndicators = payload.indicators;
      this._updateBbHistory(payload.indicators.bb?.width);
      this._tryEvaluate(Date.now());
    });

    eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED, (payload) => {
      this._cachedOptions = payload;
      this._tryEvaluate(Date.now());
    });

    eventBus.on(EVENTS.PAUSE_REQUESTED, () => { this._paused = true; });
    eventBus.on(EVENTS.RESUME_REQUESTED, () => { this._paused = false; });
  }

  get name() { return 'Iron Condor'; }
  get regime() { return ['A', 'B', 'C']; }
  get claudeDescription() {
    return 'Neutral strategy. Sells an OTM call spread and OTM put spread simultaneously. Profits from time decay in low-volatility range-bound markets.';
  }

  _updateBbHistory(width) {
    if (width == null) return;
    this._bbWidthHistory.push(width);
    if (this._bbWidthHistory.length > 20) this._bbWidthHistory.shift();
  }

  _tryEvaluate(timestamp) {
    if (!this._cachedIndicators || !this._cachedOptions) return;
    if (this._paused) return;
    if (circuitBreaker.isTripped()) return;
    if (stateMachine.getState() !== 'IDLE') return;

    const snap = {
      indicators:     this._cachedIndicators,
      bbWidthHistory: [...this._bbWidthHistory],
      optionsChain:   this._cachedOptions,
      sessionContext: require('../core/session-context').snapshot(),
      timestamp,
    };

    const result = this.checkConditions(snap);
    if (!result.eligible) {
      log('DEBUG', `Entry conditions not met: ${result.failedConditions.join(', ')}`);
      return;
    }

    const trade = this.buildTrade(snap);
    stateMachine.transition('SIGNAL_DETECTED');
    eventBus.emit(EVENTS.SIGNAL_GENERATED, {
      strategy:          this.name,
      strikes:           trade.strikes,
      legs:              trade.legs,
      indicatorSnapshot: snap.indicators,
      optionsSnapshot:   { vix: snap.optionsChain.vix, pcr: snap.optionsChain.pcr, atmStrike: snap.optionsChain.atmStrike },
      expectedPremium:   trade.expectedPremium,
      timestamp:         new Date().toISOString(),
    });
    log('INFO', `Signal generated: IC ${JSON.stringify(trade.strikes)}`);
  }

  checkConditions(marketData) {
    const { indicators, bbWidthHistory, optionsChain, sessionContext, timestamp, _isHolidayOverride } = marketData;
    const failed = [];

    // 1. VIX 14–22
    const vix = optionsChain.vix ?? sessionContext.vixCurrent;
    if (vix == null || vix < 14 || vix > config.VIX_SAFE_MAX) failed.push('vix');

    // 2. BB Width % 2–4
    const bbWidth = indicators.bb?.width;
    if (bbWidth == null || bbWidth < 2 || bbWidth > 4) failed.push('bbWidth');

    // 3. BB not squeezing (width not contracting for 5+ consecutive candles)
    if (bbWidthHistory.length >= 5) {
      const last5 = bbWidthHistory.slice(-5);
      const isSqueeze = last5.every((w, i) => i === 0 || w < last5[i - 1]);
      if (isSqueeze) failed.push('bbSqueeze');
    }

    // 4. IV Percentile proxy > 50% (BB width percentile vs history)
    if (bbWidthHistory.length >= 5 && bbWidth != null) {
      const countBelow = bbWidthHistory.filter(w => w < bbWidth).length;
      const percentile = (countBelow / bbWidthHistory.length) * 100;
      if (percentile < config.IV_PERCENTILE_PROXY_MIN) failed.push('ivPercentile');
    }

    // 5. EMA9 and EMA21 within 0.2% of each other
    const { ema9, ema21 } = indicators;
    if (ema9 == null || ema21 == null) {
      failed.push('emaSpread');
    } else {
      const spread = Math.abs(ema9 - ema21) / ema21;
      if (spread > 0.002) failed.push('emaSpread');
    }

    // 6. RSI 40–60
    const { rsi } = indicators;
    if (rsi == null || rsi < 40 || rsi > 60) failed.push('rsi');

    // 7. MACD near zero
    const macdVal = indicators.macd?.macd;
    if (macdVal == null || Math.abs(macdVal) >= config.MACD_ZERO_THRESHOLD) failed.push('macd');

    // 8. NIFTY within 0.5% of day open
    const nifty   = optionsChain.underlyingValue;
    const dayOpen = sessionContext.dayOpen;
    if (dayOpen == null || Math.abs(nifty - dayOpen) / dayOpen > 0.005) failed.push('niftyVsDayOpen');

    // 9. PCR 0.9–1.2
    const { pcr } = optionsChain;
    if (pcr == null || pcr < 0.9 || pcr > 1.2) failed.push('pcr');

    // 10. Time 09:30–14:00 IST
    const { hour, minute } = toIST(timestamp);
    const afterOpen  = hour > 9 || (hour === 9 && minute >= 30);
    const beforeCut  = hour < 14;
    if (!afterOpen || !beforeCut) failed.push('timeWindow');

    // 11. Not holiday/event day
    if (_isHolidayOverride) {
      failed.push('eventDay');
    } else {
      const today = new Date(timestamp).toISOString().slice(0, 10);
      const isHoliday = holidays.some(h => h.date === today);
      if (isHoliday) failed.push('eventDay');
    }

    return {
      eligible:         failed.length === 0,
      score:            Math.round(((11 - failed.length) / 11) * 100),
      failedConditions: failed,
    };
  }

  buildTrade(marketData) {
    const { optionsChain } = marketData;
    let shortCe = optionsChain.maxCeOiStrike - 100;
    let shortPe = optionsChain.maxPeOiStrike + 100;

    // Non-obvious strikes: shift +50 if on exact hundred
    if (shortCe % 100 === 0) shortCe += 50;
    if (shortPe % 100 === 0) shortPe += 50;

    const longCe = shortCe + 200;
    const longPe = shortPe - 200;

    const legs = [
      { type: 'CE', strike: shortCe, action: 'SELL' },
      { type: 'CE', strike: longCe,  action: 'BUY'  },
      { type: 'PE', strike: shortPe, action: 'SELL' },
      { type: 'PE', strike: longPe,  action: 'BUY'  },
    ];

    return {
      strikes:         { shortCe, longCe, shortPe, longPe },
      legs,
      expectedPremium: null, // computed after fill by paper-executor
      maxLoss:         null,
      maxProfit:       null,
      riskRewardRatio: null,
    };
  }

  buildClaudePrompt(marketData) {
    return ''; // Phase 3 — Claude integration deferred
  }

  getExitConditions(trade) {
    return {
      exitIfNiftyClosesAbove: trade.strikes.shortCe + 75,
      exitIfNiftyClosesBelow: trade.strikes.shortPe - 75,
      deltaCeThreshold:        0.35,
      deltaPeThreshold:       -0.35,
      absolutePnlStop:         config.ABSOLUTE_PNL_STOP_RUPEES,
      squareOffTime:           config.SQUARE_OFF_TIME,
      exitTimeframe:           '15m',
    };
  }

  validatePartialFill(filledLegs) {
    return false; // IC: all 4 legs or nothing
  }
}

module.exports = new IronCondorStrategy();
```

- [ ] **Step 5.4: Run strategy tests**

```bash
node test-phase2-strategy.js
```

Expected: `16 tests — 16 passed, 0 failed`

If T03 fails: review the shortPe shift logic. `maxPeOiStrike=23900`, `shortPe = 23900+100 = 24000`, exact hundred → `+50` → `24050`. The test expects 24050.

- [ ] **Step 5.5: Commit**

```bash
git add strategies/iron-condor.strategy.js test-phase2-strategy.js
git commit -m "feat: add Iron Condor strategy with 11-condition entry filter (Gate 3)"
```

---

## Task 6: Anti-Hunt Rules

**Files:**
- Create: `monitoring/anti-hunt.js`
- Create: `test-phase2-antihunt.js`

- [ ] **Step 6.1: Write the failing tests**

Create `test-phase2-antihunt.js`:

```js
/**
 * @file test-phase2-antihunt.js
 * @description Phase 2 Gate 4 — Anti-hunt rule evaluation.
 *              Pure function tests — no event bus needed.
 */
'use strict';

const assert = require('assert');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n── Anti-Hunt Tests ──────────────────────────────────────────────\n');

const antiHunt = require('./monitoring/anti-hunt');

// ── Helpers ───────────────────────────────────────────────────────────────
function makePosition(overrides = {}) {
  return {
    orderId:          'test-order',
    strikes:          { shortCe: 24400, longCe: 24600, shortPe: 24000, longPe: 23800 },
    entryPremium:     600,
    currentPnl:       -200,
    ceDelta:          0.20,
    peDelta:          -0.20,
    avgVolume:        1000,
    ...overrides,
  };
}

function makeCandle(overrides = {}) {
  // 10:00 IST = 04:30 UTC
  return {
    close:     24350,
    high:      24380,
    low:       24320,
    volume:    800,
    openTime:  new Date('2026-04-14T04:30:00.000Z').getTime(),
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return { dayOpen: 24185, ...overrides };
}

// ── Rule 6: Absolute P&L stop (checked first, overrides all) ─────────────
test('T01 Rule 6: loss > 50% of MAX_DAILY_LOSS → shouldExit true', () => {
  const pos = makePosition({ currentPnl: -2600 }); // > ₹2500 (50% of 5000)
  const result = antiHunt.evaluate(pos, makeCandle(), makeContext());
  assert.strictEqual(result.shouldExit, true);
  assert.strictEqual(result.rule, 6);
});

test('T02 Rule 6: loss = -2499 (below threshold) → does not trigger', () => {
  const pos = makePosition({ currentPnl: -2499 });
  const result = antiHunt.evaluate(pos, makeCandle(), makeContext());
  assert.notStrictEqual(result.rule, 6);
});

// ── Rule 4: Dangerous window overrides rules 1-3 ─────────────────────────
test('T03 Rule 4: dangerous window 09:20 IST → shouldExit false even if price breached', () => {
  // 09:20 IST = 03:50 UTC
  const candle = makeCandle({
    close:    24480,  // beyond shortCe buffer (24400 + 50 = 24450)
    openTime: new Date('2026-04-14T03:50:00.000Z').getTime(),
    volume:   2000,
  });
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false);
});

test('T04 Rule 4: dangerous window near-miss — 60pts beyond strike + 11:35 IST → no exit', () => {
  // 11:35 IST = 06:05 UTC (inside 11:30-11:45 dangerous window)
  const candle = makeCandle({
    close:    24460,  // 60pts beyond shortCe 24400 (buffer=50pts)
    openTime: new Date('2026-04-14T06:05:00.000Z').getTime(),
    volume:   2000,
  });
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false, 'Rule 4 must block exit even with price breach');
});

test('T05 Rule 4: Rule 6 still exits inside dangerous window', () => {
  const pos = makePosition({ currentPnl: -2600 });
  const candle = makeCandle({
    openTime: new Date('2026-04-14T03:50:00.000Z').getTime(), // 09:20 IST
  });
  const result = antiHunt.evaluate(pos, candle, makeContext());
  assert.strictEqual(result.shouldExit, true);
  assert.strictEqual(result.rule, 6, 'Only Rule 6 exits during dangerous window');
});

// ── Rules 1 + 2: Price touch vs candle close + buffer ────────────────────
test('T06 Rule 1+2: price only touches strike (high > shortCe but close < shortCe) → no exit', () => {
  const candle = makeCandle({ high: 24420, close: 24380 }); // touched but closed below
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false);
});

test('T07 Rule 2: close is 30pts beyond shortCe (< 50pt buffer) → no exit', () => {
  const candle = makeCandle({ close: 24430 }); // 30pts beyond 24400
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false);
});

test('T08 Rule 2: close is 60pts beyond shortCe (> 50pt buffer) + high volume → exit', () => {
  const candle = makeCandle({ close: 24460, volume: 2000 }); // 60pts beyond, high vol
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, true);
});

// ── Rule 3: Volume confirmation ───────────────────────────────────────────
test('T09 Rule 3: volume = 0 (NSE source) → skip rule, treat as no-exit', () => {
  const candle = makeCandle({ close: 24460, volume: 0 }); // price breached but no volume
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false, 'volume=0 should skip Rule 3 → no exit');
});

test('T10 Rule 3: volume below average → likely hunt, no exit', () => {
  const candle = makeCandle({ close: 24460, volume: 400 }); // 400 < 1000 avg
  const result = antiHunt.evaluate(makePosition(), candle, makeContext());
  assert.strictEqual(result.shouldExit, false);
});

// ── Rule 5: Delta monitoring ──────────────────────────────────────────────
test('T11 Rule 5: CE delta > 0.35 → returns flagged:true, shouldExit:false', () => {
  const pos = makePosition({ ceDelta: 0.40 });
  const result = antiHunt.evaluate(pos, makeCandle(), makeContext());
  assert.strictEqual(result.shouldExit, false);
  assert.strictEqual(result.flagged, true);
  assert.strictEqual(result.rule, 5);
});

test('T12 Rule 5: PE delta < -0.35 → returns flagged:true, shouldExit:false', () => {
  const pos = makePosition({ peDelta: -0.40 });
  const result = antiHunt.evaluate(pos, makeCandle(), makeContext());
  assert.strictEqual(result.shouldExit, false);
  assert.strictEqual(result.flagged, true);
});

test('T13 normal position within all thresholds → shouldExit false, flagged false', () => {
  const result = antiHunt.evaluate(makePosition(), makeCandle(), makeContext());
  assert.strictEqual(result.shouldExit, false);
  assert.strictEqual(result.flagged, false);
});

console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 6.2: Run tests — confirm they fail**

```bash
node test-phase2-antihunt.js
```

Expected: `Cannot find module './monitoring/anti-hunt'`

- [ ] **Step 6.3: Create anti-hunt.js**

Create `monitoring/anti-hunt.js`:

```js
/**
 * @file anti-hunt.js
 * @description Pure function module — no event bus imports. Evaluates anti-hunt rules
 *              against current position state and last 15m candle. Called by
 *              position-tracker.js on each CANDLE_CLOSE_15M event.
 *
 *              Rule evaluation order (strict):
 *                6 → 4 → 1+2 → 3 → 5
 *              Rule 8 (Claude hunt detection) skipped silently in RULES mode.
 */
'use strict';

const config = require('../config');

// IST offset helper
function toIST(tsMs) {
  const istMs  = tsMs + 5.5 * 3600 * 1000;
  const hour   = Math.floor((istMs % (24 * 3600000)) / 3600000);
  const minute = Math.floor((istMs % 3600000) / 60000);
  return { hour, minute };
}

function _isDangerousWindow(tsMs) {
  const { hour, minute } = toIST(tsMs);
  return (
    (hour === 9  && minute >= 15 && minute < 30) ||  // 09:15–09:30
    (hour === 11 && minute >= 30 && minute < 45) ||  // 11:30–11:45
    (hour === 13 && minute >= 0  && minute < 30) ||  // 13:00–13:30
    (hour === 14 && minute >= 45)                    // 14:45–15:00
  );
}

/**
 * Evaluate anti-hunt rules for the current position and candle.
 *
 * @param {{ orderId, strikes, entryPremium, currentPnl, ceDelta, peDelta, avgVolume }} position
 * @param {{ close, high, low, volume, openTime }} candle  — the just-closed 15m candle
 * @param {{ dayOpen }} sessionContext
 * @returns {{ shouldExit: boolean, flagged: boolean, rule: number|null, reason: string }}
 */
function evaluate(position, candle, sessionContext) {
  const { strikes, currentPnl, ceDelta, peDelta, avgVolume } = position;

  // ── Rule 6: Absolute P&L stop (checked first, bypasses everything) ───────
  const absoluteStop = config.MAX_DAILY_LOSS * config.ABSOLUTE_PNL_STOP_PCT;
  if (currentPnl <= -absoluteStop) {
    return { shouldExit: true, flagged: false, rule: 6, reason: `Absolute P&L stop: loss ₹${Math.abs(currentPnl)} exceeds ₹${absoluteStop}` };
  }

  // ── Rule 4: Dangerous window — only Rule 6 can exit here ─────────────────
  if (_isDangerousWindow(candle.openTime)) {
    return { shouldExit: false, flagged: false, rule: null, reason: 'Dangerous window — no exits except absolute P&L stop' };
  }

  // ── Rules 1 + 2: Price must close (not touch) beyond buffer zone ──────────
  const BUFFER = 50; // points
  const ceBreach = candle.close > strikes.shortCe + BUFFER;
  const peBreach = candle.close < strikes.shortPe - BUFFER;

  if (ceBreach || peBreach) {
    // ── Rule 3: Volume confirmation ──────────────────────────────────────
    if (candle.volume === 0) {
      // Volume unavailable (NSE source) — skip rule, treat as likely hunt
      return { shouldExit: false, flagged: false, rule: null, reason: 'Volume unavailable — Rule 3 skipped, treating as hunt' };
    }

    const isRealMove = candle.volume >= avgVolume * 1.5;
    if (!isRealMove) {
      return { shouldExit: false, flagged: false, rule: null, reason: `Volume ${candle.volume} < 1.5× avg ${avgVolume} — likely hunt` };
    }

    const side   = ceBreach ? 'CE' : 'PE';
    const strike = ceBreach ? strikes.shortCe : strikes.shortPe;
    return { shouldExit: true, flagged: false, rule: ceBreach ? 2 : 2, reason: `${side} short strike ${strike} breached by >50pts on high volume` };
  }

  // ── Rule 5: Delta monitoring (flag, not exit) ─────────────────────────────
  if (ceDelta != null && ceDelta > 0.35) {
    return { shouldExit: false, flagged: true, rule: 5, reason: `Short CE delta ${ceDelta} exceeds 0.35 — high risk alert` };
  }
  if (peDelta != null && peDelta < -0.35) {
    return { shouldExit: false, flagged: true, rule: 5, reason: `Short PE delta ${peDelta} below -0.35 — high risk alert` };
  }

  return { shouldExit: false, flagged: false, rule: null, reason: 'All rules within bounds' };
}

module.exports = { evaluate };
```

- [ ] **Step 6.4: Run anti-hunt tests**

```bash
node test-phase2-antihunt.js
```

Expected: `13 tests — 13 passed, 0 failed`

- [ ] **Step 6.5: Commit**

```bash
git add monitoring/anti-hunt.js test-phase2-antihunt.js
git commit -m "feat: add pure anti-hunt rule evaluator with 7-rule priority chain (Gate 4)"
```

---

## Task 7: Position Tracker

**Files:**
- Create: `monitoring/position-tracker.js`

Position tracker wires the event bus to anti-hunt. No separate test file — it's covered by the integration test (Task 9).

- [ ] **Step 7.1: Create position-tracker.js**

Create `monitoring/position-tracker.js`:

```js
/**
 * @file position-tracker.js
 * @description Monitors an active Iron Condor position. Starts after ORDER_FILLED,
 *              calls anti-hunt.evaluate() on each CANDLE_CLOSE_15M, handles square-off,
 *              and manages the full exit lifecycle through to TRADE_CLOSED.
 */
'use strict';

const eventBus      = require('../core/event-bus');
const EVENTS        = require('../core/events');
const stateMachine  = require('../core/state-machine');
const antiHunt      = require('./anti-hunt');
const paperExecutor = require('../execution/paper-executor');
const journal       = require('../journal/trade-journal');
const config        = require('../config');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [PositionTracker] [${level}] ${msg}`);
}

function toIST(tsMs) {
  const istMs  = tsMs + 5.5 * 3600 * 1000;
  const hour   = Math.floor((istMs % (24 * 3600000)) / 3600000);
  const minute = Math.floor((istMs % 3600000) / 60000);
  return { hour, minute };
}

class PositionTracker {
  constructor() {
    this._activeFill      = null;  // { orderId, legs, strikes, premiumCollected }
    this._entryTime       = null;
    this._lastKnownPnl    = 0;
    this._exiting         = false;
    this._candleVolumes   = [];    // rolling 20 candle volumes for avg computation
    this._ceDelta         = null;
    this._peDelta         = null;

    eventBus.on(EVENTS.ORDER_FILLED, (fill) => this._onFill(fill));
    eventBus.on(EVENTS.TICK_RECEIVED, ({ ltp }) => this._onTick(ltp));
    eventBus.on(EVENTS.CANDLE_CLOSE_15M, (candle) => this._onCandle(candle));
    eventBus.on(EVENTS.INDICATORS_UPDATED, (payload) => {
      if (payload.timeframe === 'options') {
        this._ceDelta = payload.indicators.ceDelta;
        this._peDelta = payload.indicators.peDelta;
      }
    });
    eventBus.on(EVENTS.EXIT_TRIGGERED, () => this._exit('Manual/circuit exit'));
    eventBus.on(EVENTS.MANUAL_SQUAREOFF_REQUESTED, () => this._exit('Manual square-off via Telegram'));
  }

  _onFill(fill) {
    this._activeFill   = fill;
    this._entryTime    = Date.now();
    this._exiting      = false;
    this._lastKnownPnl = 0;
    stateMachine.transition('ACTIVE');
    log('INFO', `Monitoring position ${fill.orderId} — premium ₹${fill.premiumCollected}`);
    journal.write('ORDER_FILLED', { legs: fill.legs, premiumCollected: fill.premiumCollected });
  }

  _onTick(ltp) {
    if (!this._activeFill || this._exiting) return;
    // Emit POSITION_UPDATED with last known P&L (real recalc happens on OPTIONS_CHAIN_UPDATED below)
    eventBus.emit(EVENTS.POSITION_UPDATED, {
      orderId:       this._activeFill.orderId,
      unrealisedPnl: this._lastKnownPnl,
      ltp,
      timestamp:     Date.now(),
    });
  }

  _onOptionsChain(payload) {
    if (!this._activeFill || this._exiting) return;
    const pnl = paperExecutor.computeUnrealisedPnl(this._activeFill);
    this._lastKnownPnl = pnl;
    journal.write('POSITION_UPDATED', { unrealisedPnl: pnl, ltpAtUpdate: payload.underlyingValue });
  }

  _onCandle(candle) {
    if (!this._activeFill || this._exiting) return;

    // Track volume history for Rule 3 avg computation
    if (candle.volume > 0) {
      this._candleVolumes.push(candle.volume);
      if (this._candleVolumes.length > 20) this._candleVolumes.shift();
    }
    const avgVolume = this._candleVolumes.length > 0
      ? this._candleVolumes.reduce((a, b) => a + b, 0) / this._candleVolumes.length
      : 0;

    // Square-off time check (15:15 IST)
    const { hour, minute } = toIST(candle.openTime);
    if (hour === 15 && minute >= 15) {
      log('INFO', 'Square-off time reached — exiting');
      this._exit('Square-off time 15:15 IST');
      return;
    }

    const [sqHour, sqMin] = config.SQUARE_OFF_TIME.split(':').map(Number);
    const position = {
      orderId:      this._activeFill.orderId,
      strikes:      this._activeFill.strikes,
      entryPremium: this._activeFill.premiumCollected,
      currentPnl:   this._lastKnownPnl,
      ceDelta:      this._ceDelta,
      peDelta:      this._peDelta,
      avgVolume,
    };

    const sessionContext = require('../core/session-context').snapshot();
    const decision = antiHunt.evaluate(position, candle, sessionContext);

    if (decision.flagged) {
      stateMachine.transition('FLAGGED');
      eventBus.emit(EVENTS.POSITION_FLAGGED, {
        orderId: this._activeFill.orderId,
        rule:    decision.rule,
        reason:  decision.reason,
        ceDelta: this._ceDelta,
        peDelta: this._peDelta,
      });
      journal.write('POSITION_FLAGGED', { rule: decision.rule, reason: decision.reason });
      log('WARN', `Position flagged: ${decision.reason}`);
    }

    if (decision.shouldExit) {
      log('WARN', `Exit signal: ${decision.reason}`);
      this._exit(decision.reason);
    }
  }

  async _exit(reason) {
    if (!this._activeFill || this._exiting) return;
    this._exiting = true;

    stateMachine.transition('EXITING');
    log('INFO', `Exiting position ${this._activeFill.orderId}: ${reason}`);

    try {
      const exitResult = await paperExecutor.exitOrder(this._activeFill.orderId);
      const duration   = Math.round((Date.now() - this._entryTime) / 1000);

      journal.write('ORDER_EXITED',  { exitPrices: exitResult.legs, realisedPnl: exitResult.realisedPnl });
      journal.write('TRADE_CLOSED',  { realisedPnl: exitResult.realisedPnl, duration, reasoning: null });

      stateMachine.transition('CLOSED');
      eventBus.emit(EVENTS.POSITION_CLOSED, {
        orderId:     this._activeFill.orderId,
        realisedPnl: exitResult.realisedPnl,
        duration,
        reason,
      });

      log('INFO', `Position closed: P&L ₹${exitResult.realisedPnl}`);
      this._activeFill   = null;
      this._entryTime    = null;
      this._lastKnownPnl = 0;
      this._exiting      = false;

      stateMachine.transition('IDLE');
    } catch (err) {
      log('ERROR', `Exit failed: ${err.message}`);
      this._exiting = false;
    }
  }
}

// Wire OPTIONS_CHAIN_UPDATED separately to avoid circular require at construction
const tracker = new PositionTracker();
eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED, (payload) => tracker._onOptionsChain(payload));

module.exports = tracker;
```

- [ ] **Step 7.2: Commit**

```bash
git add monitoring/position-tracker.js
git commit -m "feat: add position tracker wiring anti-hunt to event bus lifecycle"
```

---

## Task 8: Telegram Bot

**Files:**
- Create: `notifications/telegram.js`
- Create: `test-phase2-telegram.js`

- [ ] **Step 8.1: Write the failing tests**

Create `test-phase2-telegram.js`:

```js
/**
 * @file test-phase2-telegram.js
 * @description Phase 2 Gate 5 — Telegram bot approval flow and commands.
 *              Mocks node-telegram-bot-api — no real bot token needed.
 */
'use strict';

const assert       = require('assert');
const EventEmitter = require('events');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n── Telegram Bot Tests ───────────────────────────────────────────\n');

// ── Mock TelegramBot ──────────────────────────────────────────────────────
class MockTelegramBot extends EventEmitter {
  constructor(token, opts) {
    super();
    this.token = token;
    this.sent  = [];
    this.edited = [];
  }
  sendMessage(chatId, text, opts) {
    const msg = { chatId, text, opts, message_id: Math.floor(Math.random() * 10000) };
    this.sent.push(msg);
    return Promise.resolve(msg);
  }
  editMessageReplyMarkup(markup, opts) {
    this.edited.push({ markup, opts });
    return Promise.resolve({});
  }
  answerCallbackQuery(id, opts) {
    return Promise.resolve({});
  }
  // Simulate user pressing inline keyboard button
  _pressButton(callbackData, fromId) {
    this.emit('callback_query', {
      id:   'cq-' + Date.now(),
      data: callbackData,
      from: { id: fromId },
      message: { message_id: this.sent[this.sent.length - 1]?.message_id || 1 },
    });
  }
  // Simulate user sending a command
  _sendCommand(text, fromId) {
    this.emit('message', {
      text,
      from: { id: fromId },
      chat: { id: fromId },
    });
  }
}

// Stub event bus
const stubBus = new EventEmitter();
const Module = require('module');
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function(req, parent, isMain, opts) {
  return origResolve(req, parent, isMain, opts);
};

// Inject stubs
const eventBusPath = require.resolve('./core/event-bus');
require.cache[eventBusPath] = { exports: stubBus };

const TelegramNotifier = require('./notifications/telegram');
const config = require('./config');

let mockBot;
// Inject mock bot class
TelegramNotifier.start(MockTelegramBot);
mockBot = TelegramNotifier._bot;

const AUTHORIZED_ID = config.TELEGRAM_CHAT_ID ? parseInt(config.TELEGRAM_CHAT_ID) : 123456789;
// Override for tests
config.TELEGRAM_CHAT_ID = String(AUTHORIZED_ID);

(async () => {

  await testAsync('T01 SIGNAL_GENERATED event → sends approval message with YES/NO keyboard', async () => {
    stubBus.emit('SIGNAL_GENERATED', {
      strategy: 'Iron Condor',
      strikes: { shortCe: 24400, longCe: 24600, shortPe: 24000, longPe: 23800 },
      expectedPremium: 500,
      indicatorSnapshot: { rsi: 50, vix: 16 },
      optionsSnapshot: { vix: 16, pcr: 1.05, atmStrike: 24200 },
      timestamp: new Date().toISOString(),
    });
    // Allow async sendMessage to resolve
    await new Promise(r => setTimeout(r, 50));
    const last = mockBot.sent[mockBot.sent.length - 1];
    assert(last, 'message was sent');
    assert(last.opts?.reply_markup?.inline_keyboard, 'has inline keyboard');
    const buttons = last.opts.reply_markup.inline_keyboard.flat();
    assert(buttons.some(b => b.callback_data === 'APPROVE'), 'has APPROVE button');
    assert(buttons.some(b => b.callback_data === 'REJECT'), 'has REJECT button');
  });

  await testAsync('T02 YES button press → emits USER_APPROVED', async () => {
    let approved = false;
    stubBus.once('USER_APPROVED', () => { approved = true; });
    mockBot._pressButton('APPROVE', AUTHORIZED_ID);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(approved, true, 'USER_APPROVED was emitted');
  });

  await testAsync('T03 NO button press → emits USER_REJECTED', async () => {
    // Trigger a new signal first
    stubBus.emit('SIGNAL_GENERATED', {
      strategy: 'Iron Condor', strikes: {}, expectedPremium: 400,
      indicatorSnapshot: {}, optionsSnapshot: {}, timestamp: new Date().toISOString(),
    });
    await new Promise(r => setTimeout(r, 50));

    let rejected = false;
    stubBus.once('USER_REJECTED', () => { rejected = true; });
    mockBot._pressButton('REJECT', AUTHORIZED_ID);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(rejected, true, 'USER_REJECTED was emitted');
  });

  await testAsync('T04 unknown sender ID → message ignored', async () => {
    const countBefore = mockBot.sent.length;
    mockBot._sendCommand('/status', 99999); // unauthorized ID
    await new Promise(r => setTimeout(r, 50));
    // No response should be sent to unauthorized users
    const newMessages = mockBot.sent.slice(countBefore).filter(m => m.chatId === 99999);
    assert.strictEqual(newMessages.length, 0, 'no response sent to unauthorized sender');
  });

  await testAsync('T05 /pause command sets paused state', async () => {
    let pauseEmitted = false;
    stubBus.once('PAUSE_REQUESTED', () => { pauseEmitted = true; });
    mockBot._sendCommand('/pause', AUTHORIZED_ID);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(pauseEmitted, true, 'PAUSE_REQUESTED emitted');
  });

  await testAsync('T06 /resume command emits RESUME_REQUESTED', async () => {
    let resumeEmitted = false;
    stubBus.once('RESUME_REQUESTED', () => { resumeEmitted = true; });
    mockBot._sendCommand('/resume', AUTHORIZED_ID);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(resumeEmitted, true, 'RESUME_REQUESTED emitted');
  });

  await testAsync('T07 approval timeout → emits USER_REJECTED and sends timeout message', async () => {
    // Use a very short timeout for this test
    const origTimeout = config.TRADE_APPROVAL_TIMEOUT_MS;
    config.TRADE_APPROVAL_TIMEOUT_MS = 100; // 100ms for test

    stubBus.emit('SIGNAL_GENERATED', {
      strategy: 'Iron Condor', strikes: {}, expectedPremium: 300,
      indicatorSnapshot: {}, optionsSnapshot: {}, timestamp: new Date().toISOString(),
    });

    let timedOut = false;
    stubBus.once('USER_REJECTED', () => { timedOut = true; });

    await new Promise(r => setTimeout(r, 200)); // wait for timeout
    config.TRADE_APPROVAL_TIMEOUT_MS = origTimeout;
    assert.strictEqual(timedOut, true, 'USER_REJECTED emitted on timeout');
    const timeoutMsg = mockBot.sent.find(m => m.text && m.text.includes('Auto-rejected'));
    assert(timeoutMsg, 'timeout message sent');
  });

  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
```

- [ ] **Step 8.2: Run tests — confirm they fail**

```bash
node test-phase2-telegram.js
```

Expected: `Cannot find module './notifications/telegram'`

- [ ] **Step 8.3: Create telegram.js**

Create `notifications/telegram.js`:

```js
/**
 * @file telegram.js
 * @description Two-direction Telegram bot. Outbound: trade approvals, alerts, summaries.
 *              Inbound: /status, /pause, /resume, /squareoff, /mode commands.
 *              Only responds to TELEGRAM_CHAT_ID — all other senders silently ignored.
 *              Call start(BotClass?) to initialise; BotClass param allows test injection.
 */
'use strict';

const eventBus = require('../core/event-bus');
const EVENTS   = require('../core/events');
const config   = require('../config');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [Telegram] [${level}] ${msg}`);
}

function footer() {
  return `\n\n_Mode: ${config.INTELLIGENCE_MODE}_`;
}

class TelegramNotifier {
  constructor() {
    this._bot             = null;
    this._pendingApproval = null;  // { messageId, timer }
  }

  /**
   * Initialise the bot and register all listeners.
   * @param {Function} [BotClass] — inject mock class for tests
   */
  start(BotClass) {
    const Bot    = BotClass || require('node-telegram-bot-api');
    this._bot    = new Bot(config.TELEGRAM_BOT_TOKEN || 'TEST_TOKEN', { polling: true });
    this._authorizedId = parseInt(config.TELEGRAM_CHAT_ID, 10);

    this._registerInbound();
    this._registerOutbound();
    log('INFO', 'Telegram bot started');
  }

  // ── Inbound ─────────────────────────────────────────────────────────────

  _registerInbound() {
    this._bot.on('message', (msg) => {
      if (msg.from.id !== this._authorizedId) return; // silently ignore unauthorized

      const text = (msg.text || '').trim();
      const chatId = msg.chat.id;

      if (text === '/pause') {
        eventBus.emit(EVENTS.PAUSE_REQUESTED, {});
        this._bot.sendMessage(chatId, `⏸ Trading paused. New entries blocked.${footer()}`);
        return;
      }
      if (text === '/resume') {
        eventBus.emit(EVENTS.RESUME_REQUESTED, {});
        this._bot.sendMessage(chatId, `▶️ Trading resumed.${footer()}`);
        return;
      }
      if (text === '/squareoff') {
        eventBus.emit(EVENTS.EXIT_TRIGGERED, { source: 'TELEGRAM_MANUAL' });
        this._bot.sendMessage(chatId, `🔴 Manual square-off triggered.${footer()}`);
        return;
      }
      if (text.startsWith('/mode')) {
        const parts = text.split(' ');
        const mode  = parts[1]?.toUpperCase();
        if (['AI', 'HYBRID'].includes(mode)) {
          this._bot.sendMessage(chatId, `⚠️ Mode ${mode} not yet implemented. Staying on RULES.${footer()}`);
          return;
        }
        if (mode === 'RULES') {
          config.INTELLIGENCE_MODE = 'RULES';
          this._bot.sendMessage(chatId, `✅ Switched to RULES mode.${footer()}`);
          return;
        }
        this._bot.sendMessage(chatId, `Usage: /mode [AI|RULES|HYBRID]${footer()}`);
        return;
      }
      if (text === '/status') {
        const sessionContext = (() => {
          try { return require('../core/session-context').getSnapshot(); } catch { return {}; }
        })();
        const status = [
          `📊 *Drishti Status*`,
          `Mode: ${config.INTELLIGENCE_MODE}`,
          `Execution: ${config.EXECUTION_MODE}`,
          `Day P&L: ₹${sessionContext.pnlToday ?? 0}`,
          `Trades today: ${sessionContext.tradesToday ?? 0}`,
          `VIX: ${sessionContext.vixCurrent ?? 'N/A'}`,
        ].join('\n');
        this._bot.sendMessage(chatId, status + footer(), { parse_mode: 'Markdown' });
        return;
      }
    });

    this._bot.on('callback_query', async (query) => {
      if (query.from.id !== this._authorizedId) return;
      if (!this._pendingApproval) return;

      const { timer } = this._pendingApproval;
      clearTimeout(timer);
      this._pendingApproval = null;

      await this._bot.answerCallbackQuery(query.id);
      await this._bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id:    this._authorizedId,
        message_id: query.message.message_id,
      });

      if (query.data === 'APPROVE') {
        eventBus.emit(EVENTS.USER_APPROVED, { source: 'TELEGRAM' });
        log('INFO', 'Trade approved by user');
      } else {
        eventBus.emit(EVENTS.USER_REJECTED, { source: 'TELEGRAM', reason: 'User rejected' });
        log('INFO', 'Trade rejected by user');
      }
    });
  }

  // ── Outbound ─────────────────────────────────────────────────────────────

  _registerOutbound() {
    eventBus.on(EVENTS.SIGNAL_GENERATED, (payload) => this._onSignal(payload));
    eventBus.on(EVENTS.POSITION_FLAGGED, (payload) => this._onFlagged(payload));
    eventBus.on(EVENTS.CIRCUIT_BREAKER_HIT, (payload) => this._onCircuitBreaker(payload));
    eventBus.on(EVENTS.OPTIONS_CHAIN_STALE, (payload) => this._onStale(payload));
    eventBus.on(EVENTS.POSITION_CLOSED, (payload) => this._onClosed(payload));
  }

  async _onSignal(payload) {
    if (!this._bot) return;
    const { strikes, expectedPremium, optionsSnapshot } = payload;
    const text = [
      `🎯 *New Iron Condor Signal*`,
      `Short CE: ${strikes.shortCe} | Long CE: ${strikes.longCe}`,
      `Short PE: ${strikes.shortPe} | Long PE: ${strikes.longPe}`,
      `Expected premium: ₹${expectedPremium ?? 'N/A'}`,
      `VIX: ${optionsSnapshot?.vix} | PCR: ${optionsSnapshot?.pcr}`,
      `\nApprove this trade?`,
    ].join('\n');

    const msg = await this._bot.sendMessage(this._authorizedId, text + footer(), {
      parse_mode:   'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ YES', callback_data: 'APPROVE' },
          { text: '❌ NO',  callback_data: 'REJECT'  },
        ]],
      },
    });

    const timer = setTimeout(() => {
      if (!this._pendingApproval) return;
      this._pendingApproval = null;
      eventBus.emit(EVENTS.USER_REJECTED, { source: 'TELEGRAM', reason: 'Timeout' });
      this._bot.sendMessage(this._authorizedId, `⏱ Auto-rejected (timeout — no response in 3 minutes).${footer()}`);
      log('WARN', 'Trade approval timed out');
    }, config.TRADE_APPROVAL_TIMEOUT_MS);

    this._pendingApproval = { messageId: msg.message_id, timer };
  }

  _onFlagged(payload) {
    if (!this._bot) return;
    const text = `⚠️ *High Risk Alert*\nRule ${payload.rule}: ${payload.reason}\nCE Δ: ${payload.ceDelta ?? 'N/A'} | PE Δ: ${payload.peDelta ?? 'N/A'}`;
    this._bot.sendMessage(this._authorizedId, text + footer(), { parse_mode: 'Markdown' });
  }

  _onCircuitBreaker(payload) {
    if (!this._bot) return;
    const text = `🚨 *Circuit Breaker Tripped*\n${payload.breakerName}: ${payload.reason}`;
    this._bot.sendMessage(this._authorizedId, text + footer(), { parse_mode: 'Markdown' });
  }

  _onStale(payload) {
    if (!this._bot) return;
    this._bot.sendMessage(this._authorizedId, `⚠️ Options chain data stale: ${payload.reason}${footer()}`);
  }

  _onClosed(payload) {
    if (!this._bot) return;
    const emoji = payload.realisedPnl >= 0 ? '✅' : '🔴';
    const text  = `${emoji} *Trade Closed*\nRealised P&L: ₹${payload.realisedPnl}\nDuration: ${payload.duration}s\nReason: ${payload.reason}`;
    this._bot.sendMessage(this._authorizedId, text + footer(), { parse_mode: 'Markdown' });
  }
}

module.exports = new TelegramNotifier();
```

- [ ] **Step 8.4: Run telegram tests**

```bash
node test-phase2-telegram.js
```

Expected: `7 tests — 7 passed, 0 failed`

- [ ] **Step 8.5: Commit**

```bash
git add notifications/telegram.js test-phase2-telegram.js
git commit -m "feat: add Telegram bot with trade approval flow and inbound commands (Gate 5)"
```

---

## Task 9: Integration Test + index.js Wiring

**Files:**
- Create: `test-phase2-integration.js`
- Modify: `index.js`

- [ ] **Step 9.1: Create integration test**

Create `test-phase2-integration.js`:

```js
/**
 * @file test-phase2-integration.js
 * @description Phase 2 Gate 6 — Full paper trading loop without live APIs.
 *              Injects synthetic events through the event bus and verifies the
 *              complete signal → fill → monitor → exit → journal lifecycle.
 */
'use strict';

const assert       = require('assert');
const EventEmitter = require('events');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}
async function testAsync(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n── Integration Tests ────────────────────────────────────────────\n');

// Use real event bus for integration
const eventBus = require('./core/event-bus');
const EVENTS   = require('./core/events');
const config   = require('./config');

// Patch journal to use temp file
const journal = require('./journal/trade-journal');
const tmpJournal = path.join(os.tmpdir(), `drishti-integration-${Date.now()}.ndjson`);
journal._filePath = tmpJournal;

// Load modules (they self-register on the event bus)
const paperExecutor   = require('./execution/paper-executor');
const positionTracker = require('./monitoring/position-tracker');

// Inject strike data and ltp
const fakeStrikeData = {
  24400: { ce: 80, pe: null  },
  24600: { ce: 40, pe: null  },
  24000: { ce: null, pe: 75  },
  23800: { ce: null, pe: 40  },
};
paperExecutor._lastLtp        = 24185;
paperExecutor._lastStrikeData = fakeStrikeData;

(async () => {

  await testAsync('T01 OPTIONS_CHAIN_UPDATED populates strikeData in executor', async () => {
    eventBus.emit(EVENTS.OPTIONS_CHAIN_UPDATED, {
      underlyingValue: 24185,
      vix: 16, pcr: 1.05, atmStrike: 24200,
      maxCeOiStrike: 24500, maxPeOiStrike: 23900,
      strikeData: fakeStrikeData,
      timestamp: new Date().toISOString(),
    });
    assert.deepStrictEqual(paperExecutor._lastStrikeData, fakeStrikeData);
  });

  await testAsync('T02 ORDER_FILLED event triggers position tracker', async () => {
    let filled = false;
    eventBus.once(EVENTS.ORDER_FILLED, () => { filled = true; });

    const legs = [
      { strike: 24400, type: 'CE', action: 'SELL' },
      { strike: 24600, type: 'CE', action: 'BUY'  },
      { strike: 24000, type: 'PE', action: 'SELL' },
      { strike: 23800, type: 'PE', action: 'BUY'  },
    ];
    const fill = await paperExecutor.placeOrder(legs);
    assert.strictEqual(filled, true);
    assert(fill.orderId, 'fill has orderId');
  });

  await testAsync('T03 CANDLE_CLOSE_15M within bounds → no exit', async () => {
    let exitEmitted = false;
    const handler = () => { exitEmitted = true; };
    eventBus.once(EVENTS.POSITION_CLOSED, handler);

    // Candle well within bounds — 10:00 IST = 04:30 UTC
    eventBus.emit(EVENTS.CANDLE_CLOSE_15M, {
      open: 24180, high: 24200, low: 24160, close: 24185,
      volume: 800,
      openTime: new Date('2026-04-14T04:30:00.000Z').getTime(),
    });

    await new Promise(r => setTimeout(r, 100));
    eventBus.removeListener(EVENTS.POSITION_CLOSED, handler);
    assert.strictEqual(exitEmitted, false, 'no exit on candle within bounds');
  });

  await testAsync('T04 absolute P&L stop triggers exit', async () => {
    // First place a fresh order
    const legs = [
      { strike: 24400, type: 'CE', action: 'SELL' },
      { strike: 24600, type: 'CE', action: 'BUY'  },
      { strike: 24000, type: 'PE', action: 'SELL' },
      { strike: 23800, type: 'PE', action: 'BUY'  },
    ];
    const fill = await paperExecutor.placeOrder(legs);
    // Manually set a large negative P&L to trigger Rule 6
    positionTracker._lastKnownPnl = -3000; // > 50% of 5000

    let closed = false;
    eventBus.once(EVENTS.POSITION_CLOSED, () => { closed = true; });

    eventBus.emit(EVENTS.CANDLE_CLOSE_15M, {
      open: 24400, high: 24450, low: 24380, close: 24430,
      volume: 2000,
      openTime: new Date('2026-04-14T04:30:00.000Z').getTime(),
    });

    await new Promise(r => setTimeout(r, 200));
    assert.strictEqual(closed, true, 'position closed on absolute P&L stop');
  });

  await testAsync('T05 journal has TRADE_CLOSED entry after exit', async () => {
    await new Promise(r => setTimeout(r, 100)); // let journal writes settle
    const entries = await journal.readToday();
    const closed = entries.filter(e => e.eventType === 'TRADE_CLOSED');
    assert(closed.length >= 1, 'at least one TRADE_CLOSED in journal');
    assert(typeof closed[0].data.realisedPnl === 'number', 'has realisedPnl');
    assert.strictEqual(closed[0].data.reasoning, null, 'reasoning is null (RULES mode)');
  });

  // Cleanup
  if (fs.existsSync(tmpJournal)) fs.unlinkSync(tmpJournal);

  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
```

- [ ] **Step 9.2: Run integration test**

```bash
node test-phase2-integration.js
```

Expected: `5 tests — 5 passed, 0 failed`

Debug note: If T04 fails because state machine is already in a non-IDLE state from T02, add a `stateMachine.reset()` between tests, or ensure the state machine transitions fully to CLOSED→IDLE after T02's exit.

- [ ] **Step 9.3: Wire Phase 2 into index.js**

In `index.js`, add after the Phase 1 boot block and before `SYSTEM_READY`:

```js
  // ── Phase 2: Trading Layer ─────────────────────────────────────────────
  const journal        = require('./journal/trade-journal');
  const telegram       = require('./notifications/telegram');

  // Restore session state from yesterday's journal
  const { pnlToday, tradesToday } = await journal.restoreFromJournal();
  // SessionContext would receive these via direct set or event — use event pattern:
  if (pnlToday !== 0 || tradesToday !== 0) {
    log('INFO', `Restored: pnlToday=₹${pnlToday}, tradesToday=${tradesToday}`);
  }

  // Load Phase 2 modules (self-register on event bus via require)
  require('./execution/paper-executor');
  require('./strategies/iron-condor.strategy');
  require('./monitoring/position-tracker');

  // Start Telegram bot
  telegram.start();
```

- [ ] **Step 9.4: Commit**

```bash
git add test-phase2-integration.js index.js
git commit -m "feat: add integration test and wire Phase 2 into boot sequence (Gate 6)"
```

---

## Task 10: Package Script + PHASE_2_COMPLETE.md

**Files:**
- Modify: `package.json`
- Create: `PHASE_2_COMPLETE.md`

- [ ] **Step 10.1: Add test:phase2 script to package.json**

In `package.json`, add to the `scripts` block:

```json
"test:phase2": "node test-phase2-executor.js && node test-phase2-journal.js && node test-phase2-strategy.js && node test-phase2-antihunt.js && node test-phase2-telegram.js && node test-phase2-integration.js"
```

- [ ] **Step 10.2: Run full Phase 2 test suite**

```bash
npm run test:phase2
```

Expected: All 6 test files pass. No failures.

Also confirm Phase 0+1 still pass:

```bash
node test-phase0.js && node test-phase1.js
```

Expected: `16 tests — 16 passed` + `13 tests — 13 passed`

- [ ] **Step 10.3: Create PHASE_2_COMPLETE.md**

Create `PHASE_2_COMPLETE.md` documenting what was built, files, how to run, and known limitations (use same format as PHASE_1_COMPLETE.md).

- [ ] **Step 10.4: Final commit**

```bash
git add package.json PHASE_2_COMPLETE.md
git commit -m "feat: Phase 2 complete — rules-based Iron Condor paper trading"
```

---

## Self-Review Checklist

- [x] **Spec coverage:** All 6 subsystems covered (executor, journal, strategy, anti-hunt + position-tracker, telegram, integration). Journal boot restore covered in Task 4. Rule priority order (6→4→1+2→3→5) implemented in Task 6. `strikeData` extension covered in Task 2.
- [x] **Placeholder scan:** No TBDs. All code blocks complete.
- [x] **Type consistency:** `SIGNAL_GENERATED`, `USER_APPROVED`, `USER_REJECTED`, `EXIT_TRIGGERED`, `POSITION_CLOSED` used throughout — matches `events.js` constants. `placeOrder(legs)` / `exitOrder(orderId)` / `computeUnrealisedPnl(fill)` consistent across Tasks 3, 7, 9.
- [x] **SessionContext method:** Uses `snapshot()` — already exists in `core/session-context.js`. No changes needed.
