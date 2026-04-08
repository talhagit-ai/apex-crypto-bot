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
  CANDLE_INTERVAL, REGIME_INTERVAL, ENABLE_SHORTS, DRY_RUN_SHORTS,
} from './config.mjs';
import { initDB, closeDB, saveEquitySnapshot, getOptimizerHistory, saveEngineState, loadEngineState, saveFuturesReadiness, loadFuturesReadiness, getPerformanceMetrics } from './persistence.mjs';
import { log } from './logger.mjs';
import { TradingEngine } from './engine.mjs';
import { KrakenClient } from './kraken-client.mjs';
import { CandleBuffer } from './candle-buffer.mjs';
import { OrderManager } from './order-manager.mjs';
import { runOptimization, startOptimizationSchedule, loadParams, loadParamsSync } from './optimizer.mjs';
import { KrakenFuturesClient, FUTURES_SYMBOL } from './kraken-futures-client.mjs';
import { notifyBuy, notifyShort, notifySell, notifyPartial, notifyStartup, notifyError, notifyFuturesReady, startTelegramChat, handleWebhookUpdate } from './telegram.mjs';

// ── Bootstrap ─────────────────────────────────────────────────

const kraken  = new KrakenClient();
const futures = new KrakenFuturesClient();
const buffer  = new CandleBuffer(kraken);
const orders  = new OrderManager(kraken);

// Engine + DB initialized async in start()
let engine = new TradingEngine(CAPITAL, { overrideParams: loadParamsSync(), enableShorts: ENABLE_SHORTS });

let wsClients = new Set();
let tickCount  = 0;
let lastTick5  = {};  // assetId → timestamp of last 5m bar
let tickTimer  = null; // fires engine tick when not all assets close in time
let lastFallbackCheck = Date.now(); // for fallback tick timer

// Real Kraken balances (refreshed every 60s)
let realBalances = { spotEUR: null, futuresUSD: null, lastUpdated: null };

// Futures readiness tracking (persisted across restarts via DB)
let lastErrorTime        = null;   // timestamp of last real error (null = no errors)
let futuresReadyNotified = false;  // true once notification was sent
let firstStartTime       = null;   // when DRY_RUN_SHORTS first started

// Wrapper: track errors + notify Telegram + persist
function reportError(msg) {
  lastErrorTime = Date.now();
  notifyError(msg);
  if (DRY_RUN_SHORTS) {
    saveFuturesReadiness({ lastErrorTime, futuresReadyNotified, firstStartTime }).catch(() => {});
  }
}

// Kraken asset name → our asset id mapping
const KRAKEN_ASSET_MAP = {
  'XXBT': 'BTCUSDT', 'XBT': 'BTCUSDT',
  'XETH': 'ETHUSDT', 'ETH': 'ETHUSDT',
  'SOL':  'SOLUSDT', 'XXRP': 'XRPUSDT', 'XRP': 'XRPUSDT',
  'ADA':  'ADAUSDT', 'DOT': 'DOTUSD',   'LINK': 'LINKUSD',
  'AVAX': 'AVAXUSD', 'ATOM': 'ATOMUSD', 'UNI':  'UNIUSD',
  'XLTC': 'LTCUSD',  'LTC': 'LTCUSD',  'POL':  'POLUSD',
  'XXDG': 'DOGEUSD', 'DOGE': 'DOGEUSD', 'ALGO': 'ALGOUSD',
  'NEAR': 'NEARUSD', 'FIL':  'FILUSD',  'AAVE': 'AAVEUSD',
  'GRT':  'GRTUSD',  'SNX':  'SNXUSD',  'CRV':  'CRVUSD',
  'COMP': 'COMPUSD', 'ENJ':  'ENJUSD',  'FLOW': 'FLOWUSD',
  'KSM':  'KSMUSD',  'SAND': 'SANDUSD', 'MANA': 'MANAUSD',
  'AXS':  'AXSUSD',  '1INCH':'1INCHUSD','OCEAN':'OCEANUSD',
};

