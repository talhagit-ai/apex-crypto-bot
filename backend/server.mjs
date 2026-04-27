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
import { readFileSync } from 'fs';
import {
  ASSETS, CAPITAL, SERVER_PORT,
  CANDLE_INTERVAL, TF15_INTERVAL, REGIME_INTERVAL, ENABLE_SHORTS, DRY_RUN_SHORTS,
  GROWTH_MODE,
} from './config.mjs';
import { initDB, closeDB, saveEquitySnapshot, getOptimizerHistory, saveEngineState, loadEngineState, saveFuturesReadiness, loadFuturesReadiness, getPerformanceMetrics, saveState } from './persistence.mjs';
import { log } from './logger.mjs';
import { TradingEngine } from './engine.mjs';
import { KrakenClient } from './kraken-client.mjs';
import { CandleBuffer } from './candle-buffer.mjs';
import { OrderManager } from './order-manager.mjs';
import { runOptimization, startOptimizationSchedule, loadParams, loadParamsSync } from './optimizer.mjs';
import { KrakenFuturesClient, FUTURES_SYMBOL } from './kraken-futures-client.mjs';
import { startFundingPoller, getFundingCache } from './funding-client.mjs';
import { startNewsPoller, isNewsPaused, newsRiskMult, getNewsState } from './news-client.mjs';
import { notifyBuy, notifyShort, notifySell, notifyPartial, notifyStartup, notifyError, notifyFuturesReady, startTelegramChat, handleWebhookUpdate } from './telegram.mjs';
import { LearningEngine } from './learning.mjs';

// ── Bootstrap ─────────────────────────────────────────────────

const kraken  = new KrakenClient();
const futures = new KrakenFuturesClient();
const buffer  = new CandleBuffer(kraken);
const orders  = new OrderManager(kraken);

// V34: load per-asset exit param overrides from cache/per-asset-params.json (sync at boot).
// Skip if stale (>14d old) — gegenereerd door hyperopt-per-asset op verouderde cache
// kan averechts werken in nieuw regime. Re-run hyperopt-per-asset op verse data
// om dit te activeren.
function loadPerAssetParamsSync() {
  try {
    const raw = readFileSync('./cache/per-asset-params.json', 'utf8');
    const parsed = JSON.parse(raw);
    const ageMs = Date.now() - (parsed.timestamp || 0);
    // V34: strenge 3d threshold — hyperopt op oudere cache kan averechts werken
    // bij regime-shift. Disable per-asset overrides als params >3d oud zijn.
    const STALE_MS = 3 * 24 * 60 * 60 * 1000;
    if (ageMs > STALE_MS) {
      log.warn(`per-asset-params.json is ${Math.round(ageMs / 86400000)}d oud — skip (run hyperopt-per-asset om te verversen)`);
      return {};
    }
    return parsed.finalParams || {};
  } catch (_) { return {}; }
}

// Engine + DB initialized async in start()
const learningEngine = new LearningEngine();
let engine = new TradingEngine(CAPITAL, {
  overrideParams: { ...loadParamsSync(), perAsset: loadPerAssetParamsSync() },
  enableShorts: ENABLE_SHORTS || DRY_RUN_SHORTS, growthMode: GROWTH_MODE, learningEngine,
});

let wsClients = new Set();
let tickCount  = 0;
let lastTick5  = {};  // assetId → timestamp of last 5m bar
let tickTimer  = null; // fires engine tick when not all assets close in time
let lastFallbackCheck = Date.now(); // for fallback tick timer

// Real Kraken balances (refreshed every 60s)
let realBalances = { spotEUR: null, spotCash: 0, spotUSD: 0, futuresUSD: null, lastUpdated: null };

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
  'ARB':  'ARBUSD',
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
      engine.capital = totalUSD;
      // startCapital is set once at startup — don't overwrite on periodic refreshes
      // or drawdown tracking becomes meaningless (baseline keeps moving).
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

// GET /api/futures-positions — list all open Kraken Futures positions
app.get('/api/futures-positions', async (_req, res) => {
  try {
    if (!futures.enabled) return res.json({ ok: false, err: 'Futures keys not configured' });
    const positions = await futures.getPositions();
    res.json({ ok: true, count: positions.length, positions });
  } catch (e) {
    res.json({ ok: false, err: e.message });
  }
});

// POST /api/futures-close-all — emergency close all open futures positions
app.post('/api/futures-close-all', async (_req, res) => {
  try {
    if (!futures.enabled) return res.json({ ok: false, err: 'Futures keys not configured' });
    const positions = await futures.getPositions();
    const results = [];
    for (const p of positions) {
      try {
        const symbol = p.symbol;
        const assetId = Object.entries(FUTURES_SYMBOL).find(([, sym]) => sym === symbol)?.[0];
        const qty = Math.abs(parseFloat(p.size));
        const side = p.side?.toLowerCase();
        const closeSide = side === 'short' ? 'buy' : 'sell';
        const data = await futures._request('POST', '/sendorder', {
          orderType: 'mkt', symbol, side: closeSide, size: String(qty),
        });
        results.push({ symbol, assetId, qty, closeSide, orderId: data.sendStatus?.order_id, status: data.sendStatus?.status });
      } catch (e) {
        results.push({ symbol: p.symbol, error: e.message });
      }
    }
    res.json({ ok: true, closed: results.length, results });
  } catch (e) {
    res.json({ ok: false, err: e.message });
  }
});

