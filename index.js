/**
 * @file index.js
 * @description Drishti application entry point. Boot sequence:
 *                1. Validate config + environment
 *                2. Initialise event bus
 *                3. Initialise circuit breaker
 *                4. Initialise session context
 *                5. Load strategy registry
 *                6. Phase 1 data layer (historical, options chain, tick stream)
 *                7. Phase 2 trading layer (journal, executor, strategy, position tracker)
 *                8. Phase 3 intelligence layer (Claude client warmup)
 *
 *              Each step is guarded — failure halts the process immediately.
 */

'use strict';

const config = require('./config');
const eventBus = require('./core/event-bus');
const EVENTS = require('./core/events');
const CircuitBreaker = require('./core/circuit-breaker');
const SessionContext = require('./core/session-context');

// ── Logging helper ─────────────────────────────────────────────────────────
function log(level, module, message) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [${module}] [${level}] ${message}`);
}

// ── Boot sequence ──────────────────────────────────────────────────────────
async function boot() {
  log('INFO', 'System', 'Booting Drishti...');

  // ── Step 1: Validate environment ─────────────────────────────────────────
  // ANTHROPIC_API_KEY is required only in AI/HYBRID modes.
  const ALWAYS_REQUIRED = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const LIVE_REQUIRED   = config.EXECUTION_MODE === 'LIVE'
    ? ['DHAN_CLIENT_ID', 'DHAN_ACCESS_TOKEN']
    : [];
  const CLAUDE_REQUIRED = ['AI', 'HYBRID'].includes(config.INTELLIGENCE_MODE)
    ? ['ANTHROPIC_API_KEY']
    : [];

  const missing = [...ALWAYS_REQUIRED, ...LIVE_REQUIRED, ...CLAUDE_REQUIRED]
    .filter((key) => !config[key]);

  if (missing.length > 0) {
    log('ERROR', 'System', `Missing required environment variables: ${missing.join(', ')}`);
    log('ERROR', 'System', 'Copy .env.example to .env and fill in the missing values.');
    process.exit(1);
  }

  if (config.TELEGRAM_AUTHORIZED_USER_IDS.length === 0) {
    log('WARN', 'System', 'TELEGRAM_AUTHORIZED_USER_IDS is empty — bot will respond to anyone!');
  }

  log('INFO', 'System', `Intelligence mode : ${config.INTELLIGENCE_MODE}`);
  log('INFO', 'System', `Execution mode    : ${config.EXECUTION_MODE}`);
  log('INFO', 'System', `Data source       : ${config.DATA_SOURCE}`);
  log('INFO', 'System', `Environment       : ${config.NODE_ENV}`);

  // ── Step 2: Event bus ─────────────────────────────────────────────────────
  // Already initialised as a singleton on require — just wire up system-level listeners.
  eventBus.on(EVENTS.CIRCUIT_BREAKER_HIT, ({ breakerName, reason }) => {
    log('ERROR', 'System', `Circuit breaker tripped: [${breakerName}] — ${reason}`);
  });

  eventBus.on(EVENTS.STATE_TRANSITION, ({ from, to }) => {
    log('INFO', 'System', `Position state: ${from} → ${to}`);
  });

  log('INFO', 'EventBus', 'Ready');

  // ── Step 3: Circuit breaker ───────────────────────────────────────────────
  const circuitBreaker = new CircuitBreaker();
  log('INFO', 'CircuitBreaker', '7 breakers armed');

  // ── Step 4: Session context ───────────────────────────────────────────────
  const sessionContext = SessionContext.shared;
  log('INFO', 'SessionContext', `Session initialised for ${sessionContext.snapshot().date}`);

  // ── Step 5: Strategy registry ─────────────────────────────────────────────
  // Registry auto-discovers strategies on require() — just import it.
  const registry = require('./strategies/registry');
  log('INFO', 'Registry', `${registry.count} strategy/strategies available`);

  // ── Step 5b: System ready ─────────────────────────────────────────────────
  const summary = {
    intelligenceMode: config.INTELLIGENCE_MODE,
    executionMode: config.EXECUTION_MODE,
    strategiesLoaded: registry.count,
    timestamp: new Date().toISOString(),
  };

  log(
    'INFO',
    'System',
    `System ready | Mode: ${config.INTELLIGENCE_MODE} | Execution: ${config.EXECUTION_MODE} | Strategies: ${registry.count}`
  );

  eventBus.emit(EVENTS.SYSTEM_READY, summary);

  // ── Phase 1: Data layer ───────────────────────────────────────────────────
  const historical    = require('./data/historical');
  const optionsChain  = require('./data/options-chain');
  const tickStream    = require('./data/tick-stream');
  require('./data/candle-builder');   // wires TICK_RECEIVED listener
  require('./data/indicator-engine'); // wires CANDLE_CLOSE_* listeners

  // Step 6a: Fetch startup candle history (seeds CandleBuilder before tick stream opens)
  await historical.fetch();
  log('INFO', 'Historical', 'Startup candles loaded');

  // Step 6b: Start options chain polling
  optionsChain.start();
  log('INFO', 'OptionsChain', `Polling every ${config.OPTIONS_CHAIN_INTERVAL}m`);

  // Step 6c: Start tick stream (NSE polling or Dhan WS based on DATA_SOURCE config)
  tickStream.start();
  log('INFO', 'TickStream', `Starting tick stream (DATA_SOURCE=${config.DATA_SOURCE})`);

  // ── Phase 2: Trading Layer ─────────────────────────────────────────────────
  const journal  = require('./journal/trade-journal');
  const telegram = require('./notifications/telegram');

  const { pnlToday, tradesToday } = await journal.restoreFromJournal();
  if (pnlToday !== 0 || tradesToday !== 0) {
    log('INFO', 'Boot', `Restored: pnlToday=₹${pnlToday}, tradesToday=${tradesToday}`);
  }

  config.EXECUTION_MODE === 'LIVE'
    ? require('./execution/dhan-executor')
    : require('./execution/paper-executor');
  require('./strategies/iron-condor.strategy');
  require('./monitoring/position-tracker');

  telegram.start();

  // ── Phase 3: Intelligence layer ───────────────────────────────────────────
  const claudeClient = require('./intelligence/claude-client');
  if (claudeClient.isAvailable()) {
    log('INFO', 'ClaudeClient', `Ready — model: ${config.CLAUDE_MODEL}`);
  } else {
    log('WARN', 'ClaudeClient',
      'ANTHROPIC_API_KEY absent or unavailable — system will run in RULES-only mode');
  }

  log('INFO', 'System',
    `Boot complete | ` +
    `Intelligence: ${config.INTELLIGENCE_MODE} | ` +
    `Execution: ${config.EXECUTION_MODE} | ` +
    `Data: ${config.DATA_SOURCE} | ` +
    `Claude: ${claudeClient.isAvailable() ? 'online' : 'offline (RULES fallback)'}`
  );

  return { circuitBreaker, sessionContext, registry };
}

// ── Entry ──────────────────────────────────────────────────────────────────
boot().catch((err) => {
  const ts = new Date().toTimeString().slice(0, 8);
  console.error(`[${ts}] [System] [FATAL] Boot failed: ${err.message}`);
  if (config.IS_DEV) console.error(err.stack);
  process.exit(1);
});
