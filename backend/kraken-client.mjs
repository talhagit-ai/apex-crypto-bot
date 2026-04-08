// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Kraken Client
//  REST + WebSocket v2 for Kraken exchange
//  Handles EUR pairs, reconnects, and event emission
// ═══════════════════════════════════════════════════════════════

import { Kraken } from 'node-kraken-api';
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import {
  KRAKEN_API_KEY, KRAKEN_API_SECRET,
  ASSETS, CANDLE_INTERVAL, REGIME_INTERVAL,
} from './config.mjs';
import { log } from './logger.mjs';

// Kraken interval mapping (minutes → Kraken API interval value)
const INTERVAL_MAP = { '5': 5, '60': 60 };

/**
 * KrakenClient — wraps node-kraken-api REST + WebSocket
 *
 * Events:
 *   'kline'  — { assetId, interval, candle, closed }
 *   'ready'  — WebSocket connected
 *   'error'  — { msg, err }
 */
export class KrakenClient extends EventEmitter {
  constructor() {
    super();
    this.api = new Kraken({
      key:    KRAKEN_API_KEY,
      secret: KRAKEN_API_SECRET,
    });
    this.ws = null;
    this._lastBars = {}; // `${symbol}-${interval}` → last seen bar (for close detection)
  }

  // ── REST ──────────────────────────────────────────────────────

  /**
   * Fetch historical OHLCV bars
   * @param {string} symbol - Kraken symbol e.g. 'XBTEUR'
   * @param {string} interval - '5' or '60'
   * @param {number} limit - max bars to return
   * @returns {Array} [[timestamp, open, high, low, close, vwap, volume, count], ...]
   */
  async getKlines(symbol, interval, limit = 150) {
    const resp = await this.api.ohlc({
      pair:     symbol,
      interval: INTERVAL_MAP[interval] || 5,
    });

    // node-kraken-api v2 returns data directly (no .result wrapper)
    // The key is Kraken's internal pair name (e.g. 'XXBTZEUR'), find it by excluding 'last'
    const pairKey = Object.keys(resp).find(k => k !== 'last');
    const bars = resp[pairKey] || [];

    // Return last `limit` bars (drop the last in-progress bar)
    return bars.slice(-(limit + 1), -1);
  }

  /**
   * Get USDT/EUR wallet balance
   */
  async getBalance() {
    const resp = await this.api.balance();
    // Direct object: { ZEUR: '1234.56', XXBT: '0.5', ... }
    const eur = parseFloat(resp?.ZEUR || resp?.EUR || 0);
    return eur;
  }

  /**
   * Resolve krakenPair from asset id or symbol
   */
  _krakenPair(symbol) {
    const asset = ASSETS.find(a => a.id === symbol || a.symbol === symbol);
    return asset?.krakenPair || symbol;
  }

  /**
   * Place a market order on Kraken Spot
   * @returns {{ orderId, symbol, side, qty }}
   */
  async placeOrder({ symbol, side, qty }) {
    const pair = this._krakenPair(symbol);
    log.info(`Placing ${side} order`, { pair, qty });
    const resp = await this.api.addOrder({
      pair,
      type:      side === 'Buy' ? 'buy' : 'sell',
      ordertype: 'market',
      volume:    String(qty),
    });

    const orderId = resp?.txid?.[0] || 'unknown';
    log.info(`Order placed`, { orderId, pair, side });
    return { orderId, symbol, side, qty };
  }

  /**
   * Get order details for fill confirmation
   */
  async getOrder(symbol, orderId) {
    const resp = await this.api.queryOrders({ txid: orderId });
    const order = resp?.[orderId];
    if (!order) return null;

    return {
      orderStatus: order.status === 'closed' ? 'Filled' : order.status,
      avgPrice:    parseFloat(order.price || order.descr?.price || 0),
    };
  }

