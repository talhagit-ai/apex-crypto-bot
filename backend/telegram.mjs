// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Telegram Notifications + AI Chat
//  Sends trade alerts AND polls for user messages to reply via Claude
// ═══════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';
import { log } from './logger.mjs';

const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ── Outgoing Notifications ─────────────────────────────────────

async function send(text, chatId = CHAT_ID) {
  if (!TOKEN || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (_) {}
}

export function notifyBuy(assetId, qty, price, sl, tp, conf) {
  send(
    `🟢 <b>BUY ${assetId}</b>\n` +
    `Prijs: $${price.toFixed(4)}\n` +
    `Qty: ${qty}\n` +
    `SL: $${sl.toFixed(4)} | TP: $${tp.toFixed(4)}\n` +
    `Signaal: ${conf}/6 factoren`
  );
}

export function notifyShort(assetId, qty, price, sl, tp, conf) {
  send(
    `🔴 <b>SHORT ${assetId}</b>\n` +
    `Prijs: $${price.toFixed(4)}\n` +
    `Qty: ${qty}\n` +
    `SL: $${sl.toFixed(4)} | TP: $${tp.toFixed(4)}\n` +
    `Signaal: ${conf}/6 factoren`
  );
}

export function notifySell(assetId, qty, price, pnl, reason) {
  const emoji  = pnl >= 0 ? '💰' : '🛑';
  const pnlStr = pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`;
  send(
    `${emoji} <b>SELL ${assetId}</b> — ${reason}\n` +
    `Prijs: $${price.toFixed(4)}\n` +
    `PnL: <b>${pnlStr}</b>`
  );
}

export function notifyPartial(assetId, partialNum, price, pnl) {
  send(
    `💵 <b>PARTIAL P${partialNum} ${assetId}</b>\n` +
    `Prijs: $${price.toFixed(4)}\n` +
    `Winst: +$${pnl.toFixed(2)}`
  );
}

export function notifyStartup(capital, assetCount) {
  send(
    `🚀 <b>APEX Bot gestart</b>\n` +
    `Kapitaal: $${capital}\n` +
    `Coins gescand: ${assetCount}\n` +
    `Status: Live op Kraken\n\n` +
    `💬 Je kunt nu met mij praten! Stel gewoon een vraag.`
  );
}

export function notifyError(msg) {
  send(`⚠️ <b>Bot fout</b>\n${msg}`);
}

// ── AI Chat System ─────────────────────────────────────────────

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
let anthropic = null;
if (ANTHROPIC_KEY) {
  anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });
}

// Conversation history per chat_id → [{role, content}]
const conversations = new Map();

// Injected by server.mjs so we can access live bot state
let getStateFn = null;

function buildSystemPrompt(state) {
  const now = new Date().toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' });

  const positions = state?.positions || {};
  const stats     = state?.stats     || {};
  const equity    = state?.equity    ?? 0;
  const cash      = state?.cash      ?? 0;
  const posCount  = Object.keys(positions).length;

  let posStr = 'Geen open posities';
  if (posCount > 0) {
    posStr = Object.entries(positions).map(([id, p]) => {
      const pnl = p.unrealizedPnl ?? 0;
      const sign = pnl >= 0 ? '+' : '';
      return `  • ${id} (${p.side}): ${p.qty} @ $${(p.entry || 0).toFixed(2)}, PnL: ${sign}$${pnl.toFixed(2)}`;
    }).join('\n');
  }

  const regimes  = state?.regimes  || {};
  const regStr   = Object.entries(regimes)
    .map(([id, r]) => `${id}:${r}`)
    .join(', ') || 'geen data';

  const recentTrades = (state?.trades || []).slice(-5).reverse().map(t =>
    `  • ${t.side} ${t.id} @ $${(t.price || 0).toFixed(2)} (${t.reason || ''})`
  ).join('\n') || '  Nog geen trades';

  return `Je bent APEX, een AI crypto trading bot die live handelt op Kraken. Je wordt aangestuurd door een 6-factor signaal systeem (EMA stack, VWAP, RSI, MACD, Volume, RSI-acceleratie) met multi-timeframe regime filtering.

LIVE STATUS — ${now}
━━━━━━━━━━━━━━━━━━━━━━
Portfolio: $${equity.toFixed(2)} (cash: $${cash.toFixed(2)})
Open posities (${posCount}):
${posStr}

Performance:
  Win rate: ${stats.winRate ?? 0}% | Profit factor: ${stats.profitFactor ?? '—'}
  Trades: ${stats.totalTrades ?? 0} (${stats.wins ?? 0}W / ${stats.losses ?? 0}L)

Markt regimes (1h): ${regStr}

Laatste trades:
${recentTrades}
━━━━━━━━━━━━━━━━━━━━━━

Je praat in het Nederlands. Je bent eerlijk over risico's. Je kunt je eigen code, strategie, en posities uitleggen. Je geeft concrete antwoorden op wat er gevraagd wordt — kort en duidelijk, tenzij meer detail gevraagd wordt.`;
}

async function handleMessage(chatId, userText) {
  if (!anthropic) {
    return (
      '❌ ANTHROPIC_API_KEY is niet ingesteld.\n' +
      'Ga naar Render → Environment → voeg ANTHROPIC_API_KEY toe.\n' +
      'Haal je key op via console.anthropic.com'
    );
  }

  if (!conversations.has(chatId)) conversations.set(chatId, []);
  const history = conversations.get(chatId);

  history.push({ role: 'user', content: userText });

  // Keep last 20 messages
  if (history.length > 20) history.splice(0, history.length - 20);

  try {
    const state  = getStateFn ? getStateFn() : null;
    const system = buildSystemPrompt(state);

    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system,
      messages:   history,
    });

    const reply = response.content[0]?.text || 'Geen antwoord ontvangen.';
    history.push({ role: 'assistant', content: reply });
    return reply;

  } catch (err) {
    log.error('Telegram AI chat error', { err: err.message });
    return `⚠️ AI fout: ${err.message}`;
  }
}

