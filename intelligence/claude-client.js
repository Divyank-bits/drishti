/**
 * @file claude-client.js
 * @description Anthropic SDK wrapper with circuit breaker 5 integration.
 *              Manages timeout, slow-response logging, and availability tracking.
 *              When the API is unavailable, `isAvailable()` returns false —
 *              strategy-selector falls back to RULES mode automatically.
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config    = require('../config');

// Deferred bus/events to avoid circular resolution issues.
let _eventBus = null;
let _EVENTS   = null;
const _noopEmitter = { emit: () => {}, on: () => {} };

function getEventBus() {
  if (_eventBus) return _eventBus;
  try { _eventBus = require('../core/event-bus'); } catch (_) { _eventBus = _noopEmitter; }
  return _eventBus;
}
function getEvents() {
  if (_EVENTS) return _EVENTS;
  try { _EVENTS = require('../core/events'); } catch (_) { _EVENTS = {}; }
  return _EVENTS;
}

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [ClaudeClient] [${level}] ${msg}`);
}

class ClaudeClient {
  constructor() {
    this._client    = null;
    this._available = true; // flips false when circuit breaker 5 trips

    // Lazy-initialise: do not construct Anthropic client if key is absent (e.g. test env).
    if (config.ANTHROPIC_API_KEY) {
      this._client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });
    } else {
      log('WARN', 'ANTHROPIC_API_KEY not set — Claude unavailable, system will use RULES mode');
      this._available = false;
    }
  }

  /**
   * Whether the Claude API is currently reachable.
   * Returns false after circuit breaker 5 has tripped.
   * @returns {boolean}
   */
  isAvailable() {
    return this._available && this._client !== null;
  }

  /**
   * Sends a prompt to Claude and returns the text response.
   * Emits CLAUDE_API_ERROR and trips circuit breaker 5 on failure.
   *
   * @param {string} prompt        — The full assembled prompt string
   * @param {string} [systemRole]  — Optional system message (defaults to trading analyst persona)
   * @returns {Promise<string>}    — Claude's text response
   * @throws if API call fails (caller should handle)
   */
  async call(prompt, systemRole) {
    if (!this.isAvailable()) {
      throw new Error('[ClaudeClient] Claude API is unavailable (circuit breaker 5 tripped)');
    }

    const system = systemRole || (
      'You are a quantitative options trading analyst for Indian equity markets. ' +
      'You respond only with valid JSON. Be concise and decisive.'
    );

    const t0 = Date.now();

    try {
      // Race the API call against a timeout promise
      const apiCall = this._client.messages.create({
        model:      config.CLAUDE_MODEL,
        max_tokens: 512,
        system,
        messages:   [{ role: 'user', content: prompt }],
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Claude API timeout after ${config.CLAUDE_TIMEOUT_MS}ms`)),
          config.CLAUDE_TIMEOUT_MS)
      );

      const response = await Promise.race([apiCall, timeoutPromise]);
      const elapsed  = Date.now() - t0;

      if (elapsed > config.CLAUDE_SLOW_LOG_MS) {
        log('WARN', `Slow response: ${elapsed}ms (threshold ${config.CLAUDE_SLOW_LOG_MS}ms)`);
      }

      const text = response.content?.[0]?.text ?? '';
      getEventBus().emit(getEvents().CLAUDE_RESPONSE, {
        elapsed,
        inputTokens:  response.usage?.input_tokens  ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      });

      return text;

    } catch (err) {
      const reason = err.message || 'Unknown Claude API error';
      log('ERROR', `API call failed: ${reason}`);

      this._tripCircuitBreaker(reason);

      getEventBus().emit(getEvents().CLAUDE_API_ERROR, {
        reason,
        timestamp: new Date().toISOString(),
      });

      throw err;
    }
  }

  /**
   * Marks Claude as unavailable and emits CIRCUIT_BREAKER_HIT for claude_api.
   * @private
   */
  _tripCircuitBreaker(reason) {
    if (!this._available) return; // already tripped
    this._available = false;
    log('ERROR', `Circuit breaker 5 tripped: ${reason}`);

    // Emit a dedicated circuit breaker event so the dashboard / position-tracker
    // can switch to RULES-only mode for the rest of the session.
    getEventBus().emit(getEvents().CIRCUIT_BREAKER_HIT, {
      breakerName: 'claude_api',
      reason,
      timestamp:   new Date().toISOString(),
    });
  }

  /**
   * Parses Claude's JSON response. Returns null if parsing fails.
   * @param {string} text
   * @returns {object|null}
   */
  parseJSON(text) {
    try {
      // Strip markdown fences if present (```json ... ```)
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      return JSON.parse(cleaned);
    } catch (_) {
      log('WARN', `Failed to parse Claude JSON response: ${text.slice(0, 120)}`);
      return null;
    }
  }
}

// Shared singleton — the same instance is used everywhere in the process.
module.exports = new ClaudeClient();