async function refreshBalances() {
  try {
    const raw = await kraken.api.balance();
    const usdCash = parseFloat(raw?.ZUSD || raw?.USD || 0);
    const eurCash = parseFloat(raw?.ZEUR || raw?.EUR || 0);

    // Fetch EUR/USD rate to convert EUR to USD
    let eurUsdRate = 1.09; // fallback
    try {
      const eurTicker = await kraken.api.ticker({ pair: 'EURUSD' });
      const key = Object.keys(eurTicker)[0];
      eurUsdRate = parseFloat(eurTicker[key]?.c?.[0] || 1.09);
    } catch (_) {}

    const eurInUsd = eurCash * eurUsdRate;
    const totalCashUSD = usdCash + eurInUsd;

    // Calculate value of all held coins
    const prices = buffer.currentPrices();
    let holdingsValue = 0;
    const holdings = {};

    for (const [krakenAsset, amtStr] of Object.entries(raw)) {
      if (krakenAsset === 'ZUSD' || krakenAsset === 'ZEUR' || krakenAsset === 'USD' || krakenAsset === 'EUR') continue;
      const amt = parseFloat(amtStr);
      if (amt < 0.0001) continue;

      const assetId = KRAKEN_ASSET_MAP[krakenAsset];
      if (!assetId) continue;

      const price = prices[assetId];
      if (!price) continue;

      const value = amt * price;
      holdingsValue += value;
      holdings[assetId] = { qty: +amt.toFixed(6), price, value: +value.toFixed(2) };
    }

    const totalUSD = totalCashUSD + holdingsValue;
    realBalances.spotUSD      = totalUSD;
    realBalances.spotCash     = totalCashUSD;
    realBalances.eurCash      = eurCash;
    realBalances.holdings     = holdings;
    realBalances.spotCurrency = 'USD';

    log.info(`Portfolio: $${totalUSD.toFixed(2)} (USD cash $${usdCash.toFixed(2)} + EUR cash €${eurCash.toFixed(2)} + coins $${holdingsValue.toFixed(2)})`);

    // Sync engine capital with real total portfolio value
    if (totalUSD > 0) {
      engine.capital                = totalUSD;
      engine.riskState.startCapital = totalUSD;
    }
  } catch (e) {
    log.warn('Could not fetch spot balance', { err: e.message });
  }
  try {
    const futuresUSD = await futures.getBalance();
    realBalances.futuresUSD = futuresUSD;
    log.info(`Futures balance: $${futuresUSD.toFixed(2)}`);
  } catch (e) {
    log.warn('Futures balance error', { err: e.message });
    realBalances.futuresError = e.message;
  }
  realBalances.lastUpdated = Date.now();
}

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
    params: engine?.opts?.overrideParams?._meta || null,
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

// Helper: merge real balances into engine state
function getFullState(prices) {
  return { ...engine.getState(prices), realBalances, prices };
}

// REST: get current state
app.get('/state', (_req, res) => {
  res.json(getFullState(buffer.currentPrices()));
});

// REST: get recent trades
app.get('/trades', (_req, res) => {
  res.json(engine.trades.slice(-200));
});

// POST /api/test-spot — place a tiny real spot buy to verify orders work
app.post('/api/test-spot', async (_req, res) => {
  try {
    // Buy minimum DOGE (~$0.50 worth)
    const ticker = await kraken.getTicker('DOGEUSD');
    const price  = ticker.askPrice;
    const qty    = Math.ceil(6 / price); // ~6 DOGE ≈ $0.50
    const result = await kraken.placeOrder({ symbol: 'DOGEUSD', side: 'Buy', qty });
    res.json({ ok: true, msg: `Test buy: ${qty} DOGE @ $${price}`, result });
  } catch (e) {
    res.json({ ok: false, err: e.message });
  }
});

