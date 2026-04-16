/**
 * @file strategy-selector.js
 * @description Routes entry signals through AI, RULES, or HYBRID execution paths.
 *              Called by iron-condor.strategy.js before emitting SIGNAL_GENERATED.
 *
 *              Modes (config.INTELLIGENCE_MODE):
 *                RULES  — rule engine result is final; Claude is never called
 *                AI     — Claude decides; rule engine score is context only
 *                HYBRID — rules must score > MATCH_SCORE_THRESHOLD first,
 *                         then Claude makes the final call
 *
 *              Falls back to RULES automatically if:
 *                - Claude circuit breaker is tripped (claudeClient.isAvailable() = false)
 *                - ANTHROPIC_API_KEY is absent
 */
'use strict';

const config         = require('../config');
const claudeClient   = require('./claude-client');
const promptBuilder  = require('./prompt-builder');

function log(level, msg) {
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`[${ts}] [StrategySelector] [${level}] ${msg}`);
}

/**
 * Decides whether to approve a trade signal, routing through the configured
 * intelligence mode.
 *
 * @param {object} signal       — checkConditions() result from the strategy
 *   @param {boolean} signal.eligible         — did ALL rules pass?
 *   @param {number}  signal.score            — 0–100 rule match score
 *   @param {string[]} signal.failedConditions
 * @param {object} signalPayload — full SIGNAL_GENERATED payload (strikes, indicators, options)
 * @param {object} sessionCtx    — SessionContext.snapshot()
 * @param {Array}  candles15m    — last N 15m candles for Claude context
 *
 * @returns {Promise<{ approved: boolean, confidence: number, reasoning: string, mode: string }>}
 */
async function select(signal, signalPayload, sessionCtx, candles15m) {
  const configured = (config.INTELLIGENCE_MODE || 'HYBRID').toUpperCase();

  // HYBRID score gate fires before Claude availability check —
  // no point calling Claude for a signal that already failed the rule filter.
  if (configured === 'HYBRID') {
    if (!signal.eligible || signal.score < config.MATCH_SCORE_THRESHOLD) {
      const reason = signal.eligible
        ? `Score ${signal.score} below HYBRID threshold ${config.MATCH_SCORE_THRESHOLD}`
        : `Rules failed: ${signal.failedConditions.slice(0, 3).join(', ')}`;
      log('INFO', `HYBRID gate 1 rejected: ${reason}`);
      return { approved: false, confidence: 0, reasoning: reason, mode: 'HYBRID' };
    }
  }

  const mode = _effectiveMode();

  if (mode === 'RULES') {
    return _rulesResult(signal, mode);
  }

  // HYBRID (score passed) or AI — call Claude
  return await _claudeDecide(signalPayload, sessionCtx, candles15m, mode);
}

// ── Private helpers ─────────────────────────────────────────────────────────

/**
 * Returns the effective mode, falling back to RULES if Claude is unavailable.
 * @private
 */
function _effectiveMode() {
  const configured = (config.INTELLIGENCE_MODE || 'HYBRID').toUpperCase();
  if (configured === 'RULES') return 'RULES';

  if (!claudeClient.isAvailable()) {
    log('WARN', `Claude unavailable — falling back from ${configured} to RULES`);
    return 'RULES';
  }
  return configured;
}

/**
 * Returns a RULES-mode decision from the signal's eligible flag.
 * @private
 */
function _rulesResult(signal, mode) {
  const approved = signal.eligible === true;
  const reasoning = approved
    ? `All rule conditions passed (score: ${signal.score})`
    : `Rules rejected: ${(signal.failedConditions || []).slice(0, 3).join(', ')}`;
  log('INFO', `${mode} decision: approved=${approved} — ${reasoning}`);
  return { approved, confidence: approved ? 1.0 : 0.0, reasoning, mode };
}

/**
 * Calls Claude and parses the structured JSON response.
 * Falls back to RULES if Claude call fails.
 * @private
 */
async function _claudeDecide(signalPayload, sessionCtx, candles15m, mode) {
  const prompt = promptBuilder.buildEntryPrompt(signalPayload, sessionCtx, candles15m || []);

  let text;
  try {
    text = await claudeClient.call(prompt);
  } catch (err) {
    log('WARN', `Claude call failed (${err.message}) — falling back to RULES`);
    // claudeClient already tripped circuit breaker 5 internally
    return { approved: false, confidence: 0, reasoning: `Claude unavailable: ${err.message}`, mode: 'RULES_FALLBACK' };
  }

  const parsed = claudeClient.parseJSON(text);
  if (!parsed) {
    log('WARN', 'Could not parse Claude response — rejecting signal as precaution');
    return { approved: false, confidence: 0, reasoning: 'Claude returned unparseable response', mode };
  }

  const approved    = parsed.approved === true;
  const confidence  = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
  const reasoning   = parsed.reasoning || '';
  const concerns    = (parsed.concerns || []).join('; ');

  // Confidence gate: require > CONFIDENCE_THRESHOLD even if Claude says approved
  const finalApproved = approved && confidence >= config.CONFIDENCE_THRESHOLD;

  const logMsg = `${mode} decision: approved=${finalApproved} confidence=${confidence.toFixed(2)} — ${reasoning}`;
  log('INFO', logMsg);
  if (concerns) log('INFO', `  Concerns: ${concerns}`);

  return {
    approved:   finalApproved,
    confidence,
    reasoning:  reasoning + (concerns ? ` | Concerns: ${concerns}` : ''),
    mode,
  };
}

module.exports = { select };
