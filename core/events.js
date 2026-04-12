/**
 * @file events.js
 * @description All event name constants used on the Drishti event bus.
 *              Import these everywhere. Never use raw event name strings in the codebase.
 *              Adding a new event = add it here first, then use the constant.
 */

module.exports = Object.freeze({

  // ── Data Layer ──────────────────────────────────────────────────────────
  TICK_RECEIVED:            'TICK_RECEIVED',
  CANDLE_CLOSE_1M:          'CANDLE_CLOSE_1M',
  CANDLE_CLOSE_5M:          'CANDLE_CLOSE_5M',
  CANDLE_CLOSE_15M:         'CANDLE_CLOSE_15M',
  INDICATORS_UPDATED:       'INDICATORS_UPDATED',
  OPTIONS_CHAIN_UPDATED:    'OPTIONS_CHAIN_UPDATED',
  OPTIONS_CHAIN_STALE:      'OPTIONS_CHAIN_STALE',
  HISTORICAL_DATA_LOADED:   'HISTORICAL_DATA_LOADED',
  STARTUP_DATA_FAILED:      'STARTUP_DATA_FAILED',

  // ── WebSocket ────────────────────────────────────────────────────────────
  WEBSOCKET_CONNECTED:        'WEBSOCKET_CONNECTED',
  WEBSOCKET_DISCONNECTED:     'WEBSOCKET_DISCONNECTED',
  WEBSOCKET_RECONNECTED:      'WEBSOCKET_RECONNECTED',
  WEBSOCKET_RECONNECT_FAILED: 'WEBSOCKET_RECONNECT_FAILED',

  // ── Intelligence / Signal ────────────────────────────────────────────────
  SIGNAL_GENERATED:  'SIGNAL_GENERATED',
  SIGNAL_DISCARDED:  'SIGNAL_DISCARDED',
  CLAUDE_RESPONSE:   'CLAUDE_RESPONSE',
  CLAUDE_API_ERROR:  'CLAUDE_API_ERROR',

  // ── Telegram / User Commands ─────────────────────────────────────────────
  USER_APPROVED:              'USER_APPROVED',
  USER_REJECTED:              'USER_REJECTED',
  MANUAL_SQUAREOFF_REQUESTED: 'MANUAL_SQUAREOFF_REQUESTED',
  MODE_CHANGE_REQUESTED:      'MODE_CHANGE_REQUESTED',
  PAUSE_REQUESTED:            'PAUSE_REQUESTED',
  RESUME_REQUESTED:           'RESUME_REQUESTED',

  // ── Order Execution ──────────────────────────────────────────────────────
  ORDER_PLACING:         'ORDER_PLACING',
  ORDER_FILLED:          'ORDER_FILLED',
  ORDER_FAILED:          'ORDER_FAILED',
  ORDER_CANCELLED:       'ORDER_CANCELLED',
  PARTIAL_FILL_ROLLBACK: 'PARTIAL_FILL_ROLLBACK',

  // ── Position Lifecycle ───────────────────────────────────────────────────
  POSITION_ACTIVE:       'POSITION_ACTIVE',
  POSITION_FLAGGED:      'POSITION_FLAGGED',
  POSITION_CLOSED:       'POSITION_CLOSED',
  HUNT_SUSPECTED:        'HUNT_SUSPECTED',
  HUNT_DETECTION_RESULT: 'HUNT_DETECTION_RESULT',
  EXIT_TRIGGERED:        'EXIT_TRIGGERED',
  FORCE_EXIT:            'FORCE_EXIT',

  // ── State Machine ────────────────────────────────────────────────────────
  STATE_TRANSITION: 'STATE_TRANSITION',

  // ── Circuit Breakers ─────────────────────────────────────────────────────
  CIRCUIT_BREAKER_HIT:   'CIRCUIT_BREAKER_HIT',
  CIRCUIT_BREAKER_RESET: 'CIRCUIT_BREAKER_RESET',

  // ── System ───────────────────────────────────────────────────────────────
  SYSTEM_READY:        'SYSTEM_READY',
  DAILY_SUMMARY:       'DAILY_SUMMARY',
  PRE_MARKET_CHECK:    'PRE_MARKET_CHECK',
  SQUARE_OFF_TRIGGERED:'SQUARE_OFF_TRIGGERED',
});
