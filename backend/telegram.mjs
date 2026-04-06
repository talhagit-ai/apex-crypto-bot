// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Telegram Notifications
// ═══════════════════════════════════════════════════════════════

const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function send(text) {
  if (!TOKEN || !CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (_) {}
}

export function notifyBuy(assetId, qty, price, sl, tp, conf) {
  const emoji = '🟢';
  send(
    `${emoji} <b>BUY ${assetId}</b>\n` +
    `Prijs: €${price.toFixed(4)}\n` +
    `Qty: ${qty}\n` +
    `SL: €${sl.toFixed(4)} | TP: €${tp.toFixed(4)}\n` +
    `Signaal: ${conf}/6 factoren`
  );
}

export function notifyShort(assetId, qty, price, sl, tp, conf) {
  send(
    `🔴 <b>SHORT ${assetId}</b>\n` +
    `Prijs: €${price.toFixed(4)}\n` +
    `Qty: ${qty}\n` +
    `SL: €${sl.toFixed(4)} | TP: €${tp.toFixed(4)}\n` +
    `Signaal: ${conf}/6 factoren`
  );
}

export function notifySell(assetId, qty, price, pnl, reason) {
  const emoji = pnl >= 0 ? '💰' : '🛑';
  const pnlStr = pnl >= 0 ? `+€${pnl.toFixed(2)}` : `-€${Math.abs(pnl).toFixed(2)}`;
  send(
    `${emoji} <b>SELL ${assetId}</b> — ${reason}\n` +
    `Prijs: €${price.toFixed(4)}\n` +
    `PnL: <b>${pnlStr}</b>`
  );
}

export function notifyPartial(assetId, partialNum, price, pnl) {
  send(
    `💵 <b>PARTIAL P${partialNum} ${assetId}</b>\n` +
    `Prijs: €${price.toFixed(4)}\n` +
    `Winst: +€${pnl.toFixed(2)}`
  );
}

export function notifyStartup(capital, assetCount) {
  send(
    `🚀 <b>APEX Bot gestart</b>\n` +
    `Kapitaal: €${capital}\n` +
    `Coins gescand: ${assetCount}\n` +
    `Status: Live op Kraken`
  );
}

export function notifyError(msg) {
  send(`⚠️ <b>Bot fout</b>\n${msg}`);
}
