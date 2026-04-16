const WebSocket = require('ws');
const https = require('https');

const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzUxMiJ9.eyJpc3MiOiJkaGFuIiwicGFydG5lcklkIjoiIiwiZXhwIjoxNzc2NDEyMjk0LCJpYXQiOjE3NzYzMjU4OTQsInRva2VuQ29uc3VtZXJUeXBlIjoiU0VMRiIsIndlYmhvb2tVcmwiOiIiLCJkaGFuQ2xpZW50SWQiOiIxMTExMjM5ODIwIn0.hB5UKRQBYO-TgZfvV4oXkHuqIMyT7snUioYhccdLatBODd3MFKNHk0G0KFLszhg_HcHnNYzgMYBZtV4GoMu4Pg"; // your token
const CLIENT_ID = "1111239820";

// ── STEP 1: Test profile/auth via REST first ──────────────────────────
function testAuth() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.dhan.co',
            path: '/v2/fundlimit',  // simple authenticated endpoint
            method: 'GET',
            headers: {
                'access-token': TOKEN,
                'client-id': CLIENT_ID,
                'Content-Type': 'application/json'
            }
        };

        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                console.log(`🔑 Auth test: HTTP ${res.statusCode}`);
                console.log(body.substring(0, 200));
                resolve(res.statusCode === 200);
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// ── STEP 2: Connect WebSocket only after auth passes ──────────────────
async function startFeed() {
    const authOk = await testAuth();
    if (!authOk) {
        console.error("❌ Auth failed — check token & Data API subscription in Dhan portal");
        return;
    }

    const wsUrl = `wss://api-feed.dhan.co?version=2&token=${TOKEN}&clientId=${CLIENT_ID}&authType=2`;
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log("✅ Connected to Dhan Live Feed!");

        const subscribeMsg = {
            "RequestCode": 15,
            "InstrumentCount": 1,
            "InstrumentList": [
                {
                    "ExchangeSegment": "IDX_I",
                    "SecurityId": "13"
                }
            ]
        };

        ws.send(JSON.stringify(subscribeMsg));
        console.log("📡 Subscribed to NIFTY 50...");
    });

    ws.on('message', (data) => {
        if (!Buffer.isBuffer(data)) return;

        const responseCode = data.readUInt8(0);
        console.log(`📦 Packet received — Response Code: ${responseCode}, Length: ${data.length}`);

        switch (responseCode) {
            case 2: { // Ticker
                const ltp = data.readFloatLE(8);
                const ltt = data.readInt32LE(12);
                console.log(`[TICKER] NIFTY 50: ₹${ltp.toFixed(2)} | ${new Date(ltt * 1000).toLocaleTimeString()}`);
                break;
            }
            case 6: { // Prev Close
                const prevClose = data.readFloatLE(8);
                console.log(`[PREV CLOSE] ₹${prevClose.toFixed(2)}`);
                break;
            }
            case 50: { // Disconnection packet
                const reason = data.readInt16LE(8);
                console.error(`[DISCONNECT] Server sent reason code: ${reason}`);
                break;
            }
            default:
                console.log(`[UNKNOWN] Code ${responseCode}, raw:`, data.toString('hex'));
        }
    });

    // Explicit pong handling (belt + suspenders)
    ws.on('ping', () => {
        console.log('🏓 Ping received, sending pong...');
        ws.pong();
    });

    ws.on('error', (err) => console.error("❌ WS Error:", err.message));

    ws.on('close', (code, reason) => {
        console.log(`🔌 Closed: ${code} | Reason: "${reason.toString()}"`);
        if (code === 1006) {
            console.log("⚠️  1006 = abnormal close. Likely causes:");
            console.log("   1. Data API subscription not active (check Dhan portal)");
            console.log("   2. Token expired");
            console.log("   3. Market is closed (no index ticks outside 9:15–15:30 IST)");
        }
    });
}

startFeed();