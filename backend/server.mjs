// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Server
//  Express REST + WebSocket (live state to frontend)
//  Orchestrates: KrakenClient → CandleBuffer → Engine → OrderManager
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  ASSETS, CAPITAL, SERVER_PORT,
  CANDLE_INTERVAL, REGIME_INTERVAL, ENABLE_SHORTS,
} from './config.mjs';
import { initDB, closeDB, saveEquitySnapshot, getOptimizerHistory } from './persistence.mjs';
import { log } from './logger.mjs';
import { TradingEngine } from './engine.mjs';
import { KrakenClient } from './kraken-client.mjs';
import { CandleBuffer } from './candle-buffer.mjs';
import { OrderManager } from './order-manager.mjs';
import { runOptimization, startOptimizationSchedule, loadParams } from './optimizer.mjs';
import { KrakenFuturesClient } from './kraken-futures-client.mjs';
import { notifyBuy, notifyShort, notifySell, notifyPartial, notifyStartup } from './telegram.mjs';

// ── Bootstrap ─────────────────────────────────────────────────

const db     = initDB();
const kraken = new KrakenClient();

// Load optimizer params on startup (falls back to defaults)
const liveParams = loadParams();
log.info('Loaded params', { source: liveParams._meta ? 'params.json' : 'defaults' });

const futures = new KrakenFuturesClient();
const buffer  = new CandleBuffer(kraken);
const engine  = new TradingEngine(CAPITAL, { overrideParams: liveParams, enableShorts: ENABLE_SHORTS });
const orders  = new OrderManager(kraken);

let wsClients = new Set();
let tickCount  = 0;
let lastTick5  = {};  // assetId → timestamp of last 5m bar
let tickTimer  = null; // fires engine tick when not all assets close in time

// ── Express ───────────────────────────────────────────────────

const app  = express();
const http = createServer(app);
const wss  = new WebSocketServer({ server: http });

app.use(express.json());

// Serve built frontend in production
const __dirname = dirname(fileURLToPath(import.meta.url));
const frontendDist = join(__dirname, '../frontend/dist');
app.use(express.static(frontendDist));

// Health check
app.get('/health', (_req, res) => {
  const prices = buffer.currentPrices();
  res.json({
    status: 'ok',
    exchange: 'kraken',
    assets: ASSETS.map(a => a.id),
    prices,
    uptime: process.uptime(),
    tickCount,
    params: liveParams._meta || null,
  });
});

// REST: test Kraken API connectivity + balance
app.get('/api/test', async (_req, res) => {
  const results = {};
  try {
    const ticker = await kraken.getTicker('BTCUSDT');
    results.ticker = { ok: true, btcAsk: ticker.askPrice };
  } catch (e) {
    results.ticker = { ok: false, err: e.message };
  }
  try {
    const bal = await kraken.api.balance();
    const eurBal = bal?.ZEUR ?? bal?.EUR ?? '?';
    results.balance = { ok: true, EUR: eurBal };
  } catch (e) {
    results.balance = { ok: false, err: e.message };
  }
  results.enableShorts = ENABLE_SHORTS;
  results.tickCount = tickCount;
  res.json(results);
});

// REST: get current state
app.get('/state', (_req, res) => {
  const prices = buffer.currentPrices();
  res.json(engine.getState(prices));
});

// REST: get recent trades
app.get('/trades', (_req, res) => {
  res.json(engine.trades.slice(-200));
});

// ── Optimizer Endpoints ──────────────────────────────────────

