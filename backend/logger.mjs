// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V1 — Logger
// ═══════════════════════════════════════════════════════════════

import { appendFileSync } from 'fs';

const LOG_FILE = 'apex.log';

function ts() {
  return new Date().toISOString();
}

function write(level, msg, data) {
  const line = `[${ts()}] ${level} ${msg}${data ? ' ' + JSON.stringify(data) : ''}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

export const log = {
  info:  (msg, data) => write('INFO ', msg, data),
  warn:  (msg, data) => write('WARN ', msg, data),
  error: (msg, data) => write('ERROR', msg, data),
  trade: (msg, data) => write('TRADE', msg, data),
  signal:(msg, data) => write('SIGNAL', msg, data),
};