// POST /api/test-futures — place a tiny futures short to verify futures work
app.post('/api/test-futures', async (_req, res) => {
  try {
    // Smallest possible BTC futures contract = 1 contract ($1 notional)
    const result = await futures.openShort('BTCUSDT', 1);
    res.json({ ok: true, msg: 'Test futures short: 1 BTC contract', result });
  } catch (e) {
    res.json({ ok: false, err: e.message });
  }
});

// Telegram webhook endpoint
app.post('/telegram-webhook', (req, res) => {
  res.sendStatus(200); // acknowledge immediately
  handleWebhookUpdate(req.body).catch(() => {});
});

// REST: performance dashboard
app.get('/api/performance', async (_req, res) => {
  try {
    const metrics = await getPerformanceMetrics();
    res.json(metrics);
  } catch (e) { res.json({ error: e.message }); }
});

// REST: debug balances
app.get('/api/balances', async (_req, res) => {
  await refreshBalances();
  try {
    const raw = await kraken.api.balance();
    // Also try raw futures accounts
    let rawFutures = null;
    let futuresErr = null;
    try {
      rawFutures = await futures._request('GET', '/accounts');
    } catch (e) {
      futuresErr = e.message;
    }
    res.json({
      realBalances, rawKraken: raw, rawFutures, futuresErr,
      futuresKeysLoaded: {
        hasKey:    !!process.env.KRAKEN_FUTURES_API_KEY,
        keyPrefix: (process.env.KRAKEN_FUTURES_API_KEY || '').slice(0, 6),
        hasSecret: !!process.env.KRAKEN_FUTURES_API_SECRET,
        secretLen: (process.env.KRAKEN_FUTURES_API_SECRET || '').length,
      },
    });
  } catch (e) {
    res.json({ realBalances, error: e.message });
  }
});

// POST /api/liquidate-dust — sell non-tracked coin holdings (FLOW, SNX, DOGE etc)
app.post('/api/liquidate-dust', async (_req, res) => {
  const LIQUIDATE_MAP = {
    'FLOW': { pair: 'FLOWUSD', minQty: 1 },
    'SNX':  { pair: 'SNXUSD',  minQty: 0.01 },
    'XXDG': { pair: 'XDGUSD',  minQty: 1 },
    'DOGE': { pair: 'XDGUSD',  minQty: 1 },
  };

  const results = [];
  try {
    const raw = await kraken.api.balance();
    for (const [krakenAsset, amtStr] of Object.entries(raw)) {
      if (krakenAsset === 'ZUSD' || krakenAsset === 'ZEUR') continue;
      const amt = parseFloat(amtStr);
      if (amt < 0.001) continue;
      const info = LIQUIDATE_MAP[krakenAsset];
      if (!info) continue;
      if (amt < info.minQty) { results.push({ asset: krakenAsset, qty: amt, ok: false, err: 'below minQty' }); continue; }
      try {
        const resp = await kraken.api.addOrder({ pair: info.pair, type: 'sell', ordertype: 'market', volume: String(amt) });
        const orderId = resp?.txid?.[0] || 'unknown';
        results.push({ asset: krakenAsset, qty: amt, pair: info.pair, orderId, ok: true });
        log.info(`Liquidated dust: ${amt} ${krakenAsset} via ${info.pair}`, { orderId });
      } catch (e) {
        results.push({ asset: krakenAsset, qty: amt, ok: false, err: e.message });
        log.warn(`Failed to liquidate ${krakenAsset}`, { err: e.message });
      }
    }
    setTimeout(() => refreshBalances(), 4000);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, err: e.message });
  }
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
app.get('/optimizer/history', async (_req, res) => {
  res.json(await getOptimizerHistory(20));
});

// GET current active params
app.get('/optimizer/params', (_req, res) => {
  res.json(loadParams());
});

