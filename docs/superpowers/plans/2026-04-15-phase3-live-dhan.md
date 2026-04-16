# Phase 3 — Live Dhan Execution

**Prerequisite:** Phase 2 test suite passes (53/53). Confirmed.
**Goal:** Replace paper stubs with real Dhan WebSocket feed and Dhan REST order API.
         No dashboard — position updates pushed to Telegram with per-notification toggles.

---

## What Gets Built

| # | File | Status |
|---|------|--------|
| T1 | `data/sources/dhan-source.js` | Replace stub with Dhan Market Feed v2 WebSocket |
| T2 | `execution/dhan-executor.js` | Real Dhan REST order placement & exit |
| T3 | `data/historical.js` + `data/options-chain.js` | Add `_fetchFromDhan()` branches |
| T4 | `notifications/telegram.js` | Notification flags + periodic P&L push |
| T5 | Integration, wiring, tests, `PHASE_3_COMPLETE.md` |

---

## Task 1 — Dhan WebSocket Source

**File:** `data/sources/dhan-source.js`
**Replaces:** current 3-line stub that throws

### Dhan Market Feed v2 Protocol
- WS URL: `wss://api-feed.dhan.co`
- Auth: send `{ LoginReq: { MsgCode: 11, ClientId, Token } }` immediately on connect
- Subscribe NIFTY spot: `{ Scrips: [{ ExchangeSegment: 'IDX_I', SecurityId: '13' }], MsgCode: 15 }`
- Tick message: extract `LTP` field

### Class: `DhanSource`
```
start()
  _connect()

_connect()
  this._ws = new WebSocket('wss://api-feed.dhan.co')
  on('open')    → _authenticate() → _subscribe()
  on('message') → _onMessage(data)
  on('close')   → _scheduleReconnect()
  on('error')   → log WARN

_authenticate()
  ws.send({ LoginReq: { MsgCode: 11, ClientId: config.DHAN_CLIENT_ID, Token: config.DHAN_ACCESS_TOKEN } })

_subscribe()
  ws.send({ Scrips: [{ ExchangeSegment: 'IDX_I', SecurityId: '13' }], MsgCode: 15 })

_onMessage(raw)
  const msg = JSON.parse(raw)
  if msg.LTP → eventBus.emit(EVENTS.TICK_RECEIVED, { ltp: msg.LTP, timestamp: Date.now() })

_scheduleReconnect()
  this._failCount++
  if failCount >= 10 → emit CIRCUIT_BREAKER_HIT (websocket_timeout); return
  setTimeout(_connect, min(1000 * 2^failCount, 30000))
```

### Tests (`test-phase3-dhan-source.js`)
| T | Check |
|---|-------|
| T01 | Auth message sent on WS open |
| T02 | Subscribe message sent after auth |
| T03 | LTP message → TICK_RECEIVED with correct value |
| T04 | Non-LTP messages silently ignored |
| T05 | WS close → reconnect scheduled |
| T06 | 10 failures → CIRCUIT_BREAKER_HIT, no further reconnect |

---

## Task 2 — Dhan REST Executor

**File:** `execution/dhan-executor.js`  **Extends:** `OrderExecutor`

### Dhan Order API
- Base: `https://api.dhan.co`  Header: `access-token: config.DHAN_ACCESS_TOKEN`
- Place: `POST /orders` → `{ dhanClientId, transactionType, exchangeSegment: 'NSE_FNO', productType: 'INTRADAY', orderType: 'MARKET', validity: 'DAY', securityId, quantity }`
- Poll fill: `GET /orders/{orderId}` until status = `'TRADED'` (max 5 polls × 1s)
- Cancel: `DELETE /orders/{orderId}`

### Class: `DhanExecutor extends OrderExecutor`
```
constructor()
  this._http = axios.create({ baseURL: config.DHAN_BASE_URL, headers: { 'access-token': config.DHAN_ACCESS_TOKEN } })
  this._activeOrders = {}
  this._lastStrikeData = {}
  eventBus.on(OPTIONS_CHAIN_UPDATED, ({strikeData}) → this._lastStrikeData = strikeData)

async placeOrder(legs)
  for each leg: POST /orders, poll for fill, store averagePrice as fillPrice
  build fill (same shape as PaperExecutor: { orderId, legs, premiumCollected, timestamp })
  if any fillPrice > 5% from expected → emit CIRCUIT_BREAKER_HIT (breaker 3)
  this._activeOrders[fill.orderId] = fill
  emit ORDER_FILLED
  return fill

async exitOrder(orderId)
  for each leg: POST /orders with reversed transactionType
  compute realisedPnl = entryPremium − exitPremium
  delete this._activeOrders[orderId]
  emit ORDER_EXITED
  return exitResult

_strikeToSecurityId(leg)
  return this._lastStrikeData[leg.strike]?.dhanSecurityId?.[leg.type.toLowerCase()] ?? null
  // populated by _fetchFromDhan() in options-chain.js (Task 3)
```