// Manual trigger: POST /optimize
app.post('/optimize', async (_req, res) => {
  log.info('Manual optimization triggered via REST');
  try {
    const result = await runOptimization();
    res.json(result);
  } catch (err) {
    log.error('Optimization error', { err: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET history of past optimizer runs
app.get('/optimizer/history', (_req, res) => {
  res.json(getOptimizerHistory(20));
});

// GET current active params
app.get('/optimizer/params', (_req, res) => {
  res.json(loadParams());
});

// ── WebSocket ─────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  log.info(`WS client connected (${wsClients.size} total)`);

  // Send current state immediately on connect
  const prices = buffer.currentPrices();
  ws.send(JSON.stringify({ type: 'state', data: engine.getState(prices) }));

  ws.on('close', () => {
    wsClients.delete(ws);
    log.info(`WS client disconnected (${wsClients.size} remaining)`);
  });

  ws.on('error', (err) => log.warn('WS client error', { err: err.message }));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  for (const ws of wsClients) {
    if (ws.readyState === 1) { // OPEN
      ws.send(msg);
    }
  }
}

// ── Engine Tick ───────────────────────────────────────────────

/**
 * Called when a bar closes for any asset.
 * We wait until ALL assets have updated before running the engine tick.
 */
function onBarClose(assetId, interval, candle) {
  buffer.update(assetId, interval, candle);

  if (interval !== CANDLE_INTERVAL) return; // only tick on 5m close

  lastTick5[assetId] = candle.timestamp;

  const timestamps = Object.values(lastTick5);

  // If all assets reported, run immediately if within 90s window
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  if (timestamps.length >= ASSETS.length && maxTs - minTs <= 90_000) {
    clearTimeout(tickTimer);
    tickTimer = null;
    lastTick5 = {};
    runEngineTick();
    return;
  }

  // Otherwise schedule a tick 90s after the first bar close this round
  // (handles illiquid assets that never close)
  if (!tickTimer) {
    tickTimer = setTimeout(() => {
      tickTimer = null;
      lastTick5 = {};
      runEngineTick();
    }, 90_000);
  }
}

async function runEngineTick() {
  tickCount++;

  // Build barData (5m) and regimeData (1h) from buffer
  const barData    = {};
  const regimeData = {};

  for (const asset of ASSETS) {
    const d5m = buffer.get(asset.id, CANDLE_INTERVAL);
    const d1h  = buffer.get(asset.id, REGIME_INTERVAL);
    if (!d5m) continue;
    barData[asset.id]    = d5m;
    regimeData[asset.id] = d1h || d5m; // fallback to 5m if 1h not ready
  }

  // Snapshot state BEFORE tick to detect new entries/exits
  const prevPositions = new Set(Object.keys(engine.positions));

  // Run engine logic (signal gen, position management)
  engine.tick(barData, regimeData);

  // Detect changes and place real orders
  await _syncOrders(prevPositions, barData);

  // Broadcast updated state
  const prices = buffer.currentPrices();
  const state  = engine.getState(prices);
  broadcast('state', state);

  // Save equity snapshot every 12 ticks (= 1 hour)
  if (tickCount % 12 === 0) {
    const unrealized = state.equity - state.cash;
    saveEquitySnapshot(state.equity, state.cash, unrealized);
  }

  log.info(`Tick #${tickCount}`, {
    positions: Object.keys(engine.positions).length,
    equity: state.equity,
    cash: state.cash,
  });
}

/**
 * Detect engine decisions and execute real orders on Kraken
 */
async function _syncOrders(prevPositions, barData) {
  const currentPositions = new Set(Object.keys(engine.positions));

  // New entries: in current but not in prev
  for (const assetId of currentPositions) {
    if (!prevPositions.has(assetId)) {
      const pos = engine.positions[assetId];
      const d   = barData[assetId];
      if (!d) continue;

      if (pos.side === 'short') {
        // SHORT — place futures order
        log.signal(`REAL ORDER: SHORT ${assetId}`, { qty: pos.qty, entry: pos.entry });
        try {
          await futures.openShort(assetId, pos.qty);
          notifyShort(assetId, pos.qty, pos.entry, pos.sl, pos.tp, pos.conf || 3);
        } catch (err) {
          log.error(`Futures short failed for ${assetId}`, { err: err.message });
        }
      } else {
        // LONG — place spot buy order
        log.signal(`REAL ORDER: BUY ${assetId}`, { qty: pos.qty, entry: pos.entry });
        const signal = {
          asset: assetId, price: pos.entry, sl: pos.sl, tp: pos.tp, conf: 5,
          rr: (pos.tp - pos.entry) / Math.max(pos.entry - pos.sl, 1e-9),
        };
        const fill = await orders.openPosition(signal, pos.qty);
        if (fill) {
          pos.entry = fill.fillPrice;
          pos.peak = fill.fillPrice;
          notifyBuy(assetId, pos.qty, fill.fillPrice, pos.sl, pos.tp, signal.conf || 3);
        }
      }
    }
  }

  // Exits: in prev but not in current (engine closed it)
  for (const assetId of prevPositions) {
    if (!currentPositions.has(assetId)) {
      const exitTrade = engine.trades
        .filter(t => t.id === assetId && ['SELL','COVER','PARTIAL1','PARTIAL2'].includes(t.side))
        .slice(-1)[0];

      if (exitTrade) {
        const closeQty = exitTrade.qty;
        const reason   = exitTrade.reason || 'EXIT';

        if (exitTrade.side === 'COVER') {
          log.signal(`REAL ORDER: COVER ${assetId}`, { qty: closeQty, reason });
          try {
            await futures.closeShort(assetId, closeQty);
            notifySell(assetId, closeQty, exitTrade.price, exitTrade.pnl || 0, reason);
          } catch (err) {
            log.error(`Futures cover failed for ${assetId}`, { err: err.message });
          }
        } else if (exitTrade.side === 'PARTIAL1') {
          notifyPartial(assetId, 1, exitTrade.price, exitTrade.pnl || 0);
          await orders.closePosition(assetId, closeQty, exitTrade.price, reason);
        } else if (exitTrade.side === 'PARTIAL2') {
          notifyPartial(assetId, 2, exitTrade.price, exitTrade.pnl || 0);
          await orders.closePosition(assetId, closeQty, exitTrade.price, reason);
        } else {
          log.signal(`REAL ORDER: SELL ${assetId}`, { qty: closeQty, reason });
          const result = await orders.closePosition(assetId, closeQty, exitTrade.price, reason);
          notifySell(assetId, closeQty, exitTrade.price, result?.pnl || exitTrade.pnl || 0, reason);
        }
      }
    }
  }
}

// ── Startup ───────────────────────────────────────────────────

async function start() {
  log.info('═══════════════════════════════════════════════════════════');
  log.info('  APEX CRYPTO V2 — STARTING (Kraken)');
  log.info(`  Capital: €${CAPITAL} | Assets: ${ASSETS.map(a => a.id).join(', ')}`);
  log.info(`  Shorts: ${ENABLE_SHORTS ? 'ENABLED (Kraken Futures)' : 'DISABLED (spot only)'}`);
  log.info('═══════════════════════════════════════════════════════════');

  // 1. Fetch historical data
  await buffer.init();

  // 2. Connect Kraken WebSocket streams
  kraken.connectWebSocket(onBarClose);

  // 3. Start weekly optimizer schedule
  startOptimizationSchedule();

  // Broadcast live prices every 30 seconds
  setInterval(() => {
    const prices = buffer.currentPrices();
    if (Object.keys(prices).length > 0) {
      broadcast('prices', prices);
    }
  }, 30_000);

  // Fallback: serve frontend for any non-API route
  app.get('*', (_req, res) => res.sendFile(join(frontendDist, 'index.html')));

  // 4. Start HTTP server
  http.listen(SERVER_PORT, () => {
    log.info(`Server listening on http://localhost:${SERVER_PORT}`);
    log.info(`WebSocket on ws://localhost:${SERVER_PORT}`);
    log.info(`Optimizer: POST /optimize to run manually`);
  });

  log.info('Bot is running. Waiting for bar closes...');
  notifyStartup(CAPITAL, ASSETS.length);
}

// ── Graceful Shutdown ─────────────────────────────────────────

async function shutdown(signal) {
  log.info(`Received ${signal} — shutting down gracefully`);

  for (const ws of wsClients) ws.close();
  kraken.disconnect();

  http.close(() => {
    log.info('HTTP server closed');
    closeDB();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { reason: String(reason) });
});

// ── Launch ────────────────────────────────────────────────────
start().catch((err) => {
  log.error('Fatal startup error', { err: err.message });
  process.exit(1);
});
