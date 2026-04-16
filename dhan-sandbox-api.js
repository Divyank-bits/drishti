const axios = require('axios');

const TOKEN = "eyJhbGciOiJIUzUxMiIsInR5cCI6IkpXVCJ9.eyJ0b2tlbkNvbnN1bWVyVHlwZSI6IlNFTEYiLCJwYXJ0bmVySWQiOiIiLCJkaGFuQ2xpZW50SWQiOiIyNjA0MTYzMjI2Iiwid2ViaG9va1VybCI6IiIsImlzcyI6ImRoYW4iLCJleHAiOjE3Nzg5MTM0ODd9.oe8-4GS4BWMAPzNrUTpFYSjmDQy5FLJbbS72nJYAyW_VYzPmqD4XyNkH757b5T1ZA2T5r-8gx01GgimDpR-BwA";

const BASE_URL = "https://sandbox.dhan.co/v2";

async function testOrders() {
    try {
        const res = await axios.get(`${BASE_URL}/orders`, {
            headers: {
                "access-token": TOKEN
            }
        });

        console.log("✅ Orders Response:");
        console.log(res.data);
    } catch (err) {
        console.error("❌ Error:", err.response?.data || err.message);
    }
}

async function placeOrder() {
    try {
        const res = await axios.post(`${BASE_URL}/orders`, {
            transactionType: "BUY",
            exchangeSegment: "NSE_EQ",
            productType: "INTRADAY",
            orderType: "MARKET",
            validity: "DAY",
            securityId: "11536", // Example stock
            quantity: 1
        }, {
            headers: {
                "access-token": TOKEN,
                "Content-Type": "application/json"
            }
        });

        console.log("✅ Order Placed:");
        console.log(res.data);
    } catch (err) {
        console.error("❌ Order Error:", err.response?.data || err.message);
    }
}
async function getPortfolio() {
    try {
        const res = await axios.get(`${BASE_URL}/portfolio`, {
            headers: {
                "access-token": TOKEN
            }
        });

        console.log("📊 Portfolio:");
        console.log(res.data);
    } catch (err) {
        console.error("❌ Portfolio Error:", err.response?.data || err.message);
    }
}
async function getFunds() {
    try {
        const res = await axios.get(`${BASE_URL}/funds`, {
            headers: {
                "access-token": TOKEN
            }
        });

        console.log("💰 Funds:");
        console.log(res.data);
    } catch (err) {
        console.error("❌ Funds Error:", err.response?.data || err.message);
    }
}
async function placeOrder() {
    try {
        const res = await axios.post(`${BASE_URL}/orders`, {
            transactionType: "BUY",
            exchangeSegment: "NSE_EQ",
            productType: "INTRADAY",
            orderType: "MARKET",
            validity: "DAY",
            securityId: "11536", // TCS example
            quantity: 1
        }, {
            headers: {
                "access-token": TOKEN,
                "Content-Type": "application/json"
            }
        });

        console.log("🟢 Order Placed:");
        console.log(res.data);

        return res.data?.orderId;

    } catch (err) {
        console.error("❌ Order Error:", err.response?.data || err.message);
    }
}
async function cancelOrder(orderId) {
    try {
        const res = await axios.delete(`${BASE_URL}/orders/${orderId}`, {
            headers: {
                "access-token": TOKEN
            }
        });

        console.log("🔴 Order Cancelled:");
        console.log(res.data);

    } catch (err) {
        console.error("❌ Cancel Error:", err.response?.data || err.message);
    }
}
async function run() {
    await getFunds();
    await getPortfolio();

    const orderId = await placeOrder();

    if (orderId) {
        await cancelOrder(orderId);
    }
}

async function getIntradayOHLC() {
    try {
        const res = await axios.post(
            `${BASE_URL}/charts/intraday`,
            {
                securityId: "13",
                exchangeSegment: "IDX_I",
                instrument: "INDEX",
                fromDate: "2026-04-16",
                toDate: "2026-04-16"
            },
            {
                headers: {
                    "access-token": TOKEN,
                    "Content-Type": "application/json"
                }
            }
        );

        console.log("📈 OHLC Data:");
        console.log(res.data);

    } catch (err) {
        console.error("❌ OHLC Error:", err.response?.data || err.message);
    }
}
getIntradayOHLC();
// run();
// Run tests
// testOrders();
// placeOrder();