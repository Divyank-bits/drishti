# Drishti — Application Flow Reference

This document describes every major scenario the app handles, step by step.
Read this before building any phase to understand how all modules connect.

---

## Scenario 1 — App Startup Sequence

```
index.js boots
    │
    ├─► Load .env + config.js
    │       Validate all required keys present
    │       If missing → log ERROR, process.exit(1)
    │
    ├─► Init EventBus (core/event-bus.js)
    │       Attach debug logger if NODE_ENV=development
    │
    ├─► Init CircuitBreaker (core/circuit-breaker.js)
    │       All breakers start un-tripped
    │       Register listener: CIRCUIT_BREAKER_HIT → log + Telegram alert
    │
    ├─► Init SessionContext (core/session-context.js)
    │       Reset all daily counters to zero
    │       vixAtOpen, pnlToday, tradesToday, consecutiveLosses = 0
    │
    ├─► Fetch Historical Candles (data/historical.js)
    │       Try (1) NSE India endpoint
    │       Try (2) Yahoo Finance fallback
    │       Try (3) Load from cache/last-session.json
    │       ALL FAIL → emit STARTUP_DATA_FAILED
    │                → Telegram alert "Cannot start: no historical data"
    │                → process.exit(1)
    │       SUCCESS → seed CandleBuilder with last 100 candles
    │               → emit HISTORICAL_DATA_LOADED
    │
    ├─► Fetch Options Chain (data/options-chain.js)
    │       Parse PCR, maxCeOiLevel, maxPeOiLevel, indiaVix
    │       Store as last-known with fetchedAt timestamp
    │       FAIL → log WARN, continue (will retry in 15m cron)
    │
    ├─► Connect Tick Stream (data/tick-stream.js)
    │       Dhan WebSocket handshake
    │       Subscribe to NIFTY spot feed
    │       FAIL → retry with exponential backoff (max 5 attempts)
    │       ALL RETRIES FAIL → Telegram alert, process.exit(1)
    │
    ├─► Load Strategy Registry (strategies/registry.js)
    │       Auto-discover all *.strategy.js files
    │       Instantiate each, validate they implement base interface
    │       Log registered strategies
    │
    ├─► Start Dashboard Server (dashboard/server.js)
    │       Express listens on PORT (default 3000)
    │       SSE endpoint /events ready
    │
    ├─► Register node-cron jobs (index.js)
    │       Every 15m (market hours) → options chain refresh
    │       At 15:15 IST → auto square-off
    │       At 15:30 IST → daily summary Telegram
    │
    └─► Log "[09:15:00] [System] [INFO] System ready | Mode: HYBRID | Execution: PAPER"
```

---

## Scenario 2 — Normal Trading Day (no position)

```
Every tick arrives via WebSocket
    │
    ├─► CandleBuilder receives TICK_RECEIVED
    │       Updates open candle for 1m, 5m, 15m
    │       On boundary: close candle, emit CANDLE_CLOSE_1M / 5M / 15M
    │
    ├─► On CANDLE_CLOSE_5M:
    │       IndicatorEngine recalculates all indicators
    │       Emits INDICATORS_UPDATED { rsi, ema9, ema21, macd, bb, atr, adx, ... }
    │
    ├─► SessionContext listens to CANDLE_CLOSE_1M (09:15–10:15)
    │       Tracks firstHourHigh and firstHourLow
    │
    ├─► On INDICATORS_UPDATED:
    │       CircuitBreaker.check() → if tripped, skip signal scan
    │       If time > NO_NEW_TRADES_AFTER (14:00) → skip signal scan
    │       If tradesToday >= MAX_TRADES_PER_DAY → skip signal scan
    │
    └─► StrategySelector.scan(marketData)
            │
            ├─[RULES / HYBRID]─► Registry.getBestForMarket()
            │       Each strategy runs checkConditions(marketData)
            │       Returns { eligible, score 0-100, reasons[] }
            │       Pick highest scoring eligible strategy
            │       If score < MATCH_SCORE_THRESHOLD → no signal
            │
            ├─[AI / HYBRID when score > threshold]─► Claude path
            │       See Scenario 3 below
            │
            └─► No eligible strategy → IDLE, wait for next candle
```

