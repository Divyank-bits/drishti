# Rule Engine — Complete Reference

The rule engine is the zero-Claude code path. Every decision is deterministic,
based purely on indicator values and market data. No API calls, no latency, no cost.

In RULES mode  → rule engine makes ALL decisions
In HYBRID mode → rule engine filters first; Claude called only when score passes threshold
In AI mode     → rule engine is bypassed for entry; still runs for exit (Rules 1–7)

---

## The 5 Layers

```
RAW MARKET DATA (ticks, candles, options chain)
        │
        ▼
┌─────────────────────────────────────────────┐
│  Layer 1: Market Regime Classifier          │  What kind of market is today?
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│  Layer 2: Strategy Eligibility Scorer       │  Which strategy fits right now?
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│  Layer 3: Entry Gate                        │  Is the score high enough to act?
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│  Layer 4: Position Management Rules         │  8 anti-hunt rules while in trade
└─────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────┐
│  Layer 5: Exit Decision Rules               │  When exactly do we close?
└─────────────────────────────────────────────┘
```

---

## Layer 1 — Market Regime Classifier

**Purpose:** Label the current market as Regime A, B, or C.
This determines which strategies are even eligible to run.
Runs on every INDICATORS_UPDATED event.

### Inputs
- VIX (indiaVix from options chain)
- ADX value + ADX slope (is trend accelerating?)
- BB Width % (how wide are Bollinger Bands relative to price)
- EMA9 vs EMA21 spread (how far apart are short and medium EMAs)
- NIFTY distance from day open %
- RSI value

### Regime Definitions

```
REGIME A — Range-Bound / Low Volatility
─────────────────────────────────────────
VIX:            < 18
ADX:            < 20  (no trend)
BB Width %:     < 3%  (bands are tight)
EMA9/EMA21:     within 0.3% of each other
NIFTY vs open:  within 0.4%
RSI:            between 42–58 (neutral)

Eligible strategies: Iron Condor, Butterfly Spread
Signal: market is coiling, premium decay trade

─────────────────────────────────────────
REGIME B — Mild Trend / Moderate Volatility
─────────────────────────────────────────
VIX:            18–22
ADX:            20–30
BB Width %:     3–5%
EMA spread:     0.3%–0.8%
NIFTY vs open:  0.4%–1.0%
RSI:            45–65 (mild directional lean)

Eligible strategies: Bull Put Spread (if bullish lean),
                     Bear Call Spread (if bearish lean),
                     Calendar Spread
Signal: mild drift, defined-risk directional spread

─────────────────────────────────────────
REGIME C — Trending / High Volatility
─────────────────────────────────────────
VIX:            > 22  (approaching VIX_SAFE_MAX)
ADX:            > 30  (strong trend)
BB Width %:     > 5%
EMA spread:     > 0.8%
NIFTY vs open:  > 1.0%

Eligible strategies: NONE (no new entries in Regime C)
Signal: too volatile for premium-selling, stay flat
```

### Regime Output

```js
{
  regime: "A",           // "A" | "B" | "C"
  confidence: 82,        // 0–100, how cleanly does it fit?
  signals: {
    vixStatus: "LOW",       // "LOW" | "MODERATE" | "HIGH" | "DANGER"
    trend: "NONE",          // "NONE" | "MILD" | "STRONG"
    bbStatus: "TIGHT",      // "TIGHT" | "NORMAL" | "WIDE" | "EXPANDING"
    bias: "NEUTRAL"         // "NEUTRAL" | "BULLISH" | "BEARISH"
  },
  reason: "VIX 16.2, ADX 14, BB 2.4% — classic range-bound"
}
```

### Mixed Signal Handling

When signals conflict (e.g. VIX says A but ADX says B):
- Count how many indicators vote for each regime
- Majority wins
- If 3-way tie → assign B (conservative: assume mild trend, not range)
- Log the conflict with all values for the journal

---

## Layer 2 — Strategy Eligibility Scorer

**Purpose:** For every eligible strategy (filtered by regime), produce a score 0–100
representing how strongly current conditions favour that strategy.

Each condition is either:
- **Binary** — pass = full points, fail = zero points
- **Graded** — partial points based on how comfortably the value sits inside the range

### Iron Condor Scorer (10 conditions, 100 points total)

