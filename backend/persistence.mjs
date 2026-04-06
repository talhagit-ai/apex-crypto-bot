// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V1 — Persistence (SQLite)
//  Trade logging, equity snapshots, state recovery
// ═══════════════════════════════════════════════════════════════

import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { log } from './logger.mjs';

const DB_PATH = process.env.DB_PATH || 'db/apex.db';

let db;

export function initDB() {
  // Ensure the directory exists (needed on Render and fresh installs)
  mkdirSync(DB_PATH.replace(/\/[^/]+$/, ''), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
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
    );

    CREATE TABLE IF NOT EXISTS equity_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equity REAL NOT NULL,
      cash REAL NOT NULL,
      unrealized REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated INTEGER NOT NULL
    );

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
    );
  `);

  log.info('Database initialized', { path: DB_PATH });
  return db;
}

export function saveTrade(trade) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO trades (asset, side, price, qty, pnl, r, reason, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(trade.id, trade.side, trade.price, trade.qty, trade.pnl, trade.r, trade.reason, trade.timestamp);
}

export function saveEquitySnapshot(equity, cash, unrealized) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO equity_snapshots (equity, cash, unrealized, timestamp)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(equity, cash, unrealized, Date.now());
}

export function saveState(key, value) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO state (key, value, updated) VALUES (?, ?, ?)
  `);
  stmt.run(key, JSON.stringify(value), Date.now());
}

export function loadState(key) {
  if (!db) return null;
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

export function getRecentTrades(limit = 100) {
  if (!db) return [];
  return db.prepare('SELECT * FROM trades ORDER BY id DESC LIMIT ?').all(limit);
}

export function saveOptimizerRun(result) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT INTO optimizer_runs (status, baseline_avg, new_avg, improvement_pct, trades_used, changes, elapsed, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    result.status,
    result.baseline?.avgPnl ?? null,
    result.new?.avgPnl ?? null,
    result.improvement ?? null,
    result.tradesUsed ?? null,
    result.changes ? JSON.stringify(result.changes) : null,
    result.elapsed ?? null,
    Date.now(),
  );
}

export function getOptimizerHistory(limit = 10) {
  if (!db) return [];
  return db.prepare('SELECT * FROM optimizer_runs ORDER BY id DESC LIMIT ?').all(limit).map(row => ({
    ...row,
    changes: row.changes ? JSON.parse(row.changes) : null,
  }));
}

export function getEquityHistory(limit = 500) {
  if (!db) return [];
  return db.prepare('SELECT * FROM equity_snapshots ORDER BY id DESC LIMIT ?').all(limit);
}

export function closeDB() {
  if (db) {
    db.close();
    log.info('Database closed');
  }
}
