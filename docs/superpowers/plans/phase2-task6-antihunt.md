# Task 6: Anti-Hunt Rules

**Files:**
- Create: `monitoring/anti-hunt.js`
- Create: `test-phase2-antihunt.js`

## Spec

Pure function module — no event bus. Called by `position-tracker.js` on each `CANDLE_CLOSE_15M`.

**Rule evaluation order (strict):** 6 → 4 → 1+2 → 3 → 5

### Return shape
```js
{ shouldExit: boolean, flagged: boolean, rule: number|null, reason: string }
```

### Input shape
```js
evaluate(position, candle, sessionContext)
// position: { orderId, strikes: { shortCe, longCe, shortPe, longPe }, entryPremium, currentPnl, ceDelta, peDelta, avgVolume }
// candle:   { close, high, low, volume, openTime }  // openTime is ms timestamp
// sessionContext: { dayOpen }
```

### IST helper
```js
function toIST(tsMs) {
  const istMs  = tsMs + 5.5 * 3600 * 1000;
  const hour   = Math.floor((istMs % (24 * 3600000)) / 3600000);
  const minute = Math.floor((istMs % 3600000) / 60000);
  return { hour, minute };
}
```

### Rules

**Rule 6 — Absolute P&L stop (checked first, bypasses all)**
- `currentPnl <= -(MAX_DAILY_LOSS * ABSOLUTE_PNL_STOP_PCT)` → `{ shouldExit: true, rule: 6 }`

**Rule 4 — Dangerous windows (block exits except Rule 6)**
- Windows (IST): 09:15–09:30, 11:30–11:45, 13:00–13:30, 14:45–15:00
- Inside window → `{ shouldExit: false, rule: null }`

**Rules 1+2 — Price must close (not touch) beyond 50pt buffer**
- `ceBreach = candle.close > strikes.shortCe + 50`
- `peBreach = candle.close < strikes.shortPe - 50`
- If either breached → proceed to Rule 3

**Rule 3 — Volume confirmation**
- `candle.volume === 0` → skip rule, return no-exit (NSE source has no volume)
- `candle.volume < avgVolume * 1.5` → likely hunt, no exit
- `candle.volume >= avgVolume * 1.5` → real move → `{ shouldExit: true, rule: 2 }`

**Rule 5 — Delta monitoring (flag, not exit)**
- `ceDelta > 0.35` or `peDelta < -0.35` → `{ shouldExit: false, flagged: true, rule: 5 }`

**Default** → `{ shouldExit: false, flagged: false, rule: null, reason: 'All rules within bounds' }`

---

## Tests (test-phase2-antihunt.js)

13 tests. Helpers:
```js
function makePosition(overrides = {}) {
  return { orderId: 'test-order', strikes: { shortCe: 24400, longCe: 24600, shortPe: 24000, longPe: 23800 },
    entryPremium: 600, currentPnl: -200, ceDelta: 0.20, peDelta: -0.20, avgVolume: 1000, ...overrides };
}
function makeCandle(overrides = {}) {
  return { close: 24350, high: 24380, low: 24320, volume: 800,
    openTime: new Date('2026-04-14T04:30:00.000Z').getTime(), ...overrides }; // 10:00 IST
}
function makeContext(overrides = {}) { return { dayOpen: 24185, ...overrides }; }
```

| Test | Input | Expected |
|------|-------|----------|
| T01 Rule 6 | `currentPnl: -2600` (>₹2500) | `shouldExit:true, rule:6` |
| T02 Rule 6 near-miss | `currentPnl: -2499` | `rule` not 6 |
| T03 Rule 4 dangerous window | `openTime: 09:20 IST`, price breached | `shouldExit:false` |
| T04 Rule 4 near-miss | `openTime: 11:35 IST`, 60pt breach | `shouldExit:false` |
| T05 Rule 6 inside dangerous window | `currentPnl: -2600`, `openTime: 09:20 IST` | `shouldExit:true, rule:6` |
| T06 Rule 1 price touch | `high: 24420, close: 24380` (touched, not closed above+buffer) | `shouldExit:false` |
| T07 Rule 2 30pt beyond buffer | `close: 24430` (30pt, < 50pt buffer) | `shouldExit:false` |
| T08 Rules 2+3 60pt + high vol | `close: 24460, volume: 2000` | `shouldExit:true` |
| T09 Rule 3 volume=0 | `close: 24460, volume: 0` | `shouldExit:false` |
| T10 Rule 3 low volume | `close: 24460, volume: 400` (< 1000 avg) | `shouldExit:false` |
| T11 Rule 5 CE delta | `ceDelta: 0.40` | `shouldExit:false, flagged:true, rule:5` |
| T12 Rule 5 PE delta | `peDelta: -0.40` | `shouldExit:false, flagged:true` |
| T13 Normal | default position + candle | `shouldExit:false, flagged:false` |

**Run:** `node test-phase2-antihunt.js` → `13 tests — 13 passed, 0 failed`
