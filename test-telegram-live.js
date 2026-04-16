/**
 * @file test-telegram-live.js
 * @description Live Telegram connectivity check. Sends a real test message.
 *              Run: node test-telegram-live.js
 *              Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env
 */
'use strict';

require('dotenv').config();

const token  = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

console.log('\n── Telegram Live Connectivity Check ─────────────────────────────\n');

if (!token) {
  console.error('  ✗ TELEGRAM_BOT_TOKEN is missing from .env');
  process.exit(1);
}
if (!chatId) {
  console.error('  ✗ TELEGRAM_CHAT_ID is missing from .env');
  process.exit(1);
}

console.log(`  Token  : ${token.slice(0, 10)}...${token.slice(-4)}`);
console.log(`  Chat ID: ${chatId}`);
console.log('');

const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(token, { polling: false });

async function run() {
  // Step 1: Verify token by calling getMe
  try {
    const me = await bot.getMe();
    console.log(`  ✓ Bot identity: @${me.username} (${me.first_name})`);
  } catch (err) {
    console.error(`  ✗ getMe() failed — bad token? ${err.message}`);
    process.exit(1);
  }

  // Step 2: Send a test message
  try {
    const msg = await bot.sendMessage(
      chatId,
      `*Drishti — Test Message*\n\nTelegram connectivity confirmed.\nTime: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
      { parse_mode: 'Markdown' }
    );
    console.log(`  ✓ Message sent (message_id: ${msg.message_id})`);
    console.log('\n  Check your Telegram — you should see the test message.\n');
  } catch (err) {
    console.error(`  ✗ sendMessage() failed: ${err.message}`);
    if (err.message.includes('chat not found')) {
      console.error('    → TELEGRAM_CHAT_ID is wrong. Get your correct ID by messaging @userinfobot on Telegram.');
    }
    if (err.message.includes('Forbidden')) {
      console.error('    → Bot cannot message this chat. Send /start to your bot first.');
    }
    process.exit(1);
  }
}

run();