---

## Scenario 3 — Signal Detected → Entry Flow

### 3A — RULES Mode (no Claude)

```
Strategy checkConditions() returns { eligible: true, score: 78, reasons: [...] }
    │
    ├─► strategy.buildTrade(marketData)
    │       Strike selection (CE/PE short + long legs)
    │       Validate: range > 300 pts, risk/reward > 0.3
    │       Adjust any round-number strikes (+50 shift)
    │
    ├─► StateMachine: IDLE → SIGNAL_DETECTED
    │
    ├─► TradeJournal.write("SIGNAL_GENERATED", { strategy, score, legs, marketData })
    │
    ├─► Telegram.sendApproval(alertMessage)
    │       Message format:
    │       ─────────────────────────────
    │       SIGNAL: Iron Condor
    │       NIFTY: 24,185 | VIX: 16.4
    │       Sell CE 24400 | Buy CE 24600
    │       Sell PE 24000 | Buy PE 23800
    │       Score: 78/100
    │       Reasons: [RSI 52, BB 2.8%, ...]
    │       Mode: RULES | PAPER
    │       Reply YES to execute | NO to reject
    │       Timeout: 3 minutes
    │       ─────────────────────────────
    │
    ├─► StateMachine: SIGNAL_DETECTED → AWAITING_APPROVAL
    │
    └─► Wait for Telegram reply → See Scenario 4
```

### 3B — HYBRID / AI Mode (Claude runs)

```
Strategy score > MATCH_SCORE_THRESHOLD (65)
    │
    ├─► PromptBuilder.build(marketData, sessionContext, strategy)
    │       Assembles: spot, VIX, last 20×15m candles, last 50×5m candles,
    │       all indicators, PCR, OI levels, IV%, day high/low/open,
    │       firstHourHigh/Low, sessionContext snapshot,
    │       strategy.claudeDescription(), expected JSON schema
    │
    ├─► ClaudeClient.analyze(prompt)
    │       POST to Anthropic API, timeout 10s
    │       ┌─ SUCCESS ──────────────────────────────────────────┐
    │       │  Parse JSON response                               │
    │       │  Validate schema fields present                    │
    │       │  { shouldTrade, confidence, regime,               │
    │       │    strategyName, legs, reasoning,                  │
    │       │    riskWarnings, exitConditions }                  │
    │       └────────────────────────────────────────────────────┘
    │       ┌─ FAIL / TIMEOUT ───────────────────────────────────┐
    │       │  Log error                                         │
    │       │  emit CLAUDE_API_ERROR                             │
    │       │  Trip Claude circuit breaker                       │
    │       │  Fall back to RULES path for this signal           │
    │       └────────────────────────────────────────────────────┘
    │
    ├─► If confidence < CONFIDENCE_THRESHOLD (0.70) → discard signal
    │       TradeJournal.write("CLAUDE_RESPONSE", { confidence, reasoning, action: "REJECTED" })
    │
    ├─► TradeJournal.write("CLAUDE_RESPONSE", { confidence, reasoning, legs })
    │
    └─► Continue same path as 3A from "StateMachine: IDLE → SIGNAL_DETECTED"
```

---

## Scenario 4 — Telegram Approval Flow