// POST /api/reset — reset kill switch and sync to real balance
app.post('/api/reset', async (_req, res) => {
  await refreshBalances();
  const bal = realBalances.spotUSD || 100;
  engine.riskState.killed = false;
  engine.riskState.dailyLoss = 0;
  engine.riskState.weeklyLoss = 0;
  engine.riskState.riskReduction = 1.0;
  engine.riskState.startCapital = bal;
  engine.riskState.consecutiveLosses = {};
  engine.riskState.totalConsecutiveLosses = 0;
  engine.capital = bal;
  engine.cash = bal;
  engine.positions = {};
  engine.trades = [];
  log.info(`Kill switch reset — capital synced to $${bal.toFixed(2)}`);
  notifyStartup(bal, ASSETS.length);
  res.json({ ok: true, capital: bal, msg: 'Kill switch reset, engine restarted' });
});

// ── WebSocket ─────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  wsClients.add(ws);
  log.info(`WS client connected (${wsClients.size} total)`);

  // Send current state immediately on connect
  ws.send(JSON.stringify({ type: 'state', data: getFullState(buffer.currentPrices()) }));

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

  // Fire immediately if 75%+ of assets reported within 30s window
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const threshold = Math.ceil(ASSETS.length * 0.75);
  if (timestamps.length >= threshold && maxTs - minTs <= 30_000) {
    clearTimeout(tickTimer);
    tickTimer = null;
    lastTick5 = {};
    runEngineTick();
    return;
  }

  // Fallback: 30s after first bar close (handles illiquid assets)
  if (!tickTimer) {
    tickTimer = setTimeout(() => {
      tickTimer = null;
      lastTick5 = {};
      runEngineTick();
    }, 30_000);
  }
}

async function runEngineTick() {
  if (!buffer.ready) {
    log.warn('Engine tick skipped: buffer not ready');
    return;
  }
  tickCount++;
  lastFallbackCheck = Date.now();

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
  const prevQtySnapshot = {};
  for (const [id, p] of Object.entries(engine.positions)) {
    prevQtySnapshot[id] = p.qty;
  }

  // Run engine logic (signal gen, position management)
  const isDryRun = process.env.DRY_RUN === 'true';
  engine.tick(barData, regimeData);

  // Detect changes and place real orders (or log in DRY_RUN mode)
  await _syncOrders(prevPositions, prevQtySnapshot, barData, isDryRun);

  // Refresh real Kraken balances every tick
  await refreshBalances();

  // Broadcast updated state
  const prices = buffer.currentPrices();
  const state  = getFullState(prices);
  broadcast('state', state);

  // Save equity snapshot + check futures readiness every 12 ticks (= 1 hour)
  if (tickCount % 12 === 0) {
    const unrealized = state.equity - state.cash;
    saveEquitySnapshot(state.equity, state.cash, unrealized).catch(() => {});
    checkFuturesReadiness();
  }

  // Save engine state after every tick (survive restarts)
  saveEngineState({
    positions: engine.positions,
    cash:      engine.cash,
    riskState: engine.riskState,
  }).catch(() => {});

  log.info(`Tick #${tickCount}`, {
    positions: Object.keys(engine.positions).length,
    equity: state.equity,
    cash: state.cash,
  });
}

/**
 * Detect engine decisions and execute real orders on Kraken.
 * Handles: new entries, partial exits, full exits, order failure rollback.
 */
