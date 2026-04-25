// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Logger
//  Console-only (Render captures stdout; file writes are wasted on ephemeral FS)
//  Set LOG_LEVEL=warn to suppress INFO/SIGNAL spam during backtests.
//  Levels: silent < error < warn < trade < info < signal (default: info)
// ═══════════════════════════════════════════════════════════════

const LEVELS = { silent: 0, error: 1, warn: 2, trade: 3, info: 4, signal: 5 };
const envLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
let currentLevel = LEVELS[envLevel] ?? LEVELS.info;

function ts() {
  return new Date().toISOString();
}

function write(level, levelName, msg, data) {
  if (level > currentLevel) return;
  console.log(`[${ts()}] ${levelName} ${msg}${data ? ' ' + JSON.stringify(data) : ''}`);
}

export const log = {
  info:   (msg, data) => write(LEVELS.info,   'INFO  ', msg, data),
  warn:   (msg, data) => write(LEVELS.warn,   'WARN  ', msg, data),
  error:  (msg, data) => write(LEVELS.error,  'ERROR ', msg, data),
  trade:  (msg, data) => write(LEVELS.trade,  'TRADE ', msg, data),
  signal: (msg, data) => write(LEVELS.signal, 'SIGNAL', msg, data),
};

export function setLevel(level) {
  currentLevel = LEVELS[level] ?? LEVELS.info;
}