```
CONDITION                           WEIGHT   GRADING
──────────────────────────────────────────────────────────────────
1. VIX between 14–22                  15pts  Graded:
                                              - Center of range (16–20): 15
                                              - Near edges (14–16 or 20–22): 8
                                              - Outside range: 0

2. BB Width % between 2–4%            15pts  Graded:
                                              - 2.5–3.5% (ideal): 15
                                              - 2.0–2.5% or 3.5–4.0%: 8
                                              - Outside: 0

3. BB not squeezing                   10pts  Binary:
   (width not contracting for                - Not contracting 5+ candles: 10
    5+ consecutive 5m candles)              - Contracting: 0

4. IV Percentile > 50%                10pts  Graded:
                                              - > 70%: 10
                                              - 50–70%: 6
                                              - < 50%: 0

5. EMA9 and EMA21 within 0.2%         10pts  Graded:
                                              - Within 0.1%: 10
                                              - 0.1–0.2%: 6
                                              - > 0.2%: 0

6. RSI between 40–60                  10pts  Graded:
                                              - 47–53 (very neutral): 10
                                              - 40–47 or 53–60: 6
                                              - Outside: 0

7. MACD line near zero                10pts  Graded:
   (histogram < 0.1 in absolute terms)      - |histogram| < 0.05: 10
                                              - 0.05–0.1: 6
                                              - > 0.1: 0

8. NIFTY within 0.5% of day open      10pts  Graded:
                                              - Within 0.2%: 10
                                              - 0.2–0.5%: 5
                                              - > 0.5%: 0

9. PCR between 0.9–1.2                10pts  Graded:
                                              - 0.95–1.10 (balanced): 10
                                              - 0.9–0.95 or 1.10–1.20: 5
                                              - Outside: 0

10. Time between 09:30–14:00 IST       0pts  HARD GATE (not scored):
                                              - Outside window: eligible = false
                                              - Inside window: continue scoring
──────────────────────────────────────────────────────────────────
MAX SCORE: 100
ENTRY THRESHOLD: 65 (MATCH_SCORE_THRESHOLD config)
```

### Score Output

```js
{
  eligible: true,
  score: 78,
  reasons: [
    { condition: "VIX", value: 16.4, points: 15, max: 15, note: "ideal range" },
    { condition: "BB_WIDTH", value: 2.8, points: 15, max: 15, note: "ideal" },
    { condition: "BB_SQUEEZE", value: false, points: 10, max: 10, note: "not squeezing" },
    { condition: "IV_PERCENTILE", value: 58, points: 6, max: 10, note: "moderate" },
    { condition: "EMA_SPREAD", value: 0.15, points: 10, max: 10, note: "very tight" },
    { condition: "RSI", value: 51, points: 10, max: 10, note: "neutral" },
    { condition: "MACD", value: 0.03, points: 10, max: 10, note: "near zero" },
    { condition: "NIFTY_VS_OPEN", value: 0.18, points: 10, max: 10, note: "very close" },
    { condition: "PCR", value: 1.05, points: 6, max: 10, note: "slight PE bias" }
  ],
  failedConditions: [],
  hardGatesPassed: ["TIME_WINDOW", "REGIME_MATCH"]
}
```

### Hard Gates (binary — any failure = eligible: false, not scored)

These cannot be partially satisfied. Fail any one → strategy is eliminated.

```
TIME_WINDOW       → current IST time must be between 09:30–14:00
REGIME_MATCH      → current regime must be in strategy's allowed regimes
MAX_TRADES        → tradesToday < MAX_TRADES_PER_DAY
CIRCUIT_BREAKER   → isTripped() must be false
MAJOR_EVENT_DAY   → not a known event day (budget, RBI policy, expiry day)
EXISTING_POSITION → no ACTIVE/FLAGGED/EXITING position already open
```

---

## Layer 3 — Entry Gate

**Purpose:** Decide whether to act on the winning strategy's score.

```
Best strategy score from Layer 2
        │
        ├─ score < 65 (MATCH_SCORE_THRESHOLD)
        │    └─► NO TRADE. Log: "Score 58 — below threshold. Conditions: [...]"
        │
        ├─ score 65–79
        │    ├─[RULES mode]─► ENTER — rule engine is confident enough
        │    └─[HYBRID mode]─► Call Claude for second opinion
        │
        └─ score ≥ 80
             ├─[RULES mode]─► ENTER — strong signal
             └─[HYBRID mode]─► Call Claude (high confidence, still verify)
```