async function _syncOrders(prevPositions, prevQtySnapshot, barData, isDryRun) {
  const isDryRunShorts = DRY_RUN_SHORTS && !isDryRun; // paper-trade shorts only
  const currentPositions = new Set(Object.keys(engine.positions));

  // ── 1. New Entries ─────────────────────────────────────────────
  for (const assetId of currentPositions) {
    if (prevPositions.has(assetId)) continue;
    const pos = engine.positions[assetId];
    if (!pos || !barData[assetId]) continue;

    // Pre-flight balance check: ensure real funds available
    const cost = pos.qty * pos.entry;
    if (pos.side !== 'short' && realBalances.spotCash !== undefined && realBalances.spotCash < cost * 0.5) {
      log.warn(`SKIP ${assetId}: insufficient spot cash ($${realBalances.spotCash?.toFixed(2)} < $${(cost*0.5).toFixed(2)})`);
      _rollbackPosition(assetId, pos);
      continue;
    }

    if (isDryRun) {
      log.signal(`DRY RUN: ${pos.side === 'short' ? 'SHORT' : 'BUY'} ${assetId}`, { qty: pos.qty, entry: pos.entry });
      notifyBuy(assetId, pos.qty, pos.entry, pos.sl, pos.tp, 0); // notify even in dry run
      continue;
    }

    // DRY_RUN_SHORTS: log short signal but remove phantom position from engine
    if (isDryRunShorts && pos.side === 'short') {
      log.signal(`DRY RUN SHORT: ${assetId}`, { qty: pos.qty, entry: pos.entry, sl: pos.sl, tp: pos.tp });
      notifyShort(assetId, pos.qty, pos.entry, pos.sl, pos.tp, pos.conf || 3);
      _rollbackPosition(assetId, pos);
      continue;
    }

    // Safety: never execute shorts when ENABLE_SHORTS is off
    if (pos.side === 'short' && !ENABLE_SHORTS) {
      log.error(`CRITICAL: SHORT ${assetId} created when shorts disabled — rolling back`);
      _rollbackPosition(assetId, pos);
      reportError(`SHORT ${assetId} aangemaakt terwijl shorts uitgeschakeld`);
      continue;
    }

    if (pos.side === 'short') {
      // Pre-flight: check futures margin
      const marginNeeded = pos.qty * pos.entry * 0.10;
      if (realBalances.futuresUSD !== null && realBalances.futuresUSD < marginNeeded * 1.2) {
        log.warn(`SKIP SHORT ${assetId}: insufficient futures margin ($${realBalances.futuresUSD?.toFixed(2)} < $${(marginNeeded*1.2).toFixed(2)})`);
        _rollbackPosition(assetId, pos);
        reportError(`SHORT ${assetId} overgeslagen: onvoldoende futures marge`);
        continue;
      }
      // Pre-flight: check futures symbol exists
      if (!futures.hasFuturesSymbol(assetId)) {
        log.warn(`SKIP SHORT ${assetId}: no futures symbol mapping`);
        _rollbackPosition(assetId, pos);
        continue;
      }
      log.signal(`REAL ORDER: SHORT ${assetId}`, { qty: pos.qty, entry: pos.entry });
      try {
        const fill = await futures.openShort(assetId, pos.qty);
        if (fill?.fillPrice) { pos.entry = fill.fillPrice; pos.peak = fill.fillPrice; }
        notifyShort(assetId, pos.qty, pos.entry, pos.sl, pos.tp, pos.conf || 3);
      } catch (err) {
        log.error(`Futures short FAILED — rolling back ${assetId}`, { err: err.message });
        _rollbackPosition(assetId, pos);
        reportError(`SHORT ${assetId} gefaald: ${err.message}`);
      }
    } else {
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
      } else {
        log.error(`Spot BUY FAILED — rolling back ${assetId}`);
        _rollbackPosition(assetId, pos);
        reportError(`BUY ${assetId} gefaald — positie teruggedraaid`);
      }
    }
  }

  // ── 2. Partial Exits (position still exists but qty decreased) ─
  for (const assetId of currentPositions) {
    if (!prevPositions.has(assetId)) continue; // new entry, not partial
    const prevQty    = prevQtySnapshot[assetId] || 0;
    const currentQty = engine.positions[assetId]?.qty || 0;
    if (currentQty >= prevQty) continue; // no partial taken

    const partialQty = prevQty - currentQty;
    const pos = engine.positions[assetId];
    if (!pos) continue; // Position was fully closed in same tick; handled in section 3
    const price = barData[assetId]?.closes?.slice(-1)[0] || pos.entry;

    log.signal(`REAL ORDER: PARTIAL SELL ${assetId}`, { qty: partialQty, price });

    if (!isDryRun) {
      if (pos.side === 'short') {
        if (!isDryRunShorts) {
          try {
            await futures.closeShort(assetId, partialQty);
          } catch (err) {
            log.error(`Futures partial cover failed for ${assetId}`, { err: err.message });
          }
        } else {
          log.signal(`DRY RUN SHORT PARTIAL: ${assetId}`, { qty: partialQty, price });
        }
      } else {
        await orders.closePosition(assetId, partialQty, price, 'PARTIAL');
      }
    }

    // Determine which partial
    const partialNum = pos.partial2Taken ? 2 : pos.partial1Taken ? 1 : 0;
    if (partialNum > 0) {
      notifyPartial(assetId, partialNum, price, 0);
    }
  }

  // ── 3. Full Exits (position gone from engine) ─────────────────
  for (const assetId of prevPositions) {
    if (currentPositions.has(assetId)) continue;

    const exitTrade = engine.trades
      .filter(t => t.id === assetId && ['SELL', 'COVER'].includes(t.side))
      .slice(-1)[0];
    if (!exitTrade) continue;

    const closeQty = exitTrade.qty;
    const reason   = exitTrade.reason || 'EXIT';

    if (isDryRun) {
      log.signal(`DRY RUN: ${exitTrade.side} ${assetId}`, { qty: closeQty, reason });
      continue;
    }

    if (exitTrade.side === 'COVER') {
      if (isDryRunShorts) {
        log.signal(`DRY RUN SHORT EXIT: ${assetId}`, { qty: closeQty, reason, pnl: exitTrade.pnl });
        notifySell(assetId, closeQty, exitTrade.price, exitTrade.pnl || 0, `DRY ${reason}`);
      } else {
        log.signal(`REAL ORDER: COVER ${assetId}`, { qty: closeQty, reason });
        try {
          await futures.closeShort(assetId, closeQty);
          notifySell(assetId, closeQty, exitTrade.price, exitTrade.pnl || 0, reason);
        } catch (err) {
          log.error(`Futures cover failed for ${assetId}`, { err: err.message });
          reportError(`COVER ${assetId} gefaald: ${err.message}`);
        }
      }
    } else {
      log.signal(`REAL ORDER: SELL ${assetId}`, { qty: closeQty, reason });
      const result = await orders.closePosition(assetId, closeQty, exitTrade.price, reason);
      notifySell(assetId, closeQty, exitTrade.price, result?.pnl || exitTrade.pnl || 0, reason);
    }
  }
}

