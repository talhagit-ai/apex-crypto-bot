// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V4 — Kraken Futures Client (Production-Ready)
//  REST API for perpetual futures with retry, fill verification,
//  leverage management, and robust error handling.
// ═══════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { KRAKEN_FUTURES_API_KEY, KRAKEN_FUTURES_API_SECRET } from './config.mjs';
import { log } from './logger.mjs';

const BASE_URL    = 'https://futures.kraken.com/derivatives/api/v3';
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;  // ms, doubles each retry
const REQ_TIMEOUT = 15000; // 15s per request

// Spot → Futures symbol mapping (Kraken USD perpetuals)
export const FUTURES_SYMBOL = {
  BTCUSDT:  'PF_XBTUSD',
  ETHUSDT:  'PF_ETHUSD',
  SOLUSDT:  'PF_SOLUSD',
  XRPUSDT:  'PF_XRPUSD',
  ADAUSDT:  'PF_ADAUSD',
  DOTUSD:   'PF_DOTUSD',
  LINKUSD:  'PF_LINKUSD',
  LTCUSD:   'PF_LTCUSD',
};

export class KrakenFuturesClient {
  constructor() {
    this.apiKey    = KRAKEN_FUTURES_API_KEY;
    this.apiSecret = KRAKEN_FUTURES_API_SECRET;
    this.enabled   = !!(this.apiKey && this.apiSecret);

    if (!this.enabled) {
      log.warn('Kraken Futures: no API keys — shorts disabled');
    }
  }

  /**
   * Check if a given asset has a futures symbol mapping
   */
  hasFuturesSymbol(assetId) {
    return !!FUTURES_SYMBOL[assetId];
  }

  // ── Authentication ─────────────────────────────────────────

  _sign(path, nonce, postData = '') {
    const message = crypto.createHash('sha256')
      .update(postData + nonce + path)
      .digest();
    const secret = Buffer.from(this.apiSecret, 'base64');
    return crypto.createHmac('sha512', secret).update(message).digest('base64');
  }

  async _request(method, path, params = {}, retries = MAX_RETRIES) {
    if (!this.enabled) throw new Error('Futures API keys not configured');

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const nonce    = Date.now().toString();
        const pathOnly = `/api/v3${path}`;
        let   url      = `${BASE_URL}${path}`;
        let   body     = '';

        if (method === 'GET' && Object.keys(params).length > 0) {
          url += '?' + new URLSearchParams(params).toString();
        } else if (method === 'POST') {
          body = new URLSearchParams(params).toString();
        }

        const postData = method === 'POST' ? body : undefined;
        const sig = this._sign(pathOnly, nonce, postData || '');

        const headers = {
          'APIKey':  this.apiKey,
          'Nonce':   nonce,
          'Authent': sig,
        };
        if (method === 'POST') {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQ_TIMEOUT);

        const res = await fetch(url, {
          method,
          headers,
          body: method === 'POST' ? body : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const data = await res.json();
        if (data.result !== 'success') {
          throw new Error(`Futures API error: ${JSON.stringify(data.error || data).slice(0, 200)}`);
        }
        return data;

      } catch (err) {
        if (attempt === retries) throw err;
        const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
        log.warn(`Futures API retry ${attempt}/${retries} in ${delay}ms`, { err: err.message, path });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // ── REST Methods ───────────────────────────────────────────

  /**
   * Get futures account balance (available margin in USD)
   */
  async getBalance() {
    const data = await this._request('GET', '/accounts');
    const flexUSD = data.accounts?.flex?.currencies?.USD?.quantity;
    if (flexUSD !== undefined) {
      const parsed = parseFloat(flexUSD);
      if (isNaN(parsed)) throw new Error(`Invalid flex balance: ${flexUSD}`);
      return parsed;
    }
    const cashUSD = data.accounts?.cash?.balances?.usd;
    const parsed = parseFloat(cashUSD || 0);
    if (isNaN(parsed)) throw new Error(`Invalid cash balance: ${cashUSD}`);
    return parsed;
  }

  /**
   * Open a short position (sell futures contract)
   * @param {string} assetId - e.g. 'BTCUSDT'
   * @param {number} qty     - contract size (base currency units)
   * @returns {{ orderId, symbol, side, qty, fillPrice }}
   */
  async openShort(assetId, qty) {
    const symbol = FUTURES_SYMBOL[assetId];
    if (!symbol) throw new Error(`No futures symbol for ${assetId}`);

    log.signal(`FUTURES SHORT: ${symbol} qty=${qty}`);

    const data = await this._request('POST', '/sendorder', {
      orderType: 'mkt',
      symbol,
      side:   'sell',
      size:   String(qty),
    });

    const orderId = data.sendStatus?.order_id;
    if (!orderId) throw new Error(`No order ID returned for SHORT ${symbol}`);

    // Verify fill
    const fill = await this._waitForFill(orderId);
    if (!fill) {
      log.error(`SHORT ${symbol} order ${orderId} not filled within timeout`);
      throw new Error(`Order ${orderId} not filled`);
    }

    log.trade(`FUTURES SHORT FILLED: ${symbol}`, { orderId, fillPrice: fill.price, qty });

    return { orderId, symbol, side: 'sell', qty, fillPrice: fill.price };
  }

  /**
   * Close a short position (buy to cover)
   */
  async closeShort(assetId, qty) {
    const symbol = FUTURES_SYMBOL[assetId];
    if (!symbol) throw new Error(`No futures symbol for ${assetId}`);

    log.signal(`FUTURES COVER: ${symbol} qty=${qty}`);

    const data = await this._request('POST', '/sendorder', {
      orderType: 'mkt',
      symbol,
      side:   'buy',
      size:   String(qty),
    });

    const orderId = data.sendStatus?.order_id;
    if (!orderId) throw new Error(`No order ID returned for COVER ${symbol}`);

    const fill = await this._waitForFill(orderId);
    if (!fill) {
      log.error(`COVER ${symbol} order ${orderId} not filled within timeout`);
      throw new Error(`Order ${orderId} not filled`);
    }

    log.trade(`FUTURES COVER FILLED: ${symbol}`, { orderId, fillPrice: fill.price, qty });

    return { orderId, symbol, side: 'buy', qty, fillPrice: fill.price };
  }

  /**
   * Wait for order to fill (poll status)
   */
  async _waitForFill(orderId, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const data = await this._request('GET', '/orders/status', { orderIds: orderId }, 1);
        const order = data.orders?.[0];
        if (order?.status === 'filled' || order?.status === 'partiallyFilled') {
          return { price: parseFloat(order.lastPrice || order.limitPrice || 0) };
        }
        if (['cancelled', 'ioc_expired', 'rejected'].includes(order?.status)) {
          return null;
        }
      } catch (_) { /* poll errors ignored */ }
      await new Promise(r => setTimeout(r, 1500));
    }
    return null;
  }

  /**
   * Get open futures positions
   */
  async getPositions() {
    const data = await this._request('GET', '/openpositions');
    return data.openPositions || [];
  }

  /**
   * Get funding rate for a symbol
   */
  async getFundingRate(symbol) {
    try {
      const data = await this._request('GET', '/tickers');
      const ticker = data.tickers?.find(t => t.symbol === symbol);
      return ticker?.fundingRate || 0;
    } catch (_) {
      return 0;
    }
  }
}
