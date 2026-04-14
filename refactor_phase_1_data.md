# TASK: Refactor Phase 1 Data Layer with `stock-nse-india`

## Context
The current manual NSE polling in `data/sources/nse-source.js` is being blocked by NSE bot detection. We are replacing the raw axios/request logic with the `stock-nse-india` library to handle sessions, cookies, and data fetching more reliably.

## Objective
Update the Phase 1 files to use `NseIndia` from `stock-nse-india` while maintaining the existing Event-Driven architecture and `CLAUDE.md` design rules.

## Design Rules to Maintain
1. **Event Bus Only**: All data must still be emitted via `eventBus.emit(EVENTS.TICK_RECEIVED, ...)`.
2. **Factory Pattern**: `tick-stream.js` should still act as the switcher.
3. **No Magic Strings**: Use `EVENTS` constants from `core/events.js`.
4. **Error Handling**: Use the standard log format: `[HH:mm:ss] [MODULE] [LEVEL] message`.

## Required Changes

### 1. `data/sources/nse-source.js`
- Initialize `const nse = new NseIndia()`
- Replace raw polling with `nse.getEquityStockIndices("NIFTY 50")`.
- Extract the NIFTY price from the response and emit `TICK_RECEIVED`.
- Handle the asynchronous "cookie initialization" inside the `start()` method.

### 2. `data/options-chain.js`
- Replace manual JSON fetching with `nse.getOptionChain("NIFTY")`.
- Update the parser to match the object structure returned by the library.
- Ensure the 15-minute interval is respected to avoid rate-limiting.

### 3. `data/historical.js`
- Use the library's historical data methods to seed the `CandleBuilder`.
- Maintain the fallback chain: `Library Fetch -> Yahoo Finance -> Local Cache`.

### 4. `data/indicator-engine.js`
- **Volume Fallback**: Since NSE volume is often 0 or delayed, add a `tickCount` property to the candle object in `CandleBuilder` and use it as a proxy for activity if `volume` is missing.

## Success Criteria
- `test-phase1.js` passes with the new data source.
- No `401` or `403` errors from NSE during a 10-minute trial run.
- `SessionContext` correctly receives the `dayOpen` and `high/low` from the new data stream.