/**
 * Check if DRY_RUN_SHORTS has produced enough validated data to go live.
 * Sends one Telegram message when all criteria are met; never sends again.
 */
function checkFuturesReadiness() {
  if (!DRY_RUN_SHORTS || futuresReadyNotified) return;

  // Count paper short entries and exits in engine trade history
  const shortEntries = engine.trades.filter(t => t.side === 'SHORT');
  const shortExits   = engine.trades.filter(t => t.side === 'COVER');
  const wins         = shortExits.filter(t => t.win);

  const signalCount = shortEntries.length;
  const exitCount   = shortExits.length;
  const winRate     = exitCount >= 5 ? (wins.length / exitCount) * 100 : 0;

  // 7 error-free days measured from firstStartTime (persists across restarts)
  const startRef      = firstStartTime || Date.now();
  const errorFreeDays = lastErrorTime === null
    ? (Date.now() - startRef) / (24 * 60 * 60 * 1000)
    : (Date.now() - lastErrorTime) / (24 * 60 * 60 * 1000);
  const noRecentErrors = errorFreeDays >= 7;

  log.info('Futures readiness check', {
    signals: signalCount, exits: exitCount, winRate: +winRate.toFixed(1),
    errorFreeDays: +errorFreeDays.toFixed(1), noRecentErrors,
  });

  if (signalCount >= 50 && winRate >= 40 && exitCount >= 10 && noRecentErrors) {
    futuresReadyNotified = true;
    notifyFuturesReady({ signalCount, winRate, exitCount });
    saveFuturesReadiness({ lastErrorTime, futuresReadyNotified: true, firstStartTime }).catch(() => {});
    log.info('FUTURES READINESS CRITERIA MET — notification sent');
  }
}