```
Approval message sent, timer starts (3 minutes)
    │
    ├─[YES received within 3 min]──────────────────────────────────┐
    │                                                               │
    │   StateMachine: AWAITING_APPROVAL → ORDER_PLACING            │
    │   TradeJournal.write("USER_APPROVED", { timestamp, legs })   │
    │   OrderManager.placeAllLegs(legs)                            │
    │       │                                                       │
    │       ├─► Place Leg 1 (Short CE)                             │
    │       ├─► Place Leg 2 (Short PE)                             │
    │       ├─► Place Leg 3 (Long CE)                              │
    │       └─► Place Leg 4 (Long PE)                              │
    │                                                               │
    │   ┌─ ALL 4 FILLED ──────────────────────────────────────┐    │
    │   │  StateMachine: ORDER_PLACING → ACTIVE               │    │
    │   │  TradeJournal.write("POSITION_ACTIVE", { fills })   │    │
    │   │  Telegram: "Position open. Net credit: ₹X"          │    │
    │   │  PositionTracker begins monitoring                   │    │
    │   └─────────────────────────────────────────────────────┘    │
    │                                                               │
    │   ┌─ PARTIAL FILL ──────────────────────────────────────┐    │
    │   │  StateMachine: ORDER_PLACING → PARTIALLY_FILLED     │    │
    │   │  OrderManager: attempt cancel all filled legs        │    │
    │   │  emit PARTIAL_FILL_ROLLBACK                          │    │
    │   │  TradeJournal.write("LEG_FAILED", { legId, reason }) │    │
    │   │  Telegram: "Partial fill. Rollback attempted. ..."   │    │
    │   │  StateMachine: → IDLE (after rollback confirmed)     │    │
    │   └─────────────────────────────────────────────────────┘    │
    │                                                               │
    └───────────────────────────────────────────────────────────────┘
    │
    ├─[NO received]─────────────────────────────────────────────────┐
    │   StateMachine: AWAITING_APPROVAL → IDLE                      │
    │   TradeJournal.write("USER_REJECTED", { timestamp })          │
    │   Telegram: "Signal rejected."                                │
    └───────────────────────────────────────────────────────────────┘
    │
    └─[3 min timeout — no reply]────────────────────────────────────┐
        StateMachine: AWAITING_APPROVAL → IDLE                      │
        TradeJournal.write("USER_REJECTED", { reason: "timeout" })  │
        Telegram: "Signal auto-rejected: no response in 3 min"      │
        └───────────────────────────────────────────────────────────┘
```

---

## Scenario 5 — Active Position Monitoring

```
Every TICK_RECEIVED (position is ACTIVE or FLAGGED)
    │
    ├─► Rule 6: Absolute P&L Stop
    │       if currentLoss > MAX_DAILY_LOSS * ABSOLUTE_PNL_STOP_PCT
    │       → IMMEDIATE EXIT (bypasses all other rules)
    │       → See Scenario 6C
    │
    ├─► Rule 4: Dangerous Time Window Check
    │       Windows: 9:15–9:30, 11:30–11:45, 13:00–13:30, 14:45–15:00
    │       If inside window AND price near strike → hold, do not exit
    │       Only Rule 6 (absolute P&L) can exit in these windows
    │
    ├─► Rule 3: Volume Confirmation
    │       On price spike toward short strike:
    │       volume > 1.5× average → real move, flag position
    │       volume < average → likely hunt, hold
    │
    └─► Rule 5: Delta Monitoring
            Recalculate delta for short CE and short PE
            short CE delta > 0.35 → StateMachine: ACTIVE → FLAGGED
            short PE delta < -0.35 → StateMachine: ACTIVE → FLAGGED
            emit POSITION_FLAGGED
            TradeJournal.write("POSITION_FLAGGED", { delta, price })
            Telegram: "Position flagged. Short CE delta: 0.37"

Every CANDLE_CLOSE_15M (position is ACTIVE or FLAGGED)
    │
    ├─► Rule 1 + 2: Candle Close Beyond Buffer
    │       exitIfNiftyCLosesAbove = Short CE + 75
    │       exitIfNiftyClosesBelow = Short PE - 75
    │       15m candle close above exitCE → begin exit
    │       15m candle close below exitPE → begin exit
    │       Price spike only (no candle close) → hold (Rule 1)
    │
    └─► Rule 8: Claude Hunt Detection (if position FLAGGED)
            Only runs if:
              - INTELLIGENCE_MODE is AI or HYBRID
              - Claude circuit breaker NOT tripped
            PromptBuilder assembles hunt-detection prompt
            ClaudeClient.analyze() → { isLikelyHunt, confidence, reasoning, action }
            if isLikelyHunt AND confidence > 0.70 → hold, log reasoning
            if NOT hunt → proceed to exit evaluation
            TradeJournal.write("HUNT_DETECTION_RESULT", { ... })
```

---

## Scenario 6 — Exit Scenarios

### 6A — Normal Exit (15m candle close beyond buffer)

