# Task 9: Integration + index.js Wiring + Completion

**Files:**
- Create: `test-phase2-integration.js`
- Modify: `index.js`
- Modify: `package.json`
- Create: `PHASE_2_COMPLETE.md`

---

## Integration Test (test-phase2-integration.js) — 5 async tests

Uses **real** event bus (not stub). Patches `journal._filePath` to a temp file.

Setup:
```js
const eventBus = require('./core/event-bus');
const EVENTS   = require('./core/events');
const journal  = require('./journal/trade-journal');
journal._filePath = path.join(os.tmpdir(), `drishti-integration-${Date.now()}.ndjson`);

const paperExecutor   = require('./execution/paper-executor');
const positionTracker = require('./monitoring/position-tracker');

const fakeStrikeData = {
  24400: { ce: 80, pe: null }, 24600: { ce: 40, pe: null },
  24000: { ce: null, pe: 75 }, 23800: { ce: null, pe: 40 },
};
paperExecutor._lastLtp        = 24185;
paperExecutor._lastStrikeData = fakeStrikeData;
```

| Test | Action | Expected |
|------|--------|----------|
| T01 | emit `OPTIONS_CHAIN_UPDATED` with `strikeData` | `paperExecutor._lastStrikeData` matches |
| T02 | `paperExecutor.placeOrder(legs)` | `ORDER_FILLED` emitted, fill has `orderId` |
| T03 | emit `CANDLE_CLOSE_15M` within bounds (10:00 IST, close: 24185) | `POSITION_CLOSED` NOT emitted |
| T04 | place order, set `positionTracker._lastKnownPnl = -3000`, emit candle | `POSITION_CLOSED` emitted (Rule 6) |
| T05 | after T04 | journal has `TRADE_CLOSED` entry with `realisedPnl` number and `reasoning: null` |

Cleanup: `fs.unlinkSync(tmpJournal)`

**Run:** `node test-phase2-integration.js` → `5 tests — 5 passed, 0 failed`

Debug note: If T04 fails due to stale state machine state, ensure T02's exit fully transitions to IDLE before T04.

---

## index.js Wiring

Add after Phase 1 boot block, before `SYSTEM_READY`:

```js
// ── Phase 2: Trading Layer ─────────────────────────────────────────────
const journal  = require('./journal/trade-journal');
const telegram = require('./notifications/telegram');

const { pnlToday, tradesToday } = await journal.restoreFromJournal();
if (pnlToday !== 0 || tradesToday !== 0) {
  log('INFO', `Restored: pnlToday=₹${pnlToday}, tradesToday=${tradesToday}`);
}

require('./execution/paper-executor');
require('./strategies/iron-condor.strategy');
require('./monitoring/position-tracker');

telegram.start();
```

---

## package.json

Add to `scripts`:
```json
"test:phase2": "node test-phase2-executor.js && node test-phase2-journal.js && node test-phase2-strategy.js && node test-phase2-antihunt.js && node test-phase2-telegram.js && node test-phase2-integration.js"
```

---

## PHASE_2_COMPLETE.md

Same format as `PHASE_1_COMPLETE.md`. Include:
- What was built (6 subsystems)
- File list with one-line descriptions
- How to run: `npm run test:phase2`
- Known limitations: no Claude integration (RULES mode only), NSE source has no volume data (Rule 3 skips)

---

## Final Git Commit (all tasks 6–9)

After all tests pass:

```bash
git add monitoring/anti-hunt.js test-phase2-antihunt.js \
        monitoring/position-tracker.js \
        notifications/telegram.js test-phase2-telegram.js \
        test-phase2-integration.js index.js \
        package.json PHASE_2_COMPLETE.md

git commit -m "feat: Phase 2 complete — anti-hunt, position tracker, Telegram bot, integration"
```

Confirm all phases still pass:
```bash
node test-phase0.js && node test-phase1.js && npm run test:phase2
```
Expected: 16 + 13 + all Phase 2 tests passed.
