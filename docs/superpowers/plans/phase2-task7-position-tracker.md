# Task 7: Position Tracker

**Files:**
- Create: `monitoring/position-tracker.js`

No separate test file — covered by integration test (Task 9).

## Spec

Class that wires the event bus to `anti-hunt.evaluate()`. Exports a singleton instance.

### State
```js
_activeFill      // { orderId, legs, strikes, premiumCollected } — set on ORDER_FILLED
_entryTime       // Date.now() at fill
_lastKnownPnl    // updated on OPTIONS_CHAIN_UPDATED
_exiting         // boolean guard against double-exit
_candleVolumes   // rolling 20 candle volumes for Rule 3 avg
_ceDelta / _peDelta  // updated on INDICATORS_UPDATED (timeframe === 'options')
```

### Event subscriptions (registered in constructor)
| Event | Handler |
|-------|---------|
| `ORDER_FILLED` | `_onFill(fill)` — set state, `stateMachine.transition('ACTIVE')`, journal write |
| `TICK_RECEIVED` | `_onTick(ltp)` — emit `POSITION_UPDATED` with last known P&L |
| `CANDLE_CLOSE_15M` | `_onCandle(candle)` — anti-hunt eval + square-off time check |
| `INDICATORS_UPDATED` | update `_ceDelta` / `_peDelta` when `payload.timeframe === 'options'` |
| `EXIT_TRIGGERED` | `_exit('Manual/circuit exit')` |
| `MANUAL_SQUAREOFF_REQUESTED` | `_exit('Manual square-off via Telegram')` |

`OPTIONS_CHAIN_UPDATED` wired after construction to avoid circular require:
```js
const tracker = new PositionTracker();
eventBus.on(EVENTS.OPTIONS_CHAIN_UPDATED, (payload) => tracker._onOptionsChain(payload));
```

### _onCandle logic
1. Update rolling volume history (skip if `volume === 0`)
2. `avgVolume = mean of _candleVolumes`
3. Check square-off time (15:15 IST) → `_exit('Square-off time 15:15 IST')`
4. Build `position` object for anti-hunt
5. Call `antiHunt.evaluate(position, candle, sessionContext.snapshot())`
6. If `decision.flagged` → `stateMachine.transition('FLAGGED')`, emit `POSITION_FLAGGED`, journal write
7. If `decision.shouldExit` → `_exit(decision.reason)`

### _exit logic
Guard: `if (!_activeFill || _exiting) return`
1. `_exiting = true`
2. `stateMachine.transition('EXITING')`
3. `paperExecutor.exitOrder(orderId)` → `exitResult`
4. Journal: `ORDER_EXITED`, `TRADE_CLOSED`
5. `stateMachine.transition('CLOSED')`
6. Emit `POSITION_CLOSED`
7. Reset all state, `stateMachine.transition('IDLE')`

### IST helper (same as anti-hunt)
```js
function toIST(tsMs) { ... } // copy from anti-hunt pattern
```

### Imports
```js
const eventBus      = require('../core/event-bus');
const EVENTS        = require('../core/events');
const stateMachine  = require('../core/state-machine');
const antiHunt      = require('./anti-hunt');
const paperExecutor = require('../execution/paper-executor');
const journal       = require('../journal/trade-journal');
const config        = require('../config');
```
`session-context` required lazily inside `_onCandle` to avoid circular: `require('../core/session-context').snapshot()`