### Config additions (`config.js`)
```js
DHAN_ORDER_POLL_MAX: 5,
DHAN_ORDER_POLL_MS: 1000,
DHAN_BASE_URL: 'https://api.dhan.co',
```

### Tests (`test-phase3-dhan-executor.js`)
| T | Check |
|---|-------|
| T01 | placeOrder calls POST /orders for each leg |
| T02 | exitOrder reverses transactionType for each leg |
| T03 | computeUnrealisedPnl uses strikeData prices |
| T04 | fillPrice > 5% deviation emits CIRCUIT_BREAKER_HIT |
| T05 | REST failure throws, ORDER_FILLED not emitted |

---

## Task 3 — Dhan Data Branches

### `data/options-chain.js`

Add `_fetchFromDhan()`:
```
GET /expiry-list?underlyingScrip=NIFTY → nearest expiry date
GET /options/chain?underlyingScrip=NIFTY&expiryDate=<nearest>
parse → same output shape as _parseOptionChain()
CRITICAL: include dhanSecurityId per strike+type in strikeData:
  strikeData[strike] = { ce: lastPrice, pe: lastPrice, dhanSecurityId: { ce: '<id>', pe: '<id>' } }
```

Modify `_tick()`:
```js
if (config.DATA_SOURCE === 'DHAN') result = await this._fetchFromDhan();
else { const raw = await nse.getIndexOptionChain('NIFTY'); result = this._parseOptionChain(raw); }
```

### `data/historical.js`

Add `_fetchFromDhan()`:
```
GET https://api.dhan.co/charts/historical
  params: { securityId: 13, exchangeSegment: 'IDX_I', instrument: 'INDEX', expiryCode: 0, oi: 0, fromDate, toDate, interval: 15 }
  header: { access-token: config.DHAN_ACCESS_TOKEN }
response shape: { open:[], high:[], low:[], close:[], volume:[], timestamp:[] }
map → standard candle shape
```

Modify `fetch()`: when `DATA_SOURCE === 'DHAN'`, try `_fetchFromDhan()` first before existing NSE→Yahoo→cache chain.

### Tests (`test-phase3-data-dhan.js`)
| T | Check |
|---|-------|
| T01 | options-chain _fetchFromDhan parses response to correct shape |
| T02 | strikeData includes dhanSecurityId when DATA_SOURCE=DHAN |
| T03 | _tick() calls _fetchFromDhan when DATA_SOURCE=DHAN |
| T04 | historical _fetchFromDhan maps response to candle shape |
| T05 | DATA_SOURCE=DHAN: Dhan tried first, falls back to NSE on failure |

---

## Task 4 — Telegram Notification Flags + P&L Push

**File:** `notifications/telegram.js`  (modify existing)

### What's new

1. **Notification flags** — per-type toggles, on by default, toggleable via `/notify` command
2. **Periodic P&L push** — every 15 minutes while a position is open, push unrealised P&L
3. **ORDER_FILLED notification** — send order fill summary to Telegram (currently missing)

### Notification types and defaults

| Key | Default | What it sends |
|-----|---------|---------------|
| `ORDER_FILLED` | ON | Strike legs + premium collected, on fill |
| `POSITION_UPDATE` | ON | Unrealised P&L every 15 min while open |
| `POSITION_FLAGGED` | ON | Anti-hunt rule flag + deltas (existing) |
| `CIRCUIT_BREAKER` | ON | Circuit breaker name + reason (existing) |
| `CHAIN_STALE` | ON | Options chain data stale warning (existing) |
| `TRADE_CLOSED` | ON | Realised P&L + duration + reason (existing) |

`SIGNAL_GENERATED` (trade approval) is always on — cannot be toggled.

### State additions to `TelegramNotifier`
```js
this._notifyFlags = {
  ORDER_FILLED:     true,
  POSITION_UPDATE:  true,
  POSITION_FLAGGED: true,
  CIRCUIT_BREAKER:  true,
  CHAIN_STALE:      true,
  TRADE_CLOSED:     true,
};
this._pnlPushTimer = null;   // interval for periodic P&L push
this._activePnl    = null;   // { orderId, unrealisedPnl } — updated from POSITION_UPDATED
```

