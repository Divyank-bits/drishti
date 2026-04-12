/**
 * @file state-machine.js
 * @description Position state machine for Drishti. Defines every valid state and
 *              every valid transition between states. Invalid transitions throw errors
 *              — they never silently pass. Emits STATE_TRANSITION on every move.
 *
 *              States:
 *                IDLE → SIGNAL_DETECTED → AWAITING_APPROVAL → ORDER_PLACING
 *                  → PARTIALLY_FILLED → ACTIVE → FLAGGED → HUNT_SUSPECTED
 *                  → EXITING → CLOSED → IDLE
 *
 *              FORCE_EXIT is reachable from any "active" state via circuit breaker only.
 */

const eventBus = require('./event-bus');
const EVENTS = require('./events');

// ── Valid transition map ────────────────────────────────────────────────────
// Key = current state. Value = Set of states this can move to.
const VALID_TRANSITIONS = {
  IDLE:              new Set(['SIGNAL_DETECTED']),
  SIGNAL_DETECTED:   new Set(['AWAITING_APPROVAL', 'IDLE']),
  AWAITING_APPROVAL: new Set(['ORDER_PLACING', 'IDLE']),
  ORDER_PLACING:     new Set(['ACTIVE', 'PARTIALLY_FILLED', 'IDLE']),
  PARTIALLY_FILLED:  new Set(['IDLE']),         // after rollback completes
  ACTIVE:            new Set(['FLAGGED', 'EXITING']),
  FLAGGED:           new Set(['HUNT_SUSPECTED', 'EXITING', 'ACTIVE']), // ACTIVE = recovered
  HUNT_SUSPECTED:    new Set(['EXITING', 'FLAGGED']),
  EXITING:           new Set(['CLOSED']),
  CLOSED:            new Set(['IDLE']),
  FORCE_EXIT:        new Set(['CLOSED']),
};

// States from which FORCE_EXIT is permitted (circuit breaker path only)
const FORCE_EXIT_ELIGIBLE = new Set([
  'ORDER_PLACING',
  'PARTIALLY_FILLED',
  'ACTIVE',
  'FLAGGED',
  'HUNT_SUSPECTED',
  'EXITING',
]);

// All defined states (used for validation)
const ALL_STATES = new Set(Object.keys(VALID_TRANSITIONS));

class PositionStateMachine {
  constructor() {
    this._state = 'IDLE';
  }

  /**
   * Returns the current state.
   * @returns {string}
   */
  getCurrentState() {
    return this._state;
  }

  /**
   * Returns true if transitioning to newState from current state is valid.
   * @param {string} newState
   * @returns {boolean}
   */
  canTransition(newState) {
    if (newState === 'FORCE_EXIT') {
      return FORCE_EXIT_ELIGIBLE.has(this._state);
    }
    const allowed = VALID_TRANSITIONS[this._state];
    return allowed ? allowed.has(newState) : false;
  }

  /**
   * Transitions the state machine to newState.
   * Throws if the transition is invalid.
   * Emits STATE_TRANSITION event with previous and new state.
   *
   * @param {string} newState - The target state
   * @param {object} [meta={}] - Optional metadata to attach to the event
   * @returns {string} The new state
   * @throws {Error} If the transition is not permitted
   */
  transition(newState, meta = {}) {
    if (!ALL_STATES.has(newState)) {
      throw new Error(`[StateMachine] Unknown state: "${newState}"`);
    }

    if (!this.canTransition(newState)) {
      throw new Error(
        `[StateMachine] Invalid transition: ${this._state} → ${newState}`
      );
    }

    const previousState = this._state;
    this._state = newState;

    const ts = new Date().toTimeString().slice(0, 8);
    console.log(
      `[${ts}] [StateMachine] [INFO] ${previousState} → ${newState}`
    );

    eventBus.emit(EVENTS.STATE_TRANSITION, {
      from: previousState,
      to: newState,
      timestamp: new Date().toISOString(),
      ...meta,
    });

    return this._state;
  }

  /**
   * Resets the machine back to IDLE. Used after CLOSED or for testing.
   */
  reset() {
    this._state = 'IDLE';
  }
}

module.exports = PositionStateMachine;
