# Task 8: Telegram Bot

**Files:**
- Create: `notifications/telegram.js`
- Create: `test-phase2-telegram.js`

## Spec

Two-direction bot. Exports singleton. Call `start(BotClass?)` to initialise — `BotClass` param allows test injection.

Only responds to `TELEGRAM_CHAT_ID` — all other senders silently ignored.

### Inbound commands
| Command | Action |
|---------|--------|
| `/pause` | emit `PAUSE_REQUESTED`, reply confirmation |
| `/resume` | emit `RESUME_REQUESTED`, reply confirmation |
| `/squareoff` | emit `EXIT_TRIGGERED { source: 'TELEGRAM_MANUAL' }`, reply confirmation |
| `/mode RULES` | set `config.INTELLIGENCE_MODE = 'RULES'`, reply confirmation |
| `/mode AI\|HYBRID` | reply "not yet implemented", no change |
| `/status` | reply snapshot from `session-context.getSnapshot()` |
| unauthorized sender | silently ignore (no reply, no log) |

### Outbound events → messages
| Event | Message |
|-------|---------|
| `SIGNAL_GENERATED` | Trade approval message with YES/NO inline keyboard. Start 3-min timeout timer. |
| `POSITION_FLAGGED` | High risk alert with rule + deltas |
| `CIRCUIT_BREAKER_HIT` | Circuit breaker message |
| `OPTIONS_CHAIN_STALE` | Data stale warning |
| `POSITION_CLOSED` | Trade closed with P&L + duration |

### Approval flow
- On `SIGNAL_GENERATED`: send message, store `_pendingApproval = { messageId, timer }`
- On `callback_query` APPROVE: clearTimeout, emit `USER_APPROVED`, remove keyboard
- On `callback_query` REJECT: clearTimeout, emit `USER_REJECTED`, remove keyboard
- On timeout: emit `USER_REJECTED { reason: 'Timeout' }`, send "Auto-rejected" message

### Footer helper
```js
function footer() { return `\n\n_Mode: ${config.INTELLIGENCE_MODE}_`; }
```

### start() method
```js
start(BotClass) {
  const Bot = BotClass || require('node-telegram-bot-api');
  this._bot = new Bot(config.TELEGRAM_BOT_TOKEN || 'TEST_TOKEN', { polling: true });
  this._authorizedId = parseInt(config.TELEGRAM_CHAT_ID, 10);
  this._registerInbound();
  this._registerOutbound();
}
```

---

## Tests (test-phase2-telegram.js) — 7 async tests

Mock `TelegramBot` class with:
- `sent[]` / `edited[]` arrays
- `sendMessage()` → pushes to sent, resolves with `{ message_id }`
- `editMessageReplyMarkup()` → pushes to edited
- `answerCallbackQuery()` → resolves
- `_pressButton(callbackData, fromId)` → emits `callback_query` event
- `_sendCommand(text, fromId)` → emits `message` event

Inject stub event bus, inject `MockTelegramBot` via `TelegramNotifier.start(MockTelegramBot)`.

| Test | Action | Expected |
|------|--------|----------|
| T01 | emit `SIGNAL_GENERATED` | message sent with YES/NO inline keyboard |
| T02 | `_pressButton('APPROVE', AUTHORIZED_ID)` | `USER_APPROVED` emitted |
| T03 | emit signal then `_pressButton('REJECT', ...)` | `USER_REJECTED` emitted |
| T04 | `_sendCommand('/status', 99999)` (unauthorized) | no message sent to that chatId |
| T05 | `_sendCommand('/pause', AUTHORIZED_ID)` | `PAUSE_REQUESTED` emitted |
| T06 | `_sendCommand('/resume', AUTHORIZED_ID)` | `RESUME_REQUESTED` emitted |
| T07 | emit signal, set `TRADE_APPROVAL_TIMEOUT_MS=100`, wait 200ms | `USER_REJECTED` emitted + "Auto-rejected" message sent |

**Run:** `node test-phase2-telegram.js` → `7 tests — 7 passed, 0 failed`