// Telegram webhook endpoint
app.post('/telegram-webhook', (req, res) => {
  res.sendStatus(200); // acknowledge immediately
  handleWebhookUpdate(req.body).catch(() => {});
});

// REST: performance dashboard + learning insights
app.get('/api/performance', async (_req, res) => {
  try {
    const metrics = await getPerformanceMetrics();
    const insights = learningEngine.getInsights();
    res.json({ ...metrics, learning: insights });
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

// POST /api/liquidate-orphans — sell ALL Kraken holdings not tracked by engine
// Frees up capital stranded from previous bot sessions or failed reconciliations
app.post('/api/liquidate-orphans', async (_req, res) => {
  const results = [];
  try {
    await refreshBalances();
    const raw = await kraken.api.balance();
    const prices = buffer.currentPrices();

    // Build lookup: assetId → krakenPair from ASSETS config
    const pairMap = {};
    for (const a of ASSETS) {
      if (a.krakenPair) pairMap[a.id] = a.krakenPair;
    }

    for (const [krakenAsset, amtStr] of Object.entries(raw)) {
      if (['ZUSD', 'ZEUR', 'USD', 'EUR'].includes(krakenAsset)) continue;
      const amt = parseFloat(amtStr);
      if (amt < 0.0001) continue;

      const assetId = KRAKEN_ASSET_MAP[krakenAsset];
      if (!assetId) {
        results.push({ krakenAsset, qty: amt, ok: false, reason: 'unknown asset' });
        continue;
      }

      // Skip if engine already tracks this position
      if (engine.positions[assetId]) {
        results.push({ asset: assetId, qty: amt, ok: false, reason: 'tracked by engine — skip' });
        continue;
      }

      const price = prices[assetId] || 0;
      const value = amt * price;
      if (value < 1) {
        results.push({ asset: assetId, qty: amt, value: +value.toFixed(4), ok: false, reason: 'dust (<$1)' });
        continue;
      }

      const pair = pairMap[assetId];
      if (!pair) {
        results.push({ asset: assetId, qty: amt, value: +value.toFixed(2), ok: false, reason: 'no krakenPair in config' });
        continue;
      }

      try {
        const resp = await kraken.api.addOrder({ pair, type: 'sell', ordertype: 'market', volume: String(amt) });
        const orderId = resp?.txid?.[0] || 'unknown';
        results.push({ asset: assetId, qty: amt, value: +value.toFixed(2), pair, orderId, ok: true });
        log.info(`Liquidated orphan: ${amt} ${assetId} (${pair}) $${value.toFixed(2)}`, { orderId });
      } catch (e) {
        results.push({ asset: assetId, qty: amt, value: +value.toFixed(2), pair, ok: false, err: e.message });
        log.warn(`Failed to liquidate orphan ${assetId}`, { err: e.message });
      }
    }

    setTimeout(() => refreshBalances(), 5000);
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ ok: false, err: e.message });
  }
});

// V29c: GET /api/risk-snapshot — full risk + state overview voor monitoring
app.get('/api/risk-snapshot', async (_req, res) => {
  try {
    const prices = buffer.currentPrices();
    const equity = engine.equity(prices);
    const startCap = engine.riskState.startCapital || engine.capital;
    const drawdownPct = startCap > 0 ? ((startCap - equity) / startCap) * 100 : 0;
    const exitedTrades = engine.trades.filter(t => ['SELL','COVER'].includes(t.side));
    const recent20 = exitedTrades.slice(-20);
    const wins20 = recent20.filter(t => (t.pnl || 0) > 0);
    const recentWR = recent20.length ? +(wins20.length / recent20.length * 100).toFixed(1) : 0;
    const recent20PnL = recent20.reduce((s,t) => s + (t.pnl || 0), 0);
    let availableMargin = null;
    try {
      if (futures.enabled) {
        const accounts = await futures._request('GET', '/accounts');
        availableMargin = accounts?.accounts?.flex?.availableMargin ?? null;
      }
    } catch (_) {}
    res.json({
      ok: true,
      timestamp: Date.now(),
      equity: +equity.toFixed(2),
      cash: +engine.cash.toFixed(2),
      startCapital: +startCap.toFixed(2),
      drawdownPct: +drawdownPct.toFixed(2),
      pnlTotal: +(equity - startCap).toFixed(2),
      positions: Object.entries(engine.positions).map(([id, p]) => ({
        id, side: p.side, qty: p.qty, entry: p.entry, sl: p.sl, tp: p.tp,
        peak: p.peak, partial1Done: p.partial1Done, partial2Done: p.partial2Done,
        paperOnly: p.paperOnly,
      })),
      risk: {
        dailyLoss: +(engine.riskState.dailyLoss * 100).toFixed(2),
        weeklyLoss: +(engine.riskState.weeklyLoss * 100).toFixed(2),
        riskReduction: engine.riskState.riskReduction,
        killed: engine.riskState.killed,
        totalConsecutiveLosses: engine.riskState.totalConsecutiveLosses,
        consecutiveLossesByAsset: engine.riskState.consecutiveLosses || {},
      },
      recent20: { trades: recent20.length, winRate: recentWR, pnl: +recent20PnL.toFixed(2) },
      regimes: engine.regimes,
      regimeStates: engine.regimeStates, // V38: 4-state classifier output
      enableShorts: engine.opts.enableShorts,
      futuresAvailableMargin: availableMargin,
      tickCount,
      fundingCache: getFundingCache(),
      news: getNewsState(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, err: e.message });
  }
});

// V29c: POST /api/halt-all — emergency stop: sluit ALLE posities + disable nieuwe trades
app.post('/api/halt-all', async (_req, res) => {
  log.warn('HALT-ALL triggered');
  const summary = { spot: [], futures: [], engineDisabled: false };
  try {
    // 1. Disable nieuwe trades direct in engine opts
    engine.opts.enableShorts = false;
    summary.engineDisabled = true;

    // 2. Sluit alle spot longs
    const prices = buffer.currentPrices();
    for (const [assetId, pos] of Object.entries(engine.positions)) {
      if (pos.side === 'short' || pos.paperOnly) continue;
      try {
        const price = prices[assetId] || pos.entry;
        const result = await orders.closePosition(assetId, pos.qty, price, 'HALT_ALL');
        const pnl = pos.qty * ((result?.fillPrice || price) - pos.entry);
        engine.cash += pos.qty * (result?.fillPrice || price);
        delete engine.positions[assetId];
        summary.spot.push({ assetId, qty: pos.qty, fillPrice: result?.fillPrice, pnl: +pnl.toFixed(2) });
      } catch (e) {
        summary.spot.push({ assetId, error: e.message });
      }
    }

    // 3. Sluit alle Kraken Futures posities (incl orphans)
    if (futures.enabled) {
      try {
        const openFutures = await futures.getPositions();
        for (const fp of openFutures) {
          const assetId = Object.entries(FUTURES_SYMBOL).find(([, sym]) => sym === fp.symbol)?.[0];
          const qty = Math.abs(parseFloat(fp.size));
          const side = (fp.side || '').toLowerCase();
          try {
            if (side === 'short') {
              await futures.closeShort(assetId || fp.symbol, qty);
            } else {
              await futures._request('POST', '/sendorder', {
                orderType: 'mkt', symbol: fp.symbol, side: 'sell', size: String(qty),
              });
            }
            if (assetId && engine.positions[assetId]) _rollbackPosition(assetId, engine.positions[assetId]);
            summary.futures.push({ symbol: fp.symbol, assetId, qty, side });
          } catch (e) {
            summary.futures.push({ symbol: fp.symbol, error: e.message });
          }
        }
      } catch (e) {
        summary.futures.push({ error: `getPositions: ${e.message}` });
      }
    }

    reportError(`HALT-ALL uitgevoerd: ${summary.spot.length} spot + ${summary.futures.length} futures gesloten. enableShorts=false. Restart bot om weer te activeren.`);
    res.json({ ok: true, summary });
  } catch (e) {
    log.error('HALT-ALL failed', { err: e.message });
    res.status(500).json({ ok: false, err: e.message, summary });
  }
});

// POST /api/force-close/:asset — handmatig een positie sluiten (voor vastzittende posities)
app.post('/api/force-close/:asset', async (req, res) => {
  const assetId = req.params.asset;
  const pos = engine.positions[assetId];
  if (!pos) {
    return res.status(404).json({ ok: false, err: `Geen open positie voor ${assetId}` });
  }
  if (pos.paperOnly) {
    // Paper positie: gewoon verwijderen
    delete engine.positions[assetId];
    return res.json({ ok: true, msg: `Paper positie ${assetId} verwijderd` });
  }
  try {
    const prices = buffer.currentPrices();
    const price = prices[assetId] || pos.entry;
    log.signal(`FORCE CLOSE: ${assetId}`, { qty: pos.qty, price });

    if (pos.side === 'short') {
      await futures.closeShort(assetId, pos.qty);
      engine.cash += (pos.margin || 0) + pos.qty * (pos.entry - price);
    } else {
      const result = await orders.closePosition(assetId, pos.qty, price, 'FORCE_CLOSE');
      if (!result) throw new Error('Order niet uitgevoerd');
      engine.cash += pos.qty * (result.fillPrice || price);
    }

    const pnl = pos.side === 'short'
      ? (pos.entry - price) * pos.qty
      : (price - pos.entry) * pos.qty;

    delete engine.positions[assetId];
    notifySell(assetId, pos.qty, price, pnl, 'FORCE_CLOSE');
    log.trade(`FORCE CLOSED ${assetId}`, { qty: pos.qty, price, pnl: +pnl.toFixed(2) });

    res.json({ ok: true, asset: assetId, qty: pos.qty, price, pnl: +pnl.toFixed(2) });
  } catch (e) {
    log.error(`Force close ${assetId} failed`, { err: e.message });
    res.status(500).json({ ok: false, err: e.message });
  }
});

// ── Optimizer Endpoints ──────────────────────────────────────

// Manual trigger: POST /optimize
app.post('/optimize', async (_req, res) => {
  log.info('Manual optimization triggered via REST');
  try {
    const result = await runOptimization();
    // V12: live reload engine met nieuwe params na optimalisatie
    const newParams = await loadParams();
    if (newParams._meta) {
      engine = new TradingEngine(engine.capital, {
        overrideParams: { ...newParams, perAsset: loadPerAssetParamsSync() },
        enableShorts: ENABLE_SHORTS || DRY_RUN_SHORTS,
        growthMode: GROWTH_MODE,
        learningEngine,
      });
      log.info('Engine reloaded with new optimizer params');
    }
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
  // V40b: ook rolling loss-logs clearen — anders herstelt tick-loop weeklyLoss
  // direct uit weeklyLossLog (vorige incident-events).
  engine.riskState.dailyLossLog = [];
  engine.riskState.weeklyLossLog = [];
  engine.riskState.pauseUntil = {};
  engine.riskState.allPausedUntil = 0;
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
      ws.send(msg, (err) => { // V12: non-blocking met error callback
        if (err) { wsClients.delete(ws); }
      });
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

let tickInFlight = false; // V12: reentrancy guard tegen dubbele orders
async function runEngineTick() {
  if (tickInFlight) { log.warn('Tick skipped: previous tick still running'); return; }
  if (!buffer.ready) {
    log.warn('Engine tick skipped: buffer not ready');
    return;
  }
  tickInFlight = true;
  try {
  tickCount++;
  lastFallbackCheck = Date.now();

  // Build barData (5m), tf15Data (15m), and regimeData (1h) from buffer
  const barData    = {};
  const regimeData = {};
  const tf15Data   = {};

  for (const asset of ASSETS) {
    const d5m = buffer.get(asset.id, CANDLE_INTERVAL);
    const d15  = buffer.get(asset.id, TF15_INTERVAL);
    const d1h  = buffer.get(asset.id, REGIME_INTERVAL);
    if (!d5m) continue;
    barData[asset.id]    = d5m;
    tf15Data[asset.id]   = d15 || null;
    regimeData[asset.id] = d1h || d5m; // fallback to 5m if 1h not ready
  }

  // Snapshot state BEFORE tick to detect new entries/exits + recover from failed SELLs
  const prevPositions = new Set(Object.keys(engine.positions));
  const prevQtySnapshot = {};
  const prevPositionData = {};  // Deep copy for SELL failure recovery
  for (const [id, p] of Object.entries(engine.positions)) {
    prevQtySnapshot[id] = p.qty;
    prevPositionData[id] = { ...p };
  }

  // Run engine logic (signal gen, position management)
  const isDryRun = process.env.DRY_RUN === 'true';
  engine.tick(barData, regimeData, tf15Data);

  // V12: Save state BEFORE orders — als bot crasht na order, weet engine van de positie
  saveEngineState({
    positions: engine.positions,
    cash:      engine.cash,
    riskState: engine.riskState,
  }).catch(() => {});

  // Detect changes and place real orders (or log in DRY_RUN mode)
  await _syncOrders(prevPositions, prevQtySnapshot, prevPositionData, barData, isDryRun);

  // Refresh real Kraken balances every tick
  await refreshBalances();

  // Broadcast updated state
  const prices = buffer.currentPrices();
  const state  = getFullState(prices);
  broadcast('state', state);

  // Refresh learning engine (auto-throttles to every 5 min)
  learningEngine.refresh().catch(() => {});

  // Save equity snapshot + check futures readiness every 12 ticks (= 1 hour)
  if (tickCount % 12 === 0) {
    const unrealized = state.equity - state.cash;
    saveEquitySnapshot(state.equity, state.cash, unrealized).catch(() => {});
    checkFuturesReadiness();
  }

  // V12: state al opgeslagen vóór orders (hierboven) — opnieuw opslaan na orders voor final state
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
  } finally { tickInFlight = false; } // V12: reentrancy guard
}

/**
 * Detect engine decisions and execute real orders on Kraken.
 * Handles: new entries, partial exits, full exits, order failure rollback.
 */
async function _syncOrders(prevPositions, prevQtySnapshot, prevPositionData, barData, isDryRun) {
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
      _rollbackPosition(assetId, pos, true);
      continue;
    }

    if (isDryRun) {
      log.signal(`DRY RUN: ${pos.side === 'short' ? 'SHORT' : 'BUY'} ${assetId}`, { qty: pos.qty, entry: pos.entry });
      notifyBuy(assetId, pos.qty, pos.entry, pos.sl, pos.tp, 0); // notify even in dry run
      continue;
    }

    // DRY_RUN_SHORTS: mark as paper position, let engine manage SL/TP/trailing.
    // Do NOT rollback — engine tracks the full lifecycle so win/loss can be measured.
    if (isDryRunShorts && pos.side === 'short') {
      log.signal(`DRY RUN SHORT: ${assetId}`, { qty: pos.qty, entry: pos.entry, sl: pos.sl, tp: pos.tp });
      notifyShort(assetId, pos.qty, pos.entry, pos.sl, pos.tp, pos.conf || 3);
      pos.paperOnly = true; // flag: engine tracks it, no real futures order placed
      // Return margin — paper shorts don't use real money, don't affect spot sizing
      engine.cash += pos.margin || 0;
      pos.margin = 0;
      continue;
    }

    // Safety: never execute shorts when ENABLE_SHORTS is off
    if (pos.side === 'short' && !ENABLE_SHORTS) {
      log.error(`CRITICAL: SHORT ${assetId} created when shorts disabled — rolling back`);
      _rollbackPosition(assetId, pos, true);
      reportError(`SHORT ${assetId} aangemaakt terwijl shorts uitgeschakeld`);
      continue;
    }

    if (pos.side === 'short') {
      // V31 AGGRESSIVE: pre-flight margin check 30% IM + 10% buffer = 33% (was 36%).
      // Notional cap 4× balance (was 3×) — compromis tussen agressief en veilig.
      // Volledig 5× zoals plan vroeg = te dicht bij liquidatie-zone na vandaag's incident.
      const notional = pos.qty * pos.entry;
      const marginNeeded = notional * 0.33; // 30% IM + 10% buffer
      const futBal = realBalances.futuresUSD;
      if (futBal !== null && futBal < marginNeeded) {
        log.warn(`SKIP SHORT ${assetId}: insufficient futures margin ($${futBal?.toFixed(2)} < $${marginNeeded.toFixed(2)} for $${notional.toFixed(2)} notional)`);
        _rollbackPosition(assetId, pos, true);
        reportError(`SHORT ${assetId} overgeslagen: onvoldoende futures marge`);
        continue;
      }
      // V31: cap total futures notional at 4x balance
      const maxNotional = (futBal || 0) * 4;
      if (notional > maxNotional) {
        log.warn(`SKIP SHORT ${assetId}: notional $${notional.toFixed(2)} exceeds 4x cap $${maxNotional.toFixed(2)}`);
        _rollbackPosition(assetId, pos, true);
        reportError(`SHORT ${assetId} overgeslagen: notional > 4× futures balance`);
        continue;
      }
      // Pre-flight: check futures symbol exists
      if (!futures.hasFuturesSymbol(assetId)) {
        log.warn(`SKIP SHORT ${assetId}: no futures symbol mapping`);
        _rollbackPosition(assetId, pos, true);
        continue;
      }
      log.signal(`REAL ORDER: SHORT ${assetId}`, { qty: pos.qty, entry: pos.entry });
      try {
        const fill = await futures.openShort(assetId, pos.qty);
        if (fill?.fillPrice) { pos.entry = fill.fillPrice; pos.peak = fill.fillPrice; }
        notifyShort(assetId, pos.qty, pos.entry, pos.sl, pos.tp, pos.conf || 3);
      } catch (err) {
        log.error(`Futures short FAILED — rolling back ${assetId}`, { err: err.message });
        _rollbackPosition(assetId, pos, true);
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
        notifyBuy(assetId, pos.qty, fill.fillPrice, pos.sl, pos.tp, signal.conf || 3, pos.score100);
      } else {
        log.error(`Spot BUY FAILED — rolling back ${assetId}`);
        _rollbackPosition(assetId, pos, true);
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
        // Cap partial qty op beschikbare Kraken holdings
        const krakenQty = realBalances.holdings?.[assetId]?.qty ?? partialQty;
        const safePartialQty = Math.min(partialQty, krakenQty);
        if (safePartialQty <= 0) {
          log.warn(`Partial SELL ${assetId} overgeslagen: Kraken heeft 0 (${krakenQty})`);
        } else {
          const partialResult = await orders.closePosition(assetId, safePartialQty, price, 'PARTIAL');
          if (!partialResult) {
            log.error(`Partial SELL ${assetId} failed — reconciliation corrigeert volgende cycle`);
            reportError(`Partial SELL ${assetId} gefaald — reconciliation corrigeert`);
          }
        }
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
        notifySell(assetId, closeQty, exitTrade.price, exitTrade.pnl || 0, `DRY ${reason}`, 'COVER');
      } else {
        log.signal(`REAL ORDER: COVER ${assetId}`, { qty: closeQty, reason });
        try {
          await futures.closeShort(assetId, closeQty);
          notifySell(assetId, closeQty, exitTrade.price, exitTrade.pnl || 0, reason, 'COVER');
        } catch (err) {
          log.error(`Futures cover failed for ${assetId}`, { err: err.message });
          reportError(`COVER ${assetId} gefaald: ${err.message}`);
        }
      }
    } else {
      // Cap closeQty op de werkelijke Kraken-holdings — beschermt tegen qty-mismatch door partial fills
      const krakenQty = realBalances.holdings?.[assetId]?.qty ?? closeQty;
      const safeCloseQty = krakenQty < closeQty * 0.995 ? krakenQty : closeQty;
      if (safeCloseQty !== closeQty) {
        log.warn(`SELL ${assetId}: capping qty ${closeQty} → ${safeCloseQty} (Kraken heeft minder)`);
      }
      log.signal(`REAL ORDER: SELL ${assetId}`, { qty: safeCloseQty, reason });
      const result = await orders.closePosition(assetId, safeCloseQty, exitTrade.price, reason);
      if (result) {
        // Als safeCloseQty < closeQty: engine heeft te veel cash bijgeteld (pos.qty * price).
        // Corrigeer het verschil zodat engine cash klopt met Kraken.
        if (safeCloseQty < closeQty) {
          const overshoot = (closeQty - safeCloseQty) * exitTrade.price;
          engine.cash -= overshoot;
          log.warn(`SELL ${assetId}: cash gecorrigeerd -$${overshoot.toFixed(2)} (qty cap ${closeQty}→${safeCloseQty})`);
        }
        notifySell(assetId, safeCloseQty, exitTrade.price, result?.pnl || exitTrade.pnl || 0, reason);
      } else {
        // SELL FAILED — positie terugzetten in engine zodat volgende tick opnieuw kan proberen
        log.error(`SELL ${assetId} FAILED — restoring position for retry next tick`);
        const savedPos = prevPositionData[assetId];
        if (savedPos) {
          engine.positions[assetId] = { ...savedPos };
          // Cash terug aftrekken (engine had al cashReturn bijgeteld in _closePosition)
          const cashReturn = savedPos.qty * exitTrade.price;
          engine.cash -= cashReturn;
          // Ghost SELL entry verwijderen uit trades[] (was gelogd door _closePosition)
          for (let i = engine.trades.length - 1; i >= 0; i--) {
            if (engine.trades[i].id === assetId && ['SELL', 'COVER'].includes(engine.trades[i].side)) {
              engine.trades.splice(i, 1);
              break;
            }
          }
        }
        reportError(`SELL ${assetId} gefaald — positie hersteld, retry volgende tick`);
      }
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
      if (pos.paperOnly) continue; // paper-tracked position — not on Kraken
      if (!krakenHoldings[assetId] || krakenHoldings[assetId] < pos.qty * 0.20) {
        // V12: alleen verwijderen bij <20% (was 50%). Bij 20-80% loggen als waarschuwing.
        log.warn(`RECONCILE: Engine has LONG ${assetId} (${pos.qty}) but Kraken has ${krakenHoldings[assetId] || 0} — removing phantom`);
        _rollbackPosition(assetId, pos);
        reportError(`Phantom LONG ${assetId} verwijderd (niet op Kraken)`);
      } else if (krakenHoldings[assetId] < pos.qty * 0.995) {
        // Qty mismatch: Kraken heeft minder dan engine verwacht (partial fill / fee rounding).
        // Sync engine qty omlaag naar werkelijke Kraken qty zodat de volgende SELL niet faalt.
        const asset = ASSETS.find(a => a.id === assetId);
        const step  = asset?.qtyStep || 0.001;
        const syncedQty = Math.floor(krakenHoldings[assetId] / step) * step;
        log.warn(`RECONCILE: Syncing ${assetId} qty engine=${pos.qty} → kraken=${syncedQty} (was ${krakenHoldings[assetId]})`);
        pos.qty = syncedQty;
        if (syncedQty <= 0) {
          _rollbackPosition(assetId, pos);
          reportError(`RECONCILE: ${assetId} qty 0 na sync — positie verwijderd`);
        }
      }
    }

    // ── Detect untracked spot holdings (reverse orphan check) ──
    {
      const prices = buffer.currentPrices();
      for (const [assetId, qty] of Object.entries(krakenHoldings)) {
        if (engine.positions[assetId]) continue; // already managed
        const value = qty * (prices[assetId] || 0);
        if (value > 5) { // ignore dust < $5
          log.warn(`ORPHAN: Kraken has ${assetId} qty=${qty} ($${value.toFixed(2)}) not tracked by engine — use POST /api/liquidate-orphans`);
        }
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
          if (pos.paperOnly) continue; // paper short — intentionally not on Kraken
          if (!futuresMap[assetId]) {
            log.warn(`RECONCILE: Engine has SHORT ${assetId} but Kraken Futures has no position — removing phantom`);
            _rollbackPosition(assetId, pos);
            reportError(`Phantom SHORT ${assetId} verwijderd (niet op Kraken Futures)`);
          }
        }

        // V29b: Auto-close orphaned futures (on Kraken but not in engine).
        // Authorized by user: bot mag zelf orphan-posities sluiten om over-leverage
        // en verloren-tracking te voorkomen.
        for (const [assetId, fp] of Object.entries(futuresMap)) {
          if (!engine.positions[assetId]) {
            const qty = Math.abs(parseFloat(fp.size));
            const side = (fp.side || '').toLowerCase();
            log.warn(`RECONCILE: Auto-closing orphan ${side} ${assetId} qty=${qty}`);
            try {
              if (side === 'short') {
                await futures.closeShort(assetId, qty);
              } else if (side === 'long') {
                // closeLong = sell to close
                await futures._request('POST', '/sendorder', {
                  orderType: 'mkt', symbol: fp.symbol, side: 'sell', size: String(qty),
                });
              }
              reportError(`AUTO-CLOSE: orphan ${side} ${assetId} (${qty}) gesloten`);
            } catch (err) {
              log.error(`Auto-close failed for ${assetId}`, { err: err.message });
              reportError(`AUTO-CLOSE FAILED ${assetId}: ${err.message} — handmatig sluiten op Kraken Futures`);
            }
          }
        }

        // V29b: Margin-call protection — als availableMargin negatief, force-close ALLE shorts
        // om liquidatie te voorkomen.
        try {
          const accounts = await futures._request('GET', '/accounts');
          const flex = accounts?.accounts?.flex;
          const availableMargin = flex?.availableMargin;
          if (typeof availableMargin === 'number' && availableMargin < 0) {
            log.warn(`MARGIN CALL ZONE: availableMargin=$${availableMargin.toFixed(2)} — force-closing all futures`);
            for (const fp of openFutures) {
              const assetId = Object.entries(FUTURES_SYMBOL).find(([, sym]) => sym === fp.symbol)?.[0];
              const qty = Math.abs(parseFloat(fp.size));
              const side = (fp.side || '').toLowerCase();
              try {
                if (side === 'short') await futures.closeShort(assetId || fp.symbol, qty);
                else await futures._request('POST', '/sendorder', {
                  orderType: 'mkt', symbol: fp.symbol, side: 'sell', size: String(qty),
                });
                // Ook engine position rollbacken als die er nog is
                if (assetId && engine.positions[assetId]) _rollbackPosition(assetId, engine.positions[assetId]);
              } catch (err) {
                log.error(`Margin-call close failed for ${fp.symbol}`, { err: err.message });
              }
            }
            reportError(`MARGIN-CALL: Alle futures geforceerd gesloten (availableMargin was $${availableMargin.toFixed(2)})`);
          }
        } catch (e) {
          log.warn('Margin-call check failed', { err: e.message });
        }
      } catch (e) {
        log.warn('Futures reconciliation failed', { err: e.message });
      }
    }

    // V19: sync engine cash/capital met Kraken (altijd).
    // startCapital alleen OMHOOG bij externe deposits — nooit naar beneden bij verliezen
    // (anders gaat PnL-baseline verloren en kan kill switch niet triggeren).
    const openSpotPositions = Object.values(engine.positions).filter(p => p.side !== 'short' && !p.paperOnly);
    if (openSpotPositions.length === 0 && realBalances.spotUSD > 0) {
      engine.capital = realBalances.spotUSD;
      engine.cash    = realBalances.spotCash ?? realBalances.spotUSD;
      // Detecteer externe deposit: spotUSD > startCapital + 5% → user heeft geld toegevoegd
      if (realBalances.spotUSD > engine.riskState.startCapital * 1.05) {
        log.warn(`V19 Reconcile: deposit gedetecteerd — startCapital $${engine.riskState.startCapital.toFixed(2)} → $${realBalances.spotUSD.toFixed(2)}`);
        engine.riskState.startCapital = realBalances.spotUSD;
      }
    }
  } catch (e) {
    log.warn('Reconciliation failed', { err: e.message });
  }
}

/**
 * Rollback engine position.
 * @param {boolean} isFailedOrder - true = order nooit uitgevoerd (verwijder trade log entry)
 *                                  false = reconcile/externe sluiting (trade log behouden)
 */
function _rollbackPosition(assetId, pos, isFailedOrder = false) {
  if (pos.side === 'short') {
    engine.cash += pos.margin || 0;
  } else {
    engine.cash += pos.qty * pos.entry;
  }
  delete engine.positions[assetId];

  // Verwijder ghost entry alleen bij gefaalde orders (nooit op exchange belanden)
  // Bij reconciliatie (positie was echt open) laten we de BUY/SHORT entry staan
  if (isFailedOrder) {
    const entrySide = pos.side === 'short' ? 'SHORT' : 'BUY';
    for (let i = engine.trades.length - 1; i >= 0; i--) {
      if (engine.trades[i].id === assetId && engine.trades[i].side === entrySide) {
        engine.trades.splice(i, 1);
        break;
      }
    }
  }

  log.warn(`Rolled back engine position for ${assetId}`);
}

// ── Startup ───────────────────────────────────────────────────

// V12: retry helper voor startup
async function withRetry(fn, name, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (e) {
      log.error(`${name} failed (attempt ${i}/${attempts})`, { err: e.message });
      if (i === attempts) throw e;
      await new Promise(r => setTimeout(r, 5000 * i));
    }
  }
}

async function start() {
  log.info('═══════════════════════════════════════════════════════════');
  log.info('  APEX CRYPTO V2 — STARTING (Kraken)');
  log.info(`  Capital: $${CAPITAL} | Assets: ${ASSETS.map(a => a.id).join(', ')}`);
  log.info(`  Shorts: ${ENABLE_SHORTS ? 'ENABLED (Kraken Futures)' : 'DISABLED (spot only)'}`);
  log.info('═══════════════════════════════════════════════════════════');

  // 0. Initialize database (Turso or local SQLite)
  await withRetry(() => initDB(), 'initDB');

  // Load optimizer params from DB (overrides defaults)
  const savedParams = await loadParams();
  // V17: Clear stale optimizer params — oude tpM/MAX_BARS=72 zijn niet meer geldig
  if (savedParams && !savedParams._v17) {
    log.info('V17: Clearing stale optimizer params from DB (old tpM/MAX_BARS values)');
    await saveState('params', null);
    // Engine gebruikt nu nieuwe DEFAULT_PARAMS uit optimizer.mjs (met _v17 flag)
  } else if (savedParams && savedParams._v17) {
    engine = new TradingEngine(CAPITAL, { overrideParams: { ...savedParams, perAsset: loadPerAssetParamsSync() }, enableShorts: ENABLE_SHORTS || DRY_RUN_SHORTS, growthMode: GROWTH_MODE, learningEngine });
    log.info('Loaded V17 optimizer params from DB', savedParams._meta);
  }

  // Restore engine state if recent (< 30 min old)
  const savedState = await loadEngineState();
  if (savedState) {
    engine.positions = savedState.positions || {};
    engine.cash      = savedState.cash      ?? engine.cash;
    engine.riskState = { ...engine.riskState, ...savedState.riskState };
    // Prune stale loss logs immediately — removes expired entries so
    // dailyLoss/weeklyLoss reflect only actual losses within the rolling window
    engine.riskState.dailyLossLog  = (engine.riskState.dailyLossLog  || []).filter(e => Date.now() - e.timestamp < 24 * 60 * 60 * 1000);
    engine.riskState.weeklyLossLog = (engine.riskState.weeklyLossLog || []).filter(e => Date.now() - e.timestamp <  7 * 24 * 60 * 60 * 1000);
    engine.riskState.dailyLoss  = engine.riskState.dailyLossLog.reduce((s, e) => s + e.pnl, 0);
    engine.riskState.weeklyLoss = engine.riskState.weeklyLossLog.reduce((s, e) => s + e.pnl, 0);
    log.info(`Engine state restored: ${Object.keys(engine.positions).length} positions, cash $${engine.cash?.toFixed(2)}, dailyLoss $${engine.riskState.dailyLoss.toFixed(2)}`);
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
  await withRetry(() => refreshBalances(), 'refreshBalances');
  if (realBalances.spotUSD > 0) {
    log.info(`Real Kraken balance: total $${realBalances.spotUSD.toFixed(2)}, cash $${(realBalances.spotCash ?? 0).toFixed(2)}`);
    // capital = total portfolio (for equity display)
    // cash = tradable cash only (for position sizing / order placement)
    engine.capital = realBalances.spotUSD;
    engine.cash    = realBalances.spotCash ?? realBalances.spotUSD;
    // startCapital = totale portfolio (cash + holdings), NIET alleen cash.
    // Met open posities is spotCash laag ($4.58) maar totale waarde is $199.
    // Kill switch en drawdown tracking moeten op totale waarde baseren.
    engine.riskState.startCapital = realBalances.spotUSD;
    // Reset kill switch if triggered in a previous session.
    // Kraken balance is source of truth: if account is funded, we can trade.
    if (engine.riskState.killed || engine.riskState.riskReduction === 0) {
      log.info('Startup: resetting kill switch — Kraken balance confirmed healthy');
      engine.riskState.killed = false;
      engine.riskState.riskReduction = 1.0;
    }
  }
  if (realBalances.futuresUSD !== null) {
    log.info(`Real Kraken futures balance: $${realBalances.futuresUSD.toFixed(2)} USD`);
  }

  // Refresh balances every 60 seconds
  setInterval(refreshBalances, 60_000);

  // Reconcile engine positions vs Kraken every 5 minutes
  setInterval(reconcilePositions, 5 * 60_000);

  // 2. Fetch historical data
  await withRetry(() => buffer.init(), 'buffer.init');

  // 2b. Herbereken balances nu prijzen beschikbaar zijn (holdings waarde = 0 was bij stap 1)
  await refreshBalances();
  if (realBalances.spotUSD > 0) {
    log.info(`Post-buffer balance: total $${realBalances.spotUSD.toFixed(2)}, cash $${(realBalances.spotCash ?? 0).toFixed(2)}`);
    engine.capital = realBalances.spotUSD;
    engine.cash    = realBalances.spotCash ?? realBalances.spotUSD;
    engine.riskState.startCapital = realBalances.spotUSD;
  }

  // 3. Connect Kraken WebSocket streams
  kraken.connectWebSocket(onBarClose);

  // Backfill candle gaps after WS reconnect
  kraken.on('reconnected', () => {
    log.info('WS reconnected — backfilling candle gaps');
    buffer.refetchRecent().catch(() => {});
  });

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
  notifyStartup(realBalances.spotUSD || engine.capital || CAPITAL, ASSETS.length);

  // V32: Start funding-rate poller (Kraken Futures public tickers, no auth)
  startFundingPoller();
  log.info('Funding-rate poller started (refresh every 30 min)');

  // V36: Start CryptoPanic news poller (only active als CRYPTOPANIC_API_TOKEN gezet is)
  startNewsPoller();

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