```
15m candle closes above Short CE + 75 (or below Short PE - 75)
    │
    ├─► Rule 8 check (if FLAGGED + HYBRID/AI)
    │       Hunt detected → hold, re-evaluate next candle
    │       Not hunt → proceed
    │
    ├─► StateMachine: ACTIVE/FLAGGED → EXITING
    │
    ├─► emit EXIT_TRIGGERED { reason: "CANDLE_CLOSE_BREACH", leg, price }
    │
    ├─► OrderManager.closeAllLegs()
    │       Buy back short CE + short PE
    │       Sell long CE + long PE
    │
    ├─► Calculate final P&L
    │       pnlToday += realized P&L
    │       if pnl < 0: consecutiveLosses++
    │       if pnl > 0: consecutiveLosses = 0
    │
    ├─► SessionContext.update({ pnlToday, consecutiveLosses })
    │
    ├─► CircuitBreaker.check()
    │       If pnlToday < -MAX_DAILY_LOSS → trip daily loss breaker
    │       If consecutiveLosses >= 3 → trip consecutive loss breaker
    │
    ├─► StateMachine: EXITING → CLOSED
    │
    ├─► TradeJournal.write("POSITION_CLOSED", { pnl, legs, exitReason })
    │
    └─► Telegram: "Position closed. P&L: ₹-320. Daily P&L: ₹-320"
```

### 6B — Time-Based Square-Off (15:15 IST cron)

```
node-cron fires at 15:15 IST
    │
    ├─► Check: any position in ACTIVE, FLAGGED, HUNT_SUSPECTED, EXITING state?
    │       No → do nothing
    │       Yes → proceed
    │
    ├─► emit SQUARE_OFF_TRIGGERED { reason: "EOD_CRON", time: "15:15" }
    │
    ├─► StateMachine: current state → EXITING (forced, valid from any active state)
    │
    └─► Continue same path as 6A from "OrderManager.closeAllLegs()"
```

### 6C — Absolute P&L Stop (Rule 6 — immediate)

```
currentLoss > MAX_DAILY_LOSS * 0.50 (₹2500 with ₹5000 limit)
    │
    ├─► Bypass all other rules (Rule 4 window, Rule 1 candle-close, Rule 8)
    │
    ├─► StateMachine: any state → FORCE_EXIT
    │
    ├─► emit CIRCUIT_BREAKER_HIT { reason: "ABSOLUTE_PNL_STOP", loss: currentLoss }
    │
    ├─► Telegram: "EMERGENCY EXIT: P&L stop hit. Loss: ₹2600. Closing all legs NOW."
    │
    └─► Continue from "OrderManager.closeAllLegs()"
```

### 6D — Daily Loss Circuit Breaker

```
pnlToday crosses -MAX_DAILY_LOSS (-₹5000)
    │
    ├─► CircuitBreaker trips "daily_loss" breaker
    │
    ├─► isTripped() = true → ALL new signals blocked for rest of day
    │
    ├─► If open position exists → trigger FORCE_EXIT
    │
    ├─► Telegram: "Daily loss limit hit (₹5000). No new trades today. 
    │              Manual restart required tomorrow."
    │
    └─► System remains up, monitoring disabled, dashboard still live
```

### 6E — 3 Consecutive Losses Circuit Breaker

```
consecutiveLosses reaches 3
    │
    ├─► CircuitBreaker trips "consecutive_loss" breaker
    │
    ├─► isTripped() = true → new entries blocked
    │       (open positions STILL MONITORED — does not force exit)
    │
    ├─► Telegram: "3 consecutive losses. New entries paused.
    │              Send /resume to re-enable after review."
    │
    └─► Manual /resume command on Telegram resets breaker
```

### 6F — Manual Square-Off (/squareoff Telegram command)

```
User sends /squareoff on Telegram
    │
    ├─► Telegram bot receives command
    │
    ├─► Check: position exists?
    │       No → "No open position to close."
    │
    ├─► emit MANUAL_SQUAREOFF_REQUESTED { source: "telegram", user }
    │
    ├─► StateMachine: current state → EXITING
    │
    └─► Continue from "OrderManager.closeAllLegs()"
```

---

## Scenario 7 — WebSocket Disconnect