/** Reconcile engine positions vs real Kraken holdings every 5 minutes */
async function reconcilePositions() {
  try {
    // ── Spot reconciliation ──
    const raw = await kraken.api.balance();
    const krakenHoldings = {};
    for (const [k, v] of Object.entries(raw)) {
      const amt = parseFloat(v);
      if (amt > 0.0001 && k !== 'ZUSD' && k !== 'ZEUR') {
        const mapped = KRAKEN_ASSET_MAP[k];
        if (mapped) krakenHoldings[mapped] = amt;
      }
    }

    for (const [assetId, pos] of Object.entries(engine.positions)) {
      if (pos.side === 'short') continue;
      if (!krakenHoldings[assetId] || krakenHoldings[assetId] < pos.qty * 0.5) {
        log.warn(`RECONCILE: Engine has LONG ${assetId} (${pos.qty}) but Kraken has ${krakenHoldings[assetId] || 0} — removing phantom`);
        _rollbackPosition(assetId, pos);
        reportError(`Phantom LONG ${assetId} verwijderd (niet op Kraken)`);
      }
    }

    // ── Futures reconciliation ──
    if (ENABLE_SHORTS && futures.enabled) {
      try {
        const openFutures = await futures.getPositions();
        const futuresMap = {};
        for (const fp of openFutures) {
          const assetId = Object.entries(FUTURES_SYMBOL)
            .find(([, sym]) => sym === fp.symbol)?.[0];
          if (assetId) futuresMap[assetId] = fp;
        }

        // Detect phantom shorts (in engine but not on Kraken)
        for (const [assetId, pos] of Object.entries(engine.positions)) {
          if (pos.side !== 'short') continue;
          if (!futuresMap[assetId]) {
            log.warn(`RECONCILE: Engine has SHORT ${assetId} but Kraken Futures has no position — removing phantom`);
            _rollbackPosition(assetId, pos);
            reportError(`Phantom SHORT ${assetId} verwijderd (niet op Kraken Futures)`);
          }
        }

        // Detect orphaned futures (on Kraken but not in engine)
        for (const [assetId, fp] of Object.entries(futuresMap)) {
          if (!engine.positions[assetId]) {
            log.warn(`RECONCILE: Kraken Futures has ${assetId} position but engine doesn't — orphan`);
            reportError(`Wees-positie op Kraken Futures: ${assetId}. Handmatig sluiten!`);
          }
        }
      } catch (e) {
        log.warn('Futures reconciliation failed', { err: e.message });
      }
    }
  } catch (e) {
    log.warn('Reconciliation failed', { err: e.message });
  }
}

/** Rollback engine position when real order fails */
function _rollbackPosition(assetId, pos) {
  if (pos.side === 'short') {
    engine.cash += pos.margin || 0;
  } else {
    engine.cash += pos.qty * pos.entry;
  }
  delete engine.positions[assetId];
  log.warn(`Rolled back engine position for ${assetId}`);
}

// ── Startup ───────────────────────────────────────────────────

