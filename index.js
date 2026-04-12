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

  // ── Step 6: System ready ──────────────────────────────────────────────────
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

  // ── Future phases add their boot steps here ──────────────────────────────
  // Phase 1: init tick stream, historical fetch, options chain, indicator engine
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