```
WebSocket connection drops
    │
    ├─► tick-stream.js detects disconnect
    │       Start reconnect timer
    │       Attempt reconnect with exponential backoff
    │       Retry 1: 2s, Retry 2: 4s, Retry 3: 8s, Retry 4: 16s, Retry 5: 30s
    │
    ├─► Mark any currently-open candle as INCOMPLETE (do not use for signals)
    │
    ├─► Start 30-second circuit breaker watchdog timer
    │       If reconnected before 30s → cancel timer, mark as RECONNECTED
    │       emit WEBSOCKET_RECONNECTED → CandleBuilder resets open candle
    │
    └─► If still disconnected after 30s AND open position exists:
            emit CIRCUIT_BREAKER_HIT { reason: "WEBSOCKET_TIMEOUT" }
            CircuitBreaker trips "websocket" breaker
            Telegram: "WebSocket down >30s with open position.
                       Attempting emergency REST exit..."
            DhanExecutor.emergencyExit() via REST API (not WebSocket)
            StateMachine: → FORCE_EXIT
```

---

## Scenario 8 — Claude API Down

```
ClaudeClient.analyze() throws or times out (>10s)
    │
    ├─► Log: "[12:34:05] [ClaudeClient] [ERROR] API timeout after 10000ms"
    │
    ├─► emit CLAUDE_API_ERROR { reason, timestamp }
    │
    ├─► CircuitBreaker trips "claude_api" breaker
    │
    ├─► INTELLIGENCE_MODE effectively demoted to "RULES" for remainder of session
    │
    ├─► Telegram: "Claude API unavailable. Switched to RULES-only mode.
    │              No new AI entries. Existing rules still active."
    │
    ├─► For the current signal (if mid-analysis):
    │       Fall back to RULES path immediately
    │       strategy.checkConditions() score used directly
    │
    └─► Open positions:
            Anti-hunt rules 1-7 still active (all rule-based)
            Rule 8 (Claude hunt detection) → SKIPPED
            Exit decisions based purely on rules
```

---

## Scenario 9 — NSE Options Chain Fetch Failure

```
options-chain.js fetch fails (timeout, cookie expired, NSE down)
    │
    ├─► Log: "[11:00:01] [OptionsChain] [WARN] Fetch failed: 403 Forbidden"
    │
    ├─► Use last-known options chain data (stored with fetchedAt timestamp)
    │
    ├─► emit OPTIONS_CHAIN_STALE { lastFetchedAt, minutesAgo }
    │
    ├─► If stale > 30 minutes:
    │       Telegram: "Options chain data is 30m+ old. PCR/OI levels unreliable."
    │       IndicatorEngine flags optionsDataFresh = false
    │       strategy.checkConditions() → PCR check returns WARN, reduces score
    │
    └─► If stale > 60 minutes:
            Block new Iron Condor entries (PCR is a required condition)
            Telegram: "Options chain data >60m old. IC entries paused."
```

---

## Scenario 10 — Historical Data Fetch at Startup (fallback chain)

```
historical.js runs at startup
    │
    ├─► Attempt 1: NSE India endpoint
    │       GET https://www.nseindia.com/api/chart-databyindex?...
    │       SUCCESS → validate (no nulls, OHLC logic, sequential timestamps)
    │                → seed CandleBuilder
    │                → log "[INFO] Historical data loaded from NSE India (100 candles)"
    │       FAIL → log WARN, try next
    │
    ├─► Attempt 2: Yahoo Finance
    │       GET Yahoo Finance compatible URL for NIFTY
    │       SUCCESS → validate → seed
    │       FAIL → log WARN, try next
    │
    ├─► Attempt 3: Local cache (cache/last-session.json)
    │       File exists? → load, validate, seed
    │       File missing or corrupt? → log WARN, try next
    │
    └─► ALL FAILED:
            emit STARTUP_DATA_FAILED
            Telegram: "CRITICAL: Cannot fetch historical candles.
                       App cannot start. Check NSE/internet/cache."
            process.exit(1)

After successful load:
    ├─► Save loaded candles to cache/last-session.json (overwrites)
    └─► Log which source was used
```

---

## Scenario 11 — End of Day

