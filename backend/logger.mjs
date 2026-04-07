// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Logger
//  Console-only (Render captures stdout; file writes are wasted on ephemeral FS)
// ═══════════════════════════════════════════════════════════════

function ts() {
  return new Date().toISOString();
}

function write(level, msg, data) {
  console.log(`[${ts()}] ${level} ${msg}${data ? ' ' + JSON.stringify(data) : ''}`);
}

export const log = {
  info:  (msg, data) => write('INFO ', msg, data),
  warn:  (msg, data) => write('WARN ', msg, data),
  error: (msg, data) => write('ERROR', msg, data),
  trade: (msg, data) => write('TRADE', msg, data),
  signal:(msg, data) => write('SIGNAL', msg, data),
};
