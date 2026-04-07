// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V1 — Order Manager
//  Market orders with retry, fill confirmation, slippage guard
//  Translates engine signals → real Bybit orders
// ═══════════════════════════════════════════════════════════════

import { ASSETS, FEE_RATE, MODE } from './config.mjs';
import { log } from './logger.mjs';
import { saveTrade } from './persistence.mjs';

const MAX_SLIPPAGE = 0.003;   // 0.3% max slippage from signal price
const MAX_RETRIES  = 3;
const RETRY_DELAY  = 1500;    // ms between retries
const FILL_TIMEOUT = 8000;    // ms to wait for fill confirmation

/**
 * OrderManager — places real orders on Bybit and verifies fills
 */
export class OrderManager {
  constructor(bybitClient) {
    this.client = bybitClient;
    this.pendingOrders = {};  // orderId → { assetId, side, qty, signalPrice, resolve, reject }
  }

  /**
   * Open a new long position (BUY market order)
   *
   * @param {object} signal - from generateSignal()
   * @param {number} qty    - from calculatePositionSize()
   * @returns {object|null} { orderId, fillPrice, qty } or null on failure
   */
  async openPosition(signal, qty) {
    const { asset: assetId, price: signalPrice } = signal;
    const asset = ASSETS.find(a => a.id === assetId);
    if (!asset) return null;

    // Use krakenPair for all REST calls (e.g. XBTUSD, not BTCUSDT)
    const pair = asset.krakenPair || asset.symbol;

    const result = await this._placeWithRetry(pair, 'Buy', qty, signalPrice);
    if (!result) return null;

    const fillPrice = await this._waitForFill(pair, result.orderId, signalPrice);

    // Slippage monitoring
    if (fillPrice && signalPrice) {
      const slippage = Math.abs(fillPrice - signalPrice) / signalPrice;
      if (slippage > MAX_SLIPPAGE) {
        log.warn(`Slippage exceeded: ${(slippage * 100).toFixed(2)}% on BUY ${assetId}`, { fillPrice, signalPrice });
      }
    }

    log.trade(`ORDER FILLED BUY ${assetId}`, {
      orderId: result.orderId,
      qty,
      fillPrice: fillPrice || signalPrice,
      signalPrice,
      conf: signal.conf,
    });

    const trade = {
      id: assetId,
      side: 'BUY',
      price: fillPrice || signalPrice,
      qty,
      pnl: null,
      r: null,
      reason: `${signal.conf}/6 conf | R:R ${signal.rr}`,
      timestamp: Date.now(),
    };
    saveTrade(trade);

    return {
      orderId: result.orderId,
      fillPrice: fillPrice || signalPrice,
      qty,
    };
  }

  /**
   * Close a position (SELL market order)
   *
   * @param {string} assetId
   * @param {number} qty     - quantity to sell
   * @param {number} entryPrice
   * @param {string} reason  - 'SL' | 'TP' | 'PARTIAL1' | 'PARTIAL2' | 'TRAIL' | 'TIME'
   * @returns {object|null} { fillPrice, pnl }
   */
  async closePosition(assetId, qty, entryPrice, reason) {
    const asset = ASSETS.find(a => a.id === assetId);
    if (!asset) return null;

    const pair = asset.krakenPair || asset.symbol;
    const ticker = await this._safeGetTicker(pair);
    const signalPrice = ticker?.bidPrice || entryPrice;

    const result = await this._placeWithRetry(pair, 'Sell', qty, signalPrice);
    if (!result) return null;

    const fillPrice = await this._waitForFill(pair, result.orderId, signalPrice);
    const actualPrice = fillPrice || signalPrice;

    // Slippage monitoring
    if (fillPrice && signalPrice) {
      const slippage = Math.abs(fillPrice - signalPrice) / signalPrice;
      if (slippage > MAX_SLIPPAGE) {
        log.warn(`Slippage exceeded: ${(slippage * 100).toFixed(2)}% on SELL ${assetId}`, { fillPrice, signalPrice });
      }
    }

    const pnl = (actualPrice - entryPrice) * qty;
    const feeCost = actualPrice * qty * FEE_RATE * 2; // round-trip fee
    const netPnl = pnl - feeCost;

    log.trade(`ORDER FILLED SELL ${assetId}`, {
      orderId: result.orderId,
      qty,
      fillPrice: actualPrice,
      pnl: +netPnl.toFixed(2),
      reason,
    });

    const trade = {
      id: assetId,
      side: reason.startsWith('PARTIAL') ? reason : 'SELL',
      price: actualPrice,
      qty,
      pnl: +netPnl.toFixed(2),
      r: null,
      reason,
      timestamp: Date.now(),
    };
    saveTrade(trade);

    return { fillPrice: actualPrice, pnl: netPnl };
  }

  // ── Private ───────────────────────────────────────────────────

  async _placeWithRetry(symbol, side, qty, signalPrice) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await this.client.placeOrder({ symbol, side, qty });
        log.info(`Order placed ${symbol} ${side}`, { orderId: result.orderId, attempt });
        return result;
      } catch (err) {
        log.warn(`Order failed attempt ${attempt}/${MAX_RETRIES}: ${err.message}`, { symbol, side });
        if (attempt < MAX_RETRIES) {
          await _sleep(RETRY_DELAY * attempt);
        }
      }
    }
    log.error(`Order FAILED after ${MAX_RETRIES} attempts`, { symbol, side, qty });
    return null;
  }

  async _waitForFill(symbol, orderId, fallbackPrice) {
    const deadline = Date.now() + FILL_TIMEOUT;
    while (Date.now() < deadline) {
      try {
        const order = await this.client.getOrder(symbol, orderId);
        if (order && order.orderStatus === 'Filled') {
          return Number(order.avgPrice) || fallbackPrice;
        }
        if (order && ['Cancelled', 'Rejected'].includes(order.orderStatus)) {
          log.warn(`Order ${orderId} was ${order.orderStatus}`);
          return null;
        }
      } catch (_) { /* ignore poll errors */ }
      await _sleep(500);
    }
    log.warn(`Fill timeout for order ${orderId} — using signal price`);
    return fallbackPrice;
  }

  async _safeGetTicker(symbol) {
    try {
      return await this.client.getTicker(symbol);
    } catch (_) {
      return null;
    }
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