### New inbound command: `/notify`
```
/notify               → list all flags with on/off status
/notify off <TYPE>    → disable a notification type
/notify on <TYPE>     → enable a notification type
```

Example response to `/notify`:
```
Notification Flags:
ORDER_FILLED     ✓
POSITION_UPDATE  ✓
POSITION_FLAGGED ✓
CIRCUIT_BREAKER  ✓
CHAIN_STALE      ✓
TRADE_CLOSED     ✓
```

### New outbound: ORDER_FILLED handler
```js
eventBus.on(EVENTS.ORDER_FILLED, (fill) => this._onFilled(fill))

_onFilled(fill)
  if (!this._notifyFlags.ORDER_FILLED) return
  text = [
    '*Order Placed*',
    `Premium collected: ₹${fill.premiumCollected}`,
    legs summary (4 lines: action | type | strike | fillPrice)
  ].join('\n')
  sendMessage(...)
  // Start P&L push timer
  this._startPnlPush()
```

### New outbound: periodic P&L push
```js
_startPnlPush()
  if (this._pnlPushTimer) return  // already running
  this._pnlPushTimer = setInterval(() => this._pushPnl(), 15 * 60 * 1000)

_pushPnl()
  if (!this._notifyFlags.POSITION_UPDATE) return
  if (!this._activePnl) return
  text = `Position Update\nOrder: ${this._activePnl.orderId}\nUnrealised P&L: ₹${this._activePnl.unrealisedPnl}`
  sendMessage(...)

_stopPnlPush()
  clearInterval(this._pnlPushTimer)
  this._pnlPushTimer = null
  this._activePnl = null

// Wire POSITION_UPDATED to update _activePnl
eventBus.on(EVENTS.POSITION_UPDATED, ({ orderId, unrealisedPnl }) => {
  this._activePnl = { orderId, unrealisedPnl }
})

// Wire POSITION_CLOSED to stop timer
eventBus.on(EVENTS.POSITION_CLOSED, ...) → existing _onClosed + _stopPnlPush()
```

### Guard helper
```js
_send(flagKey, chatId, text, opts)
  if (!this._notifyFlags[flagKey]) return
  this._bot.sendMessage(chatId, text, opts)
```

Replace all `this._bot.sendMessage(...)` calls (except approval) with `this._send(flagKey, ...)`.

### Tests (`test-phase3-telegram.js`)
| T | Check |
|---|-------|
| T01 | ORDER_FILLED → sends fill summary when flag ON |
| T02 | ORDER_FILLED → no message when flag OFF |
| T03 | /notify → lists all flags with status |
| T04 | /notify off ORDER_FILLED → flag set to false |
| T05 | /notify on ORDER_FILLED → flag set back to true |
| T06 | POSITION_UPDATED → _activePnl updated |
| T07 | POSITION_CLOSED → P&L timer cleared |
| T08 | POSITION_FLAGGED → no message when POSITION_FLAGGED flag OFF |

---

## Task 5 — Integration & Wiring

### `index.js` — executor selection

Replace hard-coded paper-executor line in Phase 2 boot block:
```js
// Before (Phase 2):
require('./execution/paper-executor');

// After (Phase 3):
const executor = config.EXECUTION_MODE === 'LIVE'
  ? require('./execution/dhan-executor')
  : require('./execution/paper-executor');
```

No other `index.js` change needed — position-tracker and strategy use executor
indirectly via event bus only.

### `package.json`
```json
"test:phase3": "node test-phase3-dhan-source.js && node test-phase3-dhan-executor.js && node test-phase3-data-dhan.js && node test-phase3-telegram.js"
```

### Definition of Done
- [ ] `DATA_SOURCE=DHAN` boots without throwing
- [ ] `EXECUTION_MODE=LIVE` routes through DhanExecutor
- [ ] ORDER_FILLED message sent to Telegram on trade fill
- [ ] P&L update sent every 15 min while position open (if flag on)
- [ ] `/notify` command toggles individual notification types
- [ ] `npm run test:phase3` → all tests pass
- [ ] `npm run test:phase0 && npm run test:phase1 && npm run test:phase2 && npm run test:phase3` → green
- [ ] `PHASE_3_COMPLETE.md` written
- [ ] Single git commit: `feat: Phase 3 complete — Dhan WebSocket, live executor, Telegram notification flags`