async function start() {
  log.info('═══════════════════════════════════════════════════════════');
  log.info('  APEX CRYPTO V2 — STARTING (Kraken)');
  log.info(`  Capital: $${CAPITAL} | Assets: ${ASSETS.map(a => a.id).join(', ')}`);
  log.info(`  Shorts: ${ENABLE_SHORTS ? 'ENABLED (Kraken Futures)' : 'DISABLED (spot only)'}`);
  log.info('═══════════════════════════════════════════════════════════');

  // 0. Initialize database (Turso or local SQLite)
  await initDB();

  // Load optimizer params from DB (overrides defaults)
  const savedParams = await loadParams();
  if (savedParams._meta) {
    engine = new TradingEngine(CAPITAL, { overrideParams: savedParams, enableShorts: ENABLE_SHORTS });
    log.info('Loaded optimizer params from DB', savedParams._meta);
  }

  // Restore engine state if recent (< 30 min old)
  const savedState = await loadEngineState();
  if (savedState) {
    engine.positions = savedState.positions || {};
    engine.cash      = savedState.cash      ?? engine.cash;
    engine.riskState = { ...engine.riskState, ...savedState.riskState };
    log.info(`Engine state restored: ${Object.keys(engine.positions).length} positions, cash $${engine.cash?.toFixed(2)}`);
  }

  // Restore futures readiness state across restarts
  if (DRY_RUN_SHORTS) {
    const fr = await loadFuturesReadiness();
    if (fr) {
      lastErrorTime        = fr.lastErrorTime        ?? null;
      futuresReadyNotified = fr.futuresReadyNotified ?? false;
      firstStartTime       = fr.firstStartTime       ?? Date.now();
      log.info('Futures readiness state restored', { lastErrorTime, futuresReadyNotified, firstStartTime });
    } else {
      firstStartTime = Date.now();
      await saveFuturesReadiness({ lastErrorTime: null, futuresReadyNotified: false, firstStartTime });
    }
  }

  // 1. Fetch real Kraken balances
  await refreshBalances();
  if (realBalances.spotUSD > 0) {
    log.info(`Real Kraken balance: total $${realBalances.spotUSD.toFixed(2)}, cash $${(realBalances.spotCash || 0).toFixed(2)}`);
    // Capital = total portfolio value (for equity display / risk state)
    // Cash = only available cash (for position sizing / order placement)
    engine.capital = realBalances.spotUSD;
    engine.cash    = realBalances.spotCash || realBalances.spotUSD;
  }
  if (realBalances.futuresUSD !== null) {
    log.info(`Real Kraken futures balance: $${realBalances.futuresUSD.toFixed(2)} USD`);
  }

  // Refresh balances every 60 seconds
  setInterval(refreshBalances, 60_000);

  // Reconcile engine positions vs Kraken every 5 minutes
  setInterval(reconcilePositions, 5 * 60_000);

  // 2. Fetch historical data
  await buffer.init();

  // 3. Connect Kraken WebSocket streams
  kraken.connectWebSocket(onBarClose);

  // Fallback: if no tick in 6+ minutes, force tick from buffer data
  setInterval(() => {
    const elapsed = Date.now() - lastFallbackCheck;
    if (elapsed > 6 * 60 * 1000 && buffer.ready && tickCount > 0) {
      log.warn('No tick in 6 minutes — forcing engine tick');
      lastFallbackCheck = Date.now();
      runEngineTick();
    }
  }, 60_000);

  // 4. Start weekly optimizer schedule
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

  // Start Telegram AI chat (webhook mode — no polling conflicts)
  const publicUrl = process.env.PUBLIC_URL || `https://apex-crypto-bot-c3bt.onrender.com`;
  await startTelegramChat(() => getFullState(buffer.currentPrices()), publicUrl);
}

// ── Graceful Shutdown ─────────────────────────────────────────

async function shutdown(signal) {
  log.info(`Received ${signal} — shutting down gracefully`);

  for (const ws of wsClients) ws.close();
  kraken.disconnect();

  http.close(async () => {
    log.info('HTTP server closed');
    // Save engine state before exit
    await saveEngineState({ positions: engine.positions, cash: engine.cash, riskState: engine.riskState }).catch(() => {});
    await closeDB();
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
