// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V3 — Persistence (Turso / libSQL)
//  Works with local SQLite file OR Turso cloud database.
//  Local:      LIBSQL_URL=file:db/apex.db  (no auth needed)
//  Production: LIBSQL_URL=libsql://....turso.io  LIBSQL_AUTH_TOKEN=...
// ═══════════════════════════════════════════════════════════════

import { createClient } from '@libsql/client';
import { mkdirSync } from 'fs';
import { log } from './logger.mjs';

let db;

export async function initDB() {
  const url       = process.env.LIBSQL_URL || 'file:db/apex.db';
  const authToken = process.env.LIBSQL_AUTH_TOKEN || undefined;

  // Create local dir if using file-based SQLite
  if (url.startsWith('file:')) {
    const path = url.replace('file:', '');
    const dir  = path.replace(/\/[^/]+$/, '');
    if (dir && dir !== path) mkdirSync(dir, { recursive: true });
  }

  db = createClient({ url, authToken });

  await db.execute(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset TEXT NOT NULL,
      side TEXT NOT NULL,
      price REAL NOT NULL,
      qty REAL NOT NULL,
      pnl REAL,
      r REAL,
      reason TEXT,
      timestamp INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equity REAL NOT NULL,
      cash REAL NOT NULL,
      unrealized REAL NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated INTEGER NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS optimizer_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      baseline_avg REAL,
      new_avg REAL,
      improvement_pct REAL,
      trades_used INTEGER,
      changes TEXT,
      elapsed TEXT,
      timestamp INTEGER NOT NULL
    )
  `);

  const mode = url.startsWith('file:') ? 'local SQLite' : 'Turso cloud';
  log.info(`Database initialized (${mode})`, { url: url.replace(/\?.*/, '') });
  return db;
}

export async function saveTrade(trade) {
  if (!db) return;
  await db.execute({
    sql: `INSERT INTO trades (asset, side, price, qty, pnl, r, reason, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [trade.id, trade.side, trade.price, trade.qty, trade.pnl ?? null, trade.r ?? null, trade.reason ?? null, trade.timestamp],
  });
}

export async function saveEquitySnapshot(equity, cash, unrealized) {
  if (!db) return;
  await db.execute({
    sql: `INSERT INTO equity_snapshots (equity, cash, unrealized, timestamp) VALUES (?, ?, ?, ?)`,
    args: [equity, cash, unrealized, Date.now()],
  });
}

export async function saveState(key, value) {
  if (!db) return;
  await db.execute({
    sql: `INSERT OR REPLACE INTO state (key, value, updated) VALUES (?, ?, ?)`,
    args: [key, JSON.stringify(value), Date.now()],
  });
}

export async function loadState(key) {
  if (!db) return null;
  const result = await db.execute({ sql: 'SELECT value FROM state WHERE key = ?', args: [key] });
  const row = result.rows[0];
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch (e) {
    log.error(`Corrupted state for key "${key}" — ignoring`, { err: e.message });
    return null;
  }
}

export async function getRecentTrades(limit = 100) {
  if (!db) return [];
  const result = await db.execute({
    sql: 'SELECT * FROM trades ORDER BY id DESC LIMIT ?',
    args: [limit],
  });
  // Convert libsql rows to plain objects
  return result.rows.map(r => ({
    id: r.id, asset: r.asset, side: r.side, price: r.price,
    qty: r.qty, pnl: r.pnl, r: r.r, reason: r.reason, timestamp: r.timestamp,
  }));
}

export async function saveOptimizerRun(result) {
  if (!db) return;
  await db.execute({
    sql: `INSERT INTO optimizer_runs (status, baseline_avg, new_avg, improvement_pct, trades_used, changes, elapsed, timestamp)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      result.status,
      result.baseline?.avgPnl ?? null,
      result.new?.avgPnl ?? null,
      result.improvement ?? null,
      result.tradesUsed ?? null,
      result.changes ? JSON.stringify(result.changes) : null,
      result.elapsed ?? null,
      Date.now(),
    ],
  });
}

export async function getOptimizerHistory(limit = 10) {
  if (!db) return [];
  const result = await db.execute({
    sql: 'SELECT * FROM optimizer_runs ORDER BY id DESC LIMIT ?',
    args: [limit],
  });
  return result.rows.map(r => ({
    id: r.id, status: r.status, baseline_avg: r.baseline_avg,
    new_avg: r.new_avg, improvement_pct: r.improvement_pct,
    trades_used: r.trades_used, elapsed: r.elapsed, timestamp: r.timestamp,
    changes: r.changes ? JSON.parse(r.changes) : null,
  }));
}

export async function getEquityHistory(limit = 500) {
  if (!db) return [];
  const result = await db.execute({
    sql: 'SELECT * FROM equity_snapshots ORDER BY id DESC LIMIT ?',
    args: [limit],
  });
  return result.rows.map(r => ({
    id: r.id, equity: r.equity, cash: r.cash, unrealized: r.unrealized, timestamp: r.timestamp,
  }));
}

// ── Engine State Persistence (Phase 1) ────────────────────────

export async function saveEngineState(state) {
  await saveState('engine_state', { ...state, savedAt: Date.now() });
}

export async function loadEngineState() {
  const state = await loadState('engine_state');
  if (!state) return null;
  // Only restore if saved within last 30 minutes
  if (Date.now() - (state.savedAt || 0) > 30 * 60 * 1000) return null;
  return state;
}

export async function saveFuturesReadiness(data) {
  await saveState('futures_readiness', data);
}

export async function loadFuturesReadiness() {
  return await loadState('futures_readiness');
}

export async function closeDB() {
  if (db) {
    db.close();
    log.info('Database closed');
  }
}