// ── Telegram Webhook Handler ───────────────────────────────────

/**
 * Process an incoming update from Telegram webhook.
 * Called by server.mjs POST /telegram-webhook
 */
export async function handleWebhookUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId   = String(msg.chat.id);
  const userText = msg.text.trim();

  log.info(`Telegram message from ${chatId}: "${userText.slice(0, 60)}"`);

  // Typing indicator
  fetch(`https://api.telegram.org/bot${TOKEN}/sendChatAction`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});

  // Reply async
  handleMessage(chatId, userText).then(reply => {
    send(reply, chatId);
  }).catch(err => {
    send(`⚠️ Fout: ${err.message}`, chatId);
  });
}

/**
 * Register webhook with Telegram and start chat.
 * @param {() => object} stateFn — returns current engine state
 * @param {string} publicUrl — e.g. https://apex-crypto-bot-c3bt.onrender.com
 */
export async function startTelegramChat(stateFn, publicUrl) {
  getStateFn = stateFn;

  if (!TOKEN) {
    log.warn('Telegram chat disabled (TELEGRAM_TOKEN not set)');
    return;
  }
  if (!ANTHROPIC_KEY) {
    log.warn('Telegram AI disabled (ANTHROPIC_API_KEY not set) — notifications still work');
  }

  if (!publicUrl) {
    log.warn('Telegram webhook: PUBLIC_URL not set — chat disabled');
    return;
  }

  const webhookUrl = `${publicUrl}/telegram-webhook`;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        url:             webhookUrl,
        allowed_updates: ['message'],
        drop_pending_updates: true,
      }),
    });
    const data = await resp.json();
    if (data.ok) {
      log.info(`Telegram webhook set: ${webhookUrl}`);
    } else {
      log.warn('Telegram webhook set failed', { desc: data.description });
    }
  } catch (e) {
    log.warn('Telegram webhook setup failed', { err: e.message });
  }
}
