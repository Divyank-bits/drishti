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
    this._authorizedId  = parseInt(config.TELEGRAM_CHAT_ID, 10);
    this._authorizedIds = new Set(config.TELEGRAM_AUTHORIZED_USER_IDS || [this._authorizedId]);
    this._registerInbound();
    this._registerOutbound();
    this._setCommandMenu();
    log('INFO', 'Telegram bot started');
  }

  _setCommandMenu() {
    this._bot.setMyCommands([
      { command: 'status',     description: 'Current position, P&L, regime' },
      { command: 'mode',       description: 'Switch mode — /mode [AI|RULES|HYBRID]' },
      { command: 'datasource', description: 'Switch data source — /datasource [NSE|DHAN]' },
      { command: 'scan',       description: 'Equity scan — /scan SYMBOL [--claude|--confirm]' },
      { command: 'pause',      description: 'Pause new trade entries' },
      { command: 'resume',     description: 'Resume trade entries' },
      { command: 'squareoff',  description: 'Manually square off all positions' },
      { command: 'help',       description: 'Show all available commands' },
    ]).catch(err => log('WARN', `setMyCommands failed: ${err.message}`));
  }

  // ── Inbound ───────────────────────────────────────────────────────────────

  _registerInbound() {
    this._bot.on('message', (msg) => {
      if (!this._authorizedIds.has(msg.from.id)) return;  // silently ignore unauthorized

      const text   = (msg.text || '').trim();
      const chatId = msg.chat.id;

      if (text === '/help' || text === '/start') {
        this._bot.sendMessage(chatId,
          `*Drishti Commands*\n\n` +
          `/status — position, P&L, regime\n` +
          `/mode [AI|RULES|HYBRID] — switch intelligence mode\n` +
          `/datasource [NSE|DHAN] — switch data source\n` +
          `/scan SYMBOL — equity directional scan\n` +
          `/scan SYMBOL --claude — scan with Claude analysis\n` +
          `/scan SYMBOL --confirm — rules + Claude confirmation\n` +
          `/pause — block new trade entries\n` +
          `/resume — unblock entries\n` +
          `/squareoff — manually exit all positions\n` +
          `/help — show this message`,
          { parse_mode: 'Markdown' }
        );
        return;
      }
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
        if (['AI', 'RULES', 'HYBRID'].includes(mode)) {
          config.INTELLIGENCE_MODE = mode;
          this._bot.sendMessage(chatId, `Switched to ${mode} mode.${footer()}`);
        } else {
          this._bot.sendMessage(chatId, `Current mode: ${config.INTELLIGENCE_MODE}\nUsage: /mode [AI|RULES|HYBRID]${footer()}`);
        }
        return;
      }
      if (text.startsWith('/datasource')) {
        const src = (text.split(' ')[1] || '').toUpperCase();
        if (['NSE', 'DHAN'].includes(src)) {
          config.DATA_SOURCE = src;
          this._bot.sendMessage(chatId, `Data source switched to ${src}. Note: restart required for tick stream to reconnect.${footer()}`);
        } else {
          this._bot.sendMessage(chatId, `Current data source: ${config.DATA_SOURCE}\nUsage: /datasource [NSE|DHAN]${footer()}`);
        }
        return;
      }
      if (text.startsWith('/scan')) {
        const parts  = text.split(/\s+/);
        const symbol = (parts[1] || '').toUpperCase() || null;
        const flag   = (parts[2] || '').toLowerCase(); // '--claude' | '--confirm' | ''

        if (!symbol) {
          this._bot.sendMessage(chatId, `Usage: /scan SYMBOL [--claude|--confirm]\nExamples:\n  /scan BANKNIFTY\n  /scan RELIANCE\n  /scan RELIANCE --claude\n  /scan RELIANCE --confirm${footer()}`);
          return;
        }

        // ── Equity directional scan (Phase 6) — non-index symbols ─────────────
        const INDEX_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']);
        if (!INDEX_SYMBOLS.has(symbol)) {
          const mode = flag === '--claude' ? 'claude' : flag === '--confirm' ? 'confirm' : 'rules';
          this._bot.sendMessage(chatId, `Scanning ${symbol} [equity, mode=${mode}]...${footer()}`);
          const equityScanner = require('../intelligence/equity-scanner');
          equityScanner.scan(symbol, mode)
            .then((result) => {
              if (result.error) {
                this._bot.sendMessage(chatId, `Equity scan failed for ${symbol}: ${result.error}${footer()}`);
                return;
              }
              const c   = result.confluence || {};
              const ctx = result.context   || {};

              const tfLine = c.timeframeScores
                ? `15m: ${c.timeframeScores[15] ?? 0}%  5m: ${c.timeframeScores[5] ?? 0}%  1m: ${c.timeframeScores[1] ?? 0}%`
                : 'N/A';

              const stateEmoji = c.state === 'CONFIRMED' ? '✅' : c.state === 'FORMING' ? '⏳' : '—';

              const lines = [
                `*${symbol} — ${c.dominantPattern ?? 'No Pattern'} [${c.state ?? 'NONE'}]* ${stateEmoji}`,
                `Direction: ${c.dominantDirection ?? 'N/A'}`,
                `Confluence: ${c.score ?? 0}% (${tfLine})`,
                ``,
                `Price vs VWAP: ${ctx.vwap != null ? (result.context ? 'see levels' : 'N/A') : 'N/A'}`,
                `Key Levels: PDH ${ctx.prevDayHigh ?? 'N/A'} | PDL ${ctx.prevDayLow ?? 'N/A'} | Day Open ${ctx.dayOpen ?? 'N/A'}`,
                `VWAP: ${ctx.vwap != null ? ctx.vwap.toFixed(2) : 'N/A'}`,
              ];

              // Top signals per timeframe
              const sigMap = {};
              for (const sr of (result.strategyResults || [])) {
                if (sr.signals && sr.signals.length > 0) {
                  sigMap[sr.timeframe] = sigMap[sr.timeframe] || [];
                  sigMap[sr.timeframe].push(`${sr.strategy}: ${sr.signals[0]}`);
                }
              }
              if (Object.keys(sigMap).length > 0) {
                lines.push(`\nSignals:`);
                for (const tf of [15, 5, 1]) {
                  if (sigMap[tf]) lines.push(`• ${tf}m: ${sigMap[tf].join('; ')}`);
                }
              }

              // Claude reasoning if present
              if (result.claudeReasoning?.reasoning) {
                lines.push(`\nClaude: "${result.claudeReasoning.reasoning}"`);
              }

              lines.push(`\nScan: ${mode.toUpperCase()} | ${new Date().toTimeString().slice(0, 8)}`);

              this._bot.sendMessage(chatId, lines.join('\n') + footer(), { parse_mode: 'Markdown' });
            })
            .catch((err) => {
              this._bot.sendMessage(chatId, `Equity scan error for ${symbol}: ${err.message}${footer()}`);
            });
          return;
        }

        // ── Index deep scan (Phase 5) ─────────────────────────────────────────
        this._bot.sendMessage(chatId, `Scanning ${symbol}...${footer()}`);
        const symbolScanner = require('../intelligence/symbol-scanner');
        symbolScanner.scan(symbol)
          .then((result) => {
            if (result.error) {
              this._bot.sendMessage(chatId, `Scan failed for ${symbol}: ${result.error}${footer()}`);
              return;
            }
            const stratLines = (result.strategyScores || [])
              .map((s) => `  ${s.strategy}: score=${s.score} eligible=${s.eligible}`)
              .join('\n') || '  none';
            const text2 = [
              `*Scan Result: ${symbol}*`,
              `Composite Score: ${result.score}/100`,
              `Underlying: ${result.chain?.underlyingValue ?? 'N/A'}  ATM: ${result.chain?.atmStrike ?? 'N/A'}`,
              `PCR: ${result.chain?.pcr ?? 'N/A'}  VIX: ${result.chain?.vix ?? 'N/A'}`,
              `RSI: ${result.indicators?.rsi?.toFixed(1) ?? 'N/A'}  BB Width: ${result.indicators?.bbWidth?.toFixed(2) ?? 'N/A'}%`,
              `\nStrategy Scores:\n${stratLines}`,
              result.score >= require('../config').DEEP_SCAN_CONFIDENCE_THRESHOLD
                ? `\n⚡ FLAGGED — score above threshold` : '',
            ].filter(Boolean).join('\n');
            this._bot.sendMessage(chatId, text2 + footer(), { parse_mode: 'Markdown' });
          })
          .catch((err) => {
            this._bot.sendMessage(chatId, `Scan error for ${symbol}: ${err.message}${footer()}`);
          });
        return;
      }
      if (text === '/watchlist') {
        const watchlistManager = require('../intelligence/watchlist-manager');
        const ranked = watchlistManager.getRanked();
        if (ranked.length === 0) {
          this._bot.sendMessage(chatId, `Watchlist is empty — no scan results yet.${footer()}`);
          return;
        }
        const lines = ranked.map((e, i) => `${i + 1}. ${e.symbol}: ${e.score}/100`).join('\n');
        this._bot.sendMessage(chatId, `*Watchlist (${ranked.length} symbols)*\n${lines}${footer()}`, { parse_mode: 'Markdown' });
        return;
      }
      if (text === '/status') {
        const snap = (() => {
          try { return require('../core/session-context').shared.snapshot(); } catch { return {}; }
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

  /**
   * Sends a freeform alert message to the authorised chat.
   * Safe to call before start() — silently skips if bot not yet initialised.
   * @param {string} text - Plain or Markdown text
   */
  sendAlert(text) {
    if (!this._bot) return;
    this._bot.sendMessage(this._authorizedId, text + footer(), { parse_mode: 'Markdown' });
  }
}

module.exports = new TelegramNotifier();