  /**
   * Get current ticker (bid/ask/last)
   */
  async getTicker(symbol) {
    const pair = this._krakenPair(symbol);
    const resp = await this.api.ticker({ pair });
    const pairKey = Object.keys(resp).find(k => k !== 'last') || Object.keys(resp)[0];
    const t = resp[pairKey];
    return {
      lastPrice: parseFloat(t.c[0]),
      bidPrice:  parseFloat(t.b[0]),
      askPrice:  parseFloat(t.a[0]),
    };
  }

  // ── WebSocket ─────────────────────────────────────────────────

  /**
   * Connect to Kraken WebSocket v2 and subscribe to OHLC streams
   */
  connectWebSocket(onBarClose) {
    const symbols5m  = ASSETS.map(a => a.krakenSymbol || a.symbol);
    const symbols60m = ASSETS.map(a => a.krakenSymbol || a.symbol);

    // Exponential backoff for reconnection
    if (!this._reconnectAttempts) this._reconnectAttempts = 0;

    const wsUrl = 'wss://ws.kraken.com/v2';
    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      this._reconnectAttempts = 0; // reset on success
      log.info('Kraken WebSocket connected');

      this.ws.send(JSON.stringify({
        method: 'subscribe',
        params: { channel: 'ohlc', symbol: symbols5m, interval: 5 },
      }));

      this.ws.send(JSON.stringify({
        method: 'subscribe',
        params: { channel: 'ohlc', symbol: symbols60m, interval: 60 },
      }));

      this.emit('ready');
    });

    this.ws.on('message', (raw) => {
      this._handleMessage(JSON.parse(raw.toString()), onBarClose);
    });

    this.ws.on('close', () => {
      this._reconnectAttempts++;
      const delay = Math.min(60000, 5000 * Math.pow(2, this._reconnectAttempts - 1));
      log.info(`Kraken WebSocket closed — reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts})`);
      if (this._reconnectAttempts >= 10) {
        this.emit('error', { msg: 'WebSocket: 10 consecutive reconnect failures — stopping reconnect' });
        return; // Stop reconnecting — server should handle restart
      }
      setTimeout(() => this.connectWebSocket(onBarClose), delay);
    });

    this.ws.on('error', (err) => {
      log.error('Kraken WebSocket error', { err: err.message });
      this.emit('error', { msg: 'WebSocket error', err });
    });
  }

  _handleMessage(msg, onBarClose) {
    if (msg.channel !== 'ohlc') return;

    for (const bar of (msg.data || [])) {
      const asset = ASSETS.find(a => (a.krakenSymbol || a.symbol) === bar.symbol);
      if (!asset) continue;

      const interval = String(bar.interval || 5);
      const key      = `${bar.symbol}-${interval}`;
      const prev     = this._lastBars[key];

      const candle = {
        timestamp: new Date(bar.timestamp).getTime(),
        open:   parseFloat(bar.open   || 0),
        high:   parseFloat(bar.high   || 0),
        low:    parseFloat(bar.low    || 0),
        close:  parseFloat(bar.close  || 0),
        volume: parseFloat(bar.volume || 0),
        closed: false,
      };

      // Kraken v2 has no "confirm" flag — detect bar close by interval_begin change.
      // When a new interval starts (update type only), the PREVIOUS bar is now closed.
      if (msg.type === 'update' && prev && prev.interval_begin !== bar.interval_begin) {
        const closedCandle = {
          timestamp: new Date(prev.timestamp).getTime(),
          open:   parseFloat(prev.open   || 0),
          high:   parseFloat(prev.high   || 0),
          low:    parseFloat(prev.low    || 0),
          close:  parseFloat(prev.close  || 0),
          volume: parseFloat(prev.volume || 0),
          closed: true,
        };
        log.info(`Bar closed: ${asset.id} [${interval}m] close=${closedCandle.close}`);
        this.emit('kline', { assetId: asset.id, interval, candle: closedCandle });
        if (typeof onBarClose === 'function') {
          onBarClose(asset.id, interval, closedCandle);
        }
      }

      this._lastBars[key] = bar;

      // Always emit current (running) bar so buffer stays up to date
      this.emit('kline', { assetId: asset.id, interval, candle });
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      log.info('Kraken WebSocket disconnected');
    }
  }
}