In RULES mode the entry gate is simply:
```
score >= MATCH_SCORE_THRESHOLD AND all hard gates pass → enter
```

---

## Layer 4 — Position Management Rules (Anti-Hunt)

These run while a position is ACTIVE or FLAGGED.
All 7 rules below are pure rule-based (Rule 8 is Claude-only, skipped in RULES mode).

### Rule 1 — Never Exit on Price Touch
```
Trigger: NIFTY spot price touches or crosses the short strike
Rule:    Ignore it. Do NOT exit.
Wait:    Only act on a 15m candle CLOSE beyond the buffer zone (Rule 2)
Why:     Market makers push price to collect premium, pull it back.
         A momentary touch is not a signal.
```

### Rule 2 — Buffer Zones
```
exitIfNiftyClosesAbove = shortCE + 75 points
exitIfNiftyClosesBelow = shortPE - 75 points

Example: sold CE at 24400
  Touch at 24400 → Rule 1: ignore
  15m candle closes at 24475 → still inside buffer → ignore
  15m candle closes at 24476 → beyond buffer → evaluate exit

Buffer is not negotiable. It exists to stop fake-out exits.
```

### Rule 3 — Volume Confirmation on Price Spike
```
Trigger: NIFTY moves > 0.3% in one candle toward a short strike
Check:   Compare candle volume vs 20-candle average volume

  volume > 1.5× average:
    → Real directional move, treat as genuine threat
    → Flag the position (if not already flagged)

  volume < 1.0× average:
    → Likely hunt (low participation = manufactured move)
    → Do NOT flag, log warning, continue monitoring

  volume between 1.0–1.5×:
    → Ambiguous — flag but note low confidence
```

### Rule 4 — Dangerous Time Windows
```
Windows (IST): 09:15–09:30  (open volatility)
               11:30–11:45  (lunch manipulation)
               13:00–13:30  (FII program trades)
               14:45–15:00  (pre-close positioning)

During these windows:
  → Rules 1, 2, 3 still active (monitor, flag if needed)
  → Do NOT trigger a normal exit based on price or delta
  → ONLY Rule 6 (absolute P&L stop) can force exit in these windows
  → Reasoning: price swings here are disproportionately noisy
```

### Rule 5 — Delta Monitoring
```
After every tick, recalculate delta for short CE and short PE
using Black-Scholes: calculateDelta(spot, strike, iv, timeToExpiry)

If short CE delta > 0.35:
  → Position is moving ITM, risk increasing
  → StateMachine: ACTIVE → FLAGGED
  → Log: "Short CE delta 0.37 — position flagged"
  → Telegram alert

If short PE delta < -0.35:
  → Same treatment, other side

Once FLAGGED:
  → Increase monitoring frequency
  → Rules 2, 3 checks happen on every 5m close (not just 15m)
  → Rule 8 eligible (Claude hunt check in HYBRID/AI mode)

Delta resets flag if it comes back inside threshold:
  → FLAGGED → ACTIVE (only if delta returns below 0.30 with buffer)
  → Log: "Delta recovered to 0.29 — flag cleared"
```

### Rule 6 — Absolute P&L Stop (Immediate Exit)
```
Threshold: currentPositionLoss > MAX_DAILY_LOSS * ABSOLUTE_PNL_STOP_PCT
           = ₹5000 * 0.50 = ₹2500

This rule:
  → Bypasses Rules 1, 2, 3, 4 (including dangerous windows)
  → Bypasses Rule 8 (no Claude hunt check)
  → Triggers FORCE_EXIT immediately
  → Emits CIRCUIT_BREAKER_HIT

Checked on every single tick (not just candle close).
This is the only rule that can exit mid-dangerous-window.
```

### Rule 7 — Non-Obvious Strikes (enforced at entry, not monitoring)
```
At trade construction time (buildTrade):
  If shortCE strike lands on exact hundred boundary
    (24000, 24100, 24200...):
    → Shift short CE by +50 → 24050, 24150, etc.
  Apply same to shortPE if needed.

Why: round number strikes have more OI, attract more manipulation.
     Shifting +50 means you're not the obvious target.

This rule fires once at entry, not during monitoring.
```

---

## Layer 5 — Exit Decision Rules

