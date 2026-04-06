// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V1 — Bybit Client
//  REST (V5) + WebSocket for kline streams
//  Handles testnet/mainnet, reconnects, and event emission
// ═══════════════════════════════════════════════════════════════

import { RestClientV5, WebsocketClient } from 'bybit-api';
import { EventEmitter } from 'events';
import {
  BYBIT_API_KEY, BYBIT_API_SECRET, BYBIT_TESTNET,
  ASSETS, CANDLE_INTERVAL, REGIME_INTERVAL, MODE, BYBIT_BASE_URL,
} from './config.mjs';
import { log } from './logger.mjs';

/**
 * BybitClient — wraps bybit-api REST + WebSocket
 *
 * Events emitted:
 *   'kline'  — { assetId, interval, candle, closed }
 *   'ready'  — WebSocket streams connected
 *   'error'  — { msg, err }
 */
export class BybitClient extends EventEmitter {
  constructor() {
    super();
    this.rest = new RestClientV5({
      key:     BYBIT_API_KEY,
      secret:  BYBIT_API_SECRET,
      testnet: BYBIT_TESTNET,
      ...(BYBIT_BASE_URL ? { baseUrl: BYBIT_BASE_URL } : {}),
    });

    this.ws = null;
    this._subscriptions = [];
  }

  // ── REST ──────────────────────────────────────────────────────

  /**
   * Fetch historical klines
   * @returns {Array} raw kline rows [[timestamp, open, high, low, close, volume], ...]
   */
  async getKlines(symbol, interval, limit = 150) {
    const resp = await this.rest.getKline({
      category: MODE,
      symbol,
      interval: String(interval),
      limit,
    });
    if (resp.retCode !== 0) {
      throw new Error(`Bybit getKlines error: ${resp.retMsg}`);
    }
    return resp.result.list; // newest first
  }

  /**
   * Get current wallet balance (USDT)
   */
  async getBalance() {
    const resp = await this.rest.getWalletBalance({
      accountType: MODE === 'linear' ? 'CONTRACT' : 'SPOT',
      coin: 'USDT',
    });
    if (resp.retCode !== 0) throw new Error(`getBalance: ${resp.retMsg}`);

    const account = resp.result.list?.[0];
    if (!account) return 0;

    // Spot: coins array; Linear: totalEquity
    if (MODE === 'spot') {
      const coin = account.coin?.find(c => c.coin === 'USDT');
      return coin ? Number(coin.walletBalance) : 0;
    } else {
      return Number(account.totalEquity || 0);
    }
  }

  /**
   * Place a market order
   * @returns {object} { orderId, avgPrice, qty }
   */
  async placeOrder({ symbol, side, qty, reduceOnly = false }) {
    const params = {
      category: MODE,
      symbol,
      side,           // 'Buy' or 'Sell'
      orderType: 'Market',
      qty: String(qty),
    };

    if (MODE === 'linear' && reduceOnly) {
      params.reduceOnly = true;
    }

    const resp = await this.rest.submitOrder(params);
    if (resp.retCode !== 0) {
      throw new Error(`placeOrder ${symbol} ${side}: ${resp.retMsg}`);
    }
    return {
      orderId: resp.result.orderId,
      symbol,
      side,
      qty,
    };
  }

  /**
   * Get order details (for fill confirmation)
   */
  async getOrder(symbol, orderId) {
    const resp = await this.rest.getHistoricOrders({
      category: MODE,
      symbol,
      orderId,
      limit: 1,
    });
    if (resp.retCode !== 0) throw new Error(`getOrder: ${resp.retMsg}`);
    return resp.result.list?.[0] || null;
  }

  /**
   * Get current ticker (best bid/ask + last price)
   */
  async getTicker(symbol) {
    const resp = await this.rest.getTickers({ category: MODE, symbol });
    if (resp.retCode !== 0) throw new Error(`getTicker: ${resp.retMsg}`);
    const t = resp.result.list?.[0];
    if (!t) return null;
    return {
      lastPrice: Number(t.lastPrice),
      bidPrice:  Number(t.bid1Price),
      askPrice:  Number(t.ask1Price),
    };
  }

  // ── WebSocket ─────────────────────────────────────────────────

  /**
   * Connect WebSocket and subscribe to kline streams for all assets
   */
  connectWebSocket(onBarClose) {
    this.ws = new WebsocketClient({
      market: MODE === 'linear' ? 'v5/linear' : 'v5/spot',
      key:    BYBIT_API_KEY,
      secret: BYBIT_API_SECRET,
      testnet: BYBIT_TESTNET,
    });

    // Build topic list: kline.5.BTCUSDT + kline.60.BTCUSDT for each asset
    const topics = [];
    for (const asset of ASSETS) {
      topics.push(`kline.${CANDLE_INTERVAL}.${asset.symbol}`);
      topics.push(`kline.${REGIME_INTERVAL}.${asset.symbol}`);
    }

    this.ws.on('update', (data) => {
      this._handleKlineUpdate(data, onBarClose);
    });

    this.ws.on('open', () => {
      log.info('Bybit WebSocket connected');
      this.emit('ready');
    });

    this.ws.on('reconnect', () => log.info('WebSocket reconnecting...'));
    this.ws.on('reconnected', () => log.info('WebSocket reconnected'));

    this.ws.on('error', (err) => {
      log.error('WebSocket error', { err: err?.message || err });
      this.emit('error', { msg: 'WebSocket error', err });
    });

    this.ws.subscribeV5(topics, MODE === 'linear' ? 'linear' : 'spot');
    log.info(`WebSocket subscribed to ${topics.length} kline streams`);
  }

  /**
   * Parse incoming kline WebSocket message
   */
  _handleKlineUpdate(data, onBarClose) {
    if (!data?.topic?.startsWith('kline.')) return;

    // topic format: kline.5.BTCUSDT
    const parts = data.topic.split('.');
    const interval = parts[1];
    const symbol   = parts[2];

    const asset = ASSETS.find(a => a.symbol === symbol);
    if (!asset) return;

    const klineList = data.data;
    if (!Array.isArray(klineList) || klineList.length === 0) return;

    for (const k of klineList) {
      const candle = {
        timestamp: Number(k.start),
        open:      Number(k.open),
        high:      Number(k.high),
        low:       Number(k.low),
        close:     Number(k.close),
        volume:    Number(k.volume),
        closed:    k.confirm === true, // true when bar is fully closed
      };

      this.emit('kline', { assetId: asset.id, interval, candle });

      // Only trigger engine tick on confirmed (closed) bars
      if (candle.closed && typeof onBarClose === 'function') {
        onBarClose(asset.id, interval, candle);
      }
    }
  }

  /**
   * Graceful disconnect
   */
  disconnect() {
    if (this.ws) {
      this.ws.closeAll();
      log.info('WebSocket disconnected');
    }
  }
}
