'use strict';

const TelegramBot = require('node-telegram-bot-api');

// ── VALIDACIÓN SEGURA ──
if (!process.env.BOT_TOKEN) {
  console.error("❌ ERROR: Falta BOT_TOKEN");
  process.exit(1);
}

const TOKEN = process.env.BOT_TOKEN;

// ── INTENTAR GOOGLE SOLO SI EXISTE ──
let google = null;

if (process.env.GOOGLE_CREDENTIALS) {
  try {
    google = require('googleapis').google;
    JSON.parse(process.env.GOOGLE_CREDENTIALS);
    console.log("✅ Google credentials OK");
  } catch (e) {
    console.error("❌ ERROR en GOOGLE_CREDENTIALS:", e.message);
  }
} else {
  console.log("⚠️ Google desactivado (no hay credenciales)");
}

// ── BOT ──
const bot = new TelegramBot(TOKEN, { polling: true });

// ── /start ──
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "🚛 Bot funcionando correctamente ✅");
});

// ── MENSAJE GENERAL ──
bot.on('message', (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  bot.sendMessage(msg.chat.id, "Escribe /start");
});

console.log("🚛 Bot iniciado correctamente");