All checked in this priority order:

```
Priority 1 (every tick)
  Rule 6: Absolute P&L Stop
  → if triggered: FORCE_EXIT immediately

Priority 2 (every tick, inside dangerous window)
  Rule 4: Time window check
  → if inside dangerous window: suppress exit from Rules 2, 3, 5
  → Rule 6 still applies

Priority 3 (every 15m candle close)
  Rule 1 + 2: Candle close beyond buffer
  → 15m candle close above shortCE + 75 → begin exit evaluation
  → 15m candle close below shortPE - 75 → begin exit evaluation
  → Rule 3 (volume) applied to confirm
  → Rule 8 applied if FLAGGED (HYBRID/AI modes only)

Priority 4 (scheduled)
  SQUARE_OFF_TIME cron (15:15 IST)
  → unconditional exit, no scoring needed

Priority 5 (delta breach, every 5m when FLAGGED)
  Rule 5: If delta stays above threshold for 2+ consecutive 5m closes
  → proceed to exit (sustained breach, not momentary)
```

### Exit Suppression Logic

Before executing any exit (except Rule 6 and 15:15 cron), check:
```
Is Rule 4 active (dangerous window)?  → suppress
Did Rule 3 say low volume (hunt)?     → suppress, wait for next candle
Did Rule 8 say likely hunt?           → suppress, watch next 15m candle
All three say "proceed"?              → execute exit
```

---

## Rule Engine vs Claude — What Each Decides

```
DECISION                          RULES MODE     HYBRID MODE     AI MODE
────────────────────────────────────────────────────────────────────────
Market regime                     Rule engine    Rule engine     Claude
Strategy selection                Rule engine    Rule engine     Claude
Entry score / eligibility         Rule engine    Rule engine     Rule engine (gate)
Entry confidence check            Rule engine    Claude          Claude
Strike selection                  Rule engine    Rule engine     Claude
Exit: absolute P&L stop           Rule engine    Rule engine     Rule engine
Exit: time-based square-off       Rule engine    Rule engine     Rule engine
Exit: candle close breach         Rule engine    Rule engine     Rule engine
Exit: delta breach                Rule engine    Rule engine     Rule engine
Hunt detection                    SKIPPED        Claude          Claude
Hunt detection (Claude down)      Rule engine    Rule engine     Rule engine
────────────────────────────────────────────────────────────────────────
```

The rule engine always owns exit decisions. Claude only ever adds a second
opinion on entry and hunt detection — it never makes unilateral exit calls.

---

## Rule Engine Data Requirements

Every time the scorer or regime classifier runs, it needs this snapshot:

```js
marketData = {
  // Price
  spot: 24185,
  dayOpen: 24142,
  dayHigh: 24210,
  dayLow: 24098,
  firstHourHigh: 24198,
  firstHourLow: 24110,

  // Time
  currentTimeIST: "11:32",

  // Indicators (from IndicatorEngine)
  rsi: 51.2,
  ema9: 24180,
  ema21: 24175,
  ema50: 24150,
  macd: { line: 0.02, signal: 0.01, histogram: 0.01 },
  bb: { upper: 24300, middle: 24175, lower: 24050, width: 1.04 },
  bbWidthPct: 2.7,
  bbSqueezing: false,         // width contracting 5+ candles?
  atr: 85,
  adx: 16.2,
  adxSlope: -0.4,             // negative = decelerating trend
  plusDI: 18.1,
  minusDI: 16.8,

  // Options chain
  pcr: 1.05,
  maxCeOiLevel: 24500,
  maxPeOiLevel: 23900,
  ivPercentile: 58,
  indiaVix: 16.4,

  // Candle history
  candles1m: [...],   // last 200
  candles5m: [...],   // last 200
  candles15m: [...],  // last 200

  // Volume
  currentVolume: 12400,
  avgVolume20: 9800
}
```

---

## Adding a New Rule (How-To)

1. Add the rule as a method in `monitoring/anti-hunt.js`
2. Give it a name constant in `core/events.js` if it emits an event
3. Register it in `monitoring/position-tracker.js` under the correct trigger
   (tick, 5m close, or 15m close)
4. Document it in this file under Layer 4 with: trigger, check, action, why

Never add rule logic directly to position-tracker.js or the strategy files.
anti-hunt.js is the single home for all position management rules.