```
15:15 IST — cron fires
    │
    ├─► Square off any open position (Scenario 6B)
    │
15:30 IST — cron fires
    │
    ├─► Stop scanning for new signals
    │
    ├─► Compile daily summary:
    │       tradesToday, pnlToday, winRate,
    │       regimeChangesToday, circuitBreakersHit,
    │       intelligenceMode used, Claude calls made
    │
    ├─► Telegram: Daily Summary message
    │       ────────────────────────────────
    │       Drishti Daily Summary — 13 Apr
    │       Trades: 1 | P&L: ₹+480
    │       Win rate: 100% (1/1)
    │       Mode: HYBRID | Execution: PAPER
    │       Circuit breakers hit: 0
    │       ────────────────────────────────
    │
    ├─► TradeJournal — all entries already written (append-only, nothing to flush)
    │
    ├─► Save candles to cache/last-session.json
    │
    └─► SessionContext.reset() — ready for next day
        (app stays running; restarts not needed between days)
```

---

## Scenario 12 — Multiple Strategies (Future Phase 4)

```
On INDICATORS_UPDATED (no open position):
    │
    ├─► Registry.getAll() → [IronCondor, BullPutSpread, BearCallSpread, ...]
    │
    ├─► Each strategy runs checkConditions(marketData)
    │       Returns { eligible, score, reasons }
    │
    ├─► Filter: eligible = true AND score > MATCH_SCORE_THRESHOLD
    │
    ├─► Sort by score descending
    │       Pick highest scorer
    │       If tie → prefer non-directional (IC > spreads > directional)
    │
    ├─► Only ONE position open at a time (enforced by state machine)
    │       If ACTIVE position exists → skip scan entirely
    │
    └─► Winning strategy passed to StrategySelector
            Same AI/RULES/HYBRID path as Scenario 3
```

---

## Module Interaction Map

```
index.js
  └─ boots all modules, registers cron jobs

EventBus (core/event-bus.js) — central nervous system
  │
  ├─ TICK_RECEIVED ──────────────────────────► CandleBuilder
  │                                             └─ CANDLE_CLOSE_1M/5M/15M
  │                                                 └─ IndicatorEngine
  │                                                     └─ INDICATORS_UPDATED
  │                                                         └─ StrategySelector
  │                                                             └─ (signal found)
  │                                                                 └─ ClaudeClient (HYBRID/AI)
  │                                                                     └─ Telegram (approval)
  │                                                                         └─ OrderManager
  │                                                                             └─ Executor (Paper/Dhan)
  │
  ├─ TICK_RECEIVED ──────────────────────────► PositionTracker (if ACTIVE)
  │                                             └─ AntiHunt rules 3,4,5,6
  │
  ├─ CANDLE_CLOSE_15M ───────────────────────► PositionTracker (if ACTIVE)
  │                                             └─ AntiHunt rules 1,2,8
  │
  ├─ CIRCUIT_BREAKER_HIT ────────────────────► Telegram alert
  │                                           ► TradeJournal
  │                                           ► PositionTracker (force exit path)
  │
  └─ All events ─────────────────────────────► TradeJournal (selective events)
                                              ► Dashboard SSE (all events → UI)
```

---

## State Machine Transitions Quick Reference

```
IDLE
  └─ signal found ──────────────────────────► SIGNAL_DETECTED
                                               └─ approval sent ─► AWAITING_APPROVAL
                                                                    ├─ YES ──► ORDER_PLACING
                                                                    │          ├─ all filled ──► ACTIVE
                                                                    │          └─ partial ─────► PARTIALLY_FILLED
                                                                    │                            └─ rollback ──► IDLE
                                                                    └─ NO/timeout ─► IDLE

ACTIVE
  ├─ delta breach ──────────────────────────► FLAGGED
  │                   └─ hunt suspected ────► HUNT_SUSPECTED
  │                                           └─ confirmed exit ─► EXITING
  ├─ 15m close breach ─────────────────────► EXITING
  └─ any state ────────────────────────────► FORCE_EXIT (circuit breaker only)

EXITING
  └─ all legs closed ──────────────────────► CLOSED ──► IDLE (next trade)
```
