// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Kraken Futures Client
//  REST API for perpetual futures (PF_XBTUSD, PF_ETHUSD, etc.)
//  Docs: https://docs.futures.kraken.com/
// ═══════════════════════════════════════════════════════════════

import crypto from 'crypto';
import { KRAKEN_FUTURES_API_KEY, KRAKEN_FUTURES_API_SECRET } from './config.mjs';
import { log } from './logger.mjs';

const BASE_URL = 'https://futures.kraken.com/derivatives/api/v3';

// Spot → Futures symbol mapping
// Kraken Futures uses USD perpetuals (PF = perpetual futures)
export const FUTURES_SYMBOL = {
  BTCUSDT:  'PF_XBTUSD',
  ETHUSDT:  'PF_ETHUSD',
  SOLUSDT:  'PF_SOLUSD',
  XRPUSDT:  'PF_XRPUSD',
  ADAUSDT:  'PF_ADAUSD',
};

export class KrakenFuturesClient {
  constructor() {
    this.apiKey    = KRAKEN_FUTURES_API_KEY;
    this.apiSecret = KRAKEN_FUTURES_API_SECRET;
    this.enabled   = !!(this.apiKey && this.apiSecret);

    if (!this.enabled) {
      log.warn('Kraken Futures: no API keys configured — short orders will be simulated only');
    }
  }

  // ── Authentication ─────────────────────────────────────────

  _sign(endpoint, nonce, postData = '') {
    // Kraken Futures signing:
    // message = SHA256(postData + nonce + endpoint_without_prefix)
    // signature = base64(HMAC-SHA512(message, base64decode(secret)))
    const endpointPath = endpoint.replace('/derivatives/api/v3', '');
    const message = crypto.createHash('sha256')
      .update(postData + nonce + endpointPath)
      .digest();
    const secret  = Buffer.from(this.apiSecret, 'base64');
    const sig     = crypto.createHmac('sha512', secret).update(message).digest('base64');
    return sig;
  }

  async _request(method, path, params = {}) {
    if (!this.enabled) throw new Error('Futures API keys not configured');

    const nonce    = Date.now().toString();
    const endpoint = `/derivatives/api/v3${path}`;
    let   url      = `${BASE_URL}${path}`;
    let   body     = '';

    if (method === 'GET' && Object.keys(params).length > 0) {
      url += '?' + new URLSearchParams(params).toString();
    } else if (method === 'POST') {
      body = new URLSearchParams(params).toString();
    }

    const sig = this._sign(endpoint, nonce, method === 'POST' ? body : '');

    const res = await fetch(url, {
      method,
      headers: {
        'APIKey':     this.apiKey,
        'Nonce':      nonce,
        'Authent':    sig,
        'Content-Type': method === 'POST' ? 'application/x-www-form-urlencoded' : undefined,
      },
      body: method === 'POST' ? body : undefined,
    });

    const data = await res.json();
    if (data.result !== 'success') {
      throw new Error(`Futures API error: ${JSON.stringify(data.error || data)}`);
    }
    return data;
  }

  // ── REST Methods ───────────────────────────────────────────

  /**
   * Get futures account balance (available margin)
   */
  async getBalance() {
    const data = await this._request('GET', '/accounts');
    const account = data.accounts?.fi?.balances;
    return parseFloat(account?.USD || account?.USDT || 0);
  }

  /**
   * Open a short position (sell futures contract)
   * @param {string} assetId  - e.g. 'BTCUSDT'
   * @param {number} qty      - contract size (in base currency units)
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

    return {
      orderId: data.sendStatus?.order_id || 'unknown',
      symbol,
      side: 'sell',
      qty,
    };
  }

  /**
   * Close a short position (buy to cover)
   * @param {string} assetId
   * @param {number} qty
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

    return {
      orderId: data.sendStatus?.order_id || 'unknown',
      symbol,
      side: 'buy',
      qty,
    };
  }

  /**
   * Get open futures positions
   */
  async getPositions() {
    const data = await this._request('GET', '/openpositions');
    return data.openPositions || [];
  }
}
