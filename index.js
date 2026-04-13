/**
 * @file index.js
 * @description Drishti application entry point. Runs the boot sequence in order:
 *                1. Load and validate config + environment
 *                2. Initialise event bus
 *                3. Initialise circuit breaker
 *                4. Initialise session context
 *                5. Load strategy registry
 *                6. Emit SYSTEM_READY
 *
 *              Phases 1–5 will add their own boot steps after step 4.
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
  const REQUIRED_KEYS = ['ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = REQUIRED_KEYS.filter((key) => !config[key]);

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
  const sessionContext = new SessionContext();
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

  // ── Step 7: System ready ──────────────────────────────────────────────────
  // Phase 2: init position tracker, paper executor, Telegram bot, dashboard server, cron jobs

  return { circuitBreaker, sessionContext, registry };
}

// ── Entry ──────────────────────────────────────────────────────────────────
boot().catch((err) => {
  const ts = new Date().toTimeString().slice(0, 8);
  console.error(`[${ts}] [System] [FATAL] Boot failed: ${err.message}`);
  if (config.IS_DEV) console.error(err.stack);
  process.exit(1);
});
