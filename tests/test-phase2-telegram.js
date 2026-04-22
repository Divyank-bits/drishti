/**
 * @file test-phase2-telegram.js
 * @description Phase 2 Gate 5 — Telegram bot approval flow and commands.
 *              Mocks node-telegram-bot-api — no real bot token needed.
 */
'use strict';

const assert       = require('assert');
const EventEmitter = require('events');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

console.log('\n── Telegram Bot Tests ───────────────────────────────────────────\n');

// ── Mock TelegramBot ──────────────────────────────────────────────────────
class MockTelegramBot extends EventEmitter {
  constructor() {
    super();
    this.sent   = [];
    this.edited = [];
  }
  sendMessage(chatId, text, opts) {
    const msg = { chatId, text, opts, message_id: Math.floor(Math.random() * 10000) + 1 };
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
  _pressButton(callbackData, fromId) {
    this.emit('callback_query', {
      id:      'cq-' + Date.now(),
      data:    callbackData,
      from:    { id: fromId },
      message: { message_id: this.sent[this.sent.length - 1]?.message_id || 1 },
    });
  }
  _sendCommand(text, fromId) {
    this.emit('message', {
      text,
      from: { id: fromId },
      chat: { id: fromId },
    });
  }
}

// ── Stub event bus ────────────────────────────────────────────────────────
const stubBus      = new EventEmitter();
const eventBusPath = require.resolve('./core/event-bus');
require.cache[eventBusPath] = { id: eventBusPath, filename: eventBusPath, loaded: true, exports: stubBus };

const TelegramNotifier = require('../notifications/telegram');
const config           = require('../config');

const AUTHORIZED_ID = 123456789;
config.TELEGRAM_CHAT_ID = String(AUTHORIZED_ID);

TelegramNotifier.start(MockTelegramBot);
const mockBot = TelegramNotifier._bot;

(async () => {

  await test('T01 SIGNAL_GENERATED → sends approval message with YES/NO inline keyboard', async () => {
    stubBus.emit('SIGNAL_GENERATED', {
      strategy: 'Iron Condor',
      strikes:  { shortCe: 24400, longCe: 24600, shortPe: 24000, longPe: 23800 },
      expectedPremium:     500,
      indicatorSnapshot:   { rsi: 50, vix: 16 },
      optionsSnapshot:     { vix: 16, pcr: 1.05, atmStrike: 24200 },
      timestamp:           new Date().toISOString(),
    });
    await new Promise(r => setTimeout(r, 50));
    const last = mockBot.sent[mockBot.sent.length - 1];
    assert(last, 'message was sent');
    const buttons = last.opts?.reply_markup?.inline_keyboard?.flat() || [];
    assert(buttons.some(b => b.callback_data === 'APPROVE'), 'has APPROVE button');
    assert(buttons.some(b => b.callback_data === 'REJECT'),  'has REJECT button');
    // Clear timeout to avoid polluting later tests
    if (TelegramNotifier._pendingApproval) {
      clearTimeout(TelegramNotifier._pendingApproval.timer);
      TelegramNotifier._pendingApproval = null;
    }
  });

  await test('T02 YES button press → emits USER_APPROVED', async () => {
    // Set up fresh signal so _pendingApproval is populated
    stubBus.emit('SIGNAL_GENERATED', {
      strategy: 'Iron Condor', strikes: { shortCe: 24400, longCe: 24600, shortPe: 24000, longPe: 23800 },
      expectedPremium: 500, indicatorSnapshot: {}, optionsSnapshot: {}, timestamp: new Date().toISOString(),
    });
    await new Promise(r => setTimeout(r, 50));

    let approved = false;
    stubBus.once('USER_APPROVED', () => { approved = true; });
    mockBot._pressButton('APPROVE', AUTHORIZED_ID);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(approved, true, 'USER_APPROVED was emitted');
  });

  await test('T03 NO button press → emits USER_REJECTED', async () => {
    stubBus.emit('SIGNAL_GENERATED', {
      strategy: 'Iron Condor', strikes: { shortCe: 24400, longCe: 24600, shortPe: 24000, longPe: 23800 },
      expectedPremium: 400, indicatorSnapshot: {}, optionsSnapshot: {}, timestamp: new Date().toISOString(),
    });
    await new Promise(r => setTimeout(r, 50));

    let rejected = false;
    stubBus.once('USER_REJECTED', () => { rejected = true; });
    mockBot._pressButton('REJECT', AUTHORIZED_ID);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(rejected, true, 'USER_REJECTED was emitted');
  });

  await test('T04 unauthorized sender → message silently ignored', async () => {
    const countBefore = mockBot.sent.length;
    mockBot._sendCommand('/status', 99999);
    await new Promise(r => setTimeout(r, 50));
    const newToUnauth = mockBot.sent.slice(countBefore).filter(m => m.chatId === 99999);
    assert.strictEqual(newToUnauth.length, 0, 'no response sent to unauthorized sender');
  });

  await test('T05 /pause command → emits PAUSE_REQUESTED', async () => {
    let emitted = false;
    stubBus.once('PAUSE_REQUESTED', () => { emitted = true; });
    mockBot._sendCommand('/pause', AUTHORIZED_ID);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(emitted, true, 'PAUSE_REQUESTED emitted');
  });

  await test('T06 /resume command → emits RESUME_REQUESTED', async () => {
    let emitted = false;
    stubBus.once('RESUME_REQUESTED', () => { emitted = true; });
    mockBot._sendCommand('/resume', AUTHORIZED_ID);
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(emitted, true, 'RESUME_REQUESTED emitted');
  });

  await test('T07 approval timeout → emits USER_REJECTED + sends Auto-rejected message', async () => {
    const origTimeout = config.TRADE_APPROVAL_TIMEOUT_MS;
    config.TRADE_APPROVAL_TIMEOUT_MS = 100;

    stubBus.emit('SIGNAL_GENERATED', {
      strategy: 'Iron Condor', strikes: { shortCe: 24400, longCe: 24600, shortPe: 24000, longPe: 23800 },
      expectedPremium: 300, indicatorSnapshot: {}, optionsSnapshot: {}, timestamp: new Date().toISOString(),
    });

    let timedOut = false;
    stubBus.once('USER_REJECTED', () => { timedOut = true; });

    await new Promise(r => setTimeout(r, 250));
    config.TRADE_APPROVAL_TIMEOUT_MS = origTimeout;
    assert.strictEqual(timedOut, true, 'USER_REJECTED emitted on timeout');
    const autoMsg = mockBot.sent.find(m => m.text && m.text.includes('Auto-rejected'));
    assert(autoMsg, 'Auto-rejected message was sent');
  });

  console.log(`\n${passed + failed} tests — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
