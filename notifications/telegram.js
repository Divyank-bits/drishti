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
    this._authorizedId    = null;
    this._pendingApproval = null;  // { messageId, timer }
  }

  /**
   * Initialise the bot and register all listeners.
   * @param {Function} [BotClass] — inject mock class for tests
   */
  start(BotClass) {
    const Bot          = BotClass || require('node-telegram-bot-api');
    this._bot          = new Bot(config.TELEGRAM_BOT_TOKEN || 'TEST_TOKEN', { polling: true });
    this._authorizedId = parseInt(config.TELEGRAM_CHAT_ID, 10);
    this._registerInbound();
    this._registerOutbound();
    log('INFO', 'Telegram bot started');
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  _registerInbound() {
    this._bot.on('message', (msg) => {
      if (msg.from.id !== this._authorizedId) return;  // silently ignore unauthorized

      const text   = (msg.text || '').trim();
      const chatId = msg.chat.id;

      if (text === '/pause') {
        eventBus.emit(EVENTS.PAUSE_REQUESTED, {});
        this._bot.sendMessage(chatId, `Trading paused. New entries blocked.${footer()}`);
        return;
      }
      if (text === '/resume') {
        eventBus.emit(EVENTS.RESUME_REQUESTED, {});
        this._bot.sendMessage(chatId, `Trading resumed.${footer()}`);
        return;
      }
      if (text === '/squareoff') {
        eventBus.emit(EVENTS.EXIT_TRIGGERED, { source: 'TELEGRAM_MANUAL' });
        this._bot.sendMessage(chatId, `Manual square-off triggered.${footer()}`);
        return;
      }
      if (text.startsWith('/mode')) {
        const mode = (text.split(' ')[1] || '').toUpperCase();
        if (mode === 'RULES') {
          config.INTELLIGENCE_MODE = 'RULES';
          this._bot.sendMessage(chatId, `Switched to RULES mode.${footer()}`);
        } else if (['AI', 'HYBRID'].includes(mode)) {
          this._bot.sendMessage(chatId, `Mode ${mode} not yet implemented. Staying on RULES.${footer()}`);
        } else {
          this._bot.sendMessage(chatId, `Usage: /mode [AI|RULES|HYBRID]${footer()}`);
        }
        return;
      }
      if (text === '/status') {
        const snap = (() => {
          try { return require('../core/session-context').snapshot(); } catch { return {}; }
        })();
        const lines = [
          `*Drishti Status*`,
          `Mode: ${config.INTELLIGENCE_MODE}`,
          `Execution: ${config.EXECUTION_MODE}`,
          `Day P&L: ₹${snap.pnlToday ?? 0}`,
          `Trades today: ${snap.tradesToday ?? 0}`,
          `VIX: ${snap.vixCurrent ?? 'N/A'}`,
        ].join('\n');
        this._bot.sendMessage(chatId, lines + footer(), { parse_mode: 'Markdown' });
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

  // ── Outbound ──────────────────────────────────────────────────────────────

  _registerOutbound() {
    eventBus.on(EVENTS.SIGNAL_GENERATED,    (payload) => this._onSignal(payload));
    eventBus.on(EVENTS.POSITION_FLAGGED,    (payload) => this._onFlagged(payload));
    eventBus.on(EVENTS.CIRCUIT_BREAKER_HIT, (payload) => this._onCircuitBreaker(payload));
    eventBus.on(EVENTS.OPTIONS_CHAIN_STALE, (payload) => this._onStale(payload));
    eventBus.on(EVENTS.POSITION_CLOSED,     (payload) => this._onClosed(payload));
  }

  async _onSignal(payload) {
    if (!this._bot) return;
    const { strikes, expectedPremium, optionsSnapshot } = payload;
    const text = [
      `*New Iron Condor Signal*`,
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
          { text: 'YES', callback_data: 'APPROVE' },
          { text: 'NO',  callback_data: 'REJECT'  },
        ]],
      },
    });

    const timer = setTimeout(() => {
      if (!this._pendingApproval) return;
      this._pendingApproval = null;
      eventBus.emit(EVENTS.USER_REJECTED, { source: 'TELEGRAM', reason: 'Timeout' });
      this._bot.sendMessage(this._authorizedId, `Auto-rejected (timeout — no response in 3 minutes).${footer()}`);
      log('WARN', 'Trade approval timed out');
    }, config.TRADE_APPROVAL_TIMEOUT_MS);

    this._pendingApproval = { messageId: msg.message_id, timer };
  }

  _onFlagged(payload) {
    if (!this._bot) return;
    const text = `*High Risk Alert*\nRule ${payload.rule}: ${payload.reason}\nCE delta: ${payload.ceDelta ?? 'N/A'} | PE delta: ${payload.peDelta ?? 'N/A'}`;
    this._bot.sendMessage(this._authorizedId, text + footer(), { parse_mode: 'Markdown' });
  }

  _onCircuitBreaker(payload) {
    if (!this._bot) return;
    const text = `*Circuit Breaker Tripped*\n${payload.breakerName}: ${payload.reason}`;
    this._bot.sendMessage(this._authorizedId, text + footer(), { parse_mode: 'Markdown' });
  }

  _onStale(payload) {
    if (!this._bot) return;
    this._bot.sendMessage(this._authorizedId, `Options chain data stale: ${payload.reason}${footer()}`);
  }

  _onClosed(payload) {
    if (!this._bot) return;
    const text = `*Trade Closed*\nRealised P&L: ₹${payload.realisedPnl}\nDuration: ${payload.duration}s\nReason: ${payload.reason}`;
    this._bot.sendMessage(this._authorizedId, text + footer(), { parse_mode: 'Markdown' });
  }
}

module.exports = new TelegramNotifier();
