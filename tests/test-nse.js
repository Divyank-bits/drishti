// test-nse.js
const nseSource = require('../data/sources/nse-source.js');
const eventBus = require('../core/event-bus');
const EVENTS = require('../core/events');

console.log("--- Starting NSE Source Test ---");

eventBus.on(EVENTS.TICK_RECEIVED, (data) => {
    console.log(`[EVENT] TICK_RECEIVED: ${data.symbol} @ ${data.ltp}`);
});

eventBus.on(EVENTS.WEBSOCKET_CONNECTED, () => {
    console.log("[EVENT] System connected to NSE successfully!");
});

nseSource.start();