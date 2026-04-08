// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V1 — Candle Buffer
//  Rolling 150-bar OHLCV windows per asset, per timeframe
//  Fetches historical data on startup, then extends with live bars
// ═══════════════════════════════════════════════════════════════

import { ASSETS, HISTORY_BARS, CANDLE_INTERVAL, REGIME_INTERVAL } from './config.mjs';
import { log } from './logger.mjs';

/**
 * CandleBuffer — maintains rolling OHLCV arrays for signal generation
 *
 * Usage:
 *   const buf = new CandleBuffer(bybitClient);
 *   await buf.init();                    // fetch history
 *   buf.update('BTCUSDT', '5', candle); // push live bar
 *   const data5m = buf.get('BTCUSDT', '5');
 *   const data1h  = buf.get('BTCUSDT', '60');
 */
export class CandleBuffer {
  constructor(bybitClient) {
    this.client = bybitClient;
    // buffers[assetId][interval] = { closes, highs, lows, volumes, timestamps }
    this.buffers = {};
    this.ready = false;
  }

  /**
   * Fetch historical klines for all assets on both timeframes
   */
  async init() {
    log.info('CandleBuffer: fetching history...');

    const intervals = [CANDLE_INTERVAL, REGIME_INTERVAL];

    for (const asset of ASSETS) {
      this.buffers[asset.id] = {};
      for (const interval of intervals) {
        const bars = await this._fetchHistory(asset, interval);
        this.buffers[asset.id][interval] = bars;
        log.info(`${asset.id} [${interval}m]: ${bars.closes.length} bars loaded`);
      }
    }

    this.ready = true;
    log.info('CandleBuffer: all history loaded ✓');
  }

  /**
   * Push a new completed candle into the buffer
   * Called by bybit-client when a kline closes
   *
   * @param {string} assetId - e.g. 'BTCUSDT'
   * @param {string} interval - '5' or '60'
   * @param {object} candle - { open, high, low, close, volume, timestamp }
   */
  update(assetId, interval, candle) {
    const buf = this.buffers[assetId]?.[interval];
    if (!buf) return;

    // Dedup: skip if timestamp is same or older than last bar
    const lastTs = buf.timestamps[buf.timestamps.length - 1];
    if (lastTs && candle.timestamp <= lastTs) return;

    buf.closes.push(candle.close);
    buf.highs.push(candle.high);
    buf.lows.push(candle.low);
    buf.volumes.push(candle.volume);
    buf.timestamps.push(candle.timestamp);

    // Trim to rolling window
    if (buf.closes.length > HISTORY_BARS) {
      buf.closes.shift();
      buf.highs.shift();
      buf.lows.shift();
      buf.volumes.shift();
      buf.timestamps.shift();
    }
  }

  /**
   * Get bar data for an asset/interval
   * @returns {{ closes, highs, lows, volumes }} or null
   */
  get(assetId, interval) {
    const buf = this.buffers[assetId]?.[interval];
    if (!buf || buf.closes.length < 20) return null;
    return {
      closes:     [...buf.closes],
      highs:      [...buf.highs],
      lows:       [...buf.lows],
      volumes:    [...buf.volumes],
      timestamps: [...buf.timestamps],
    };
  }

  /**
   * Get latest close price for an asset
   */
  lastClose(assetId) {
    const buf = this.buffers[assetId]?.[CANDLE_INTERVAL];
    if (!buf || buf.closes.length === 0) return null;
    return buf.closes[buf.closes.length - 1];
  }

  /**
   * Get all current prices (for equity calculation)
   */
  currentPrices() {
    const prices = {};
    for (const asset of ASSETS) {
      const p = this.lastClose(asset.id);
      if (p) prices[asset.id] = p;
    }
    return prices;
  }

  // ── Private ───────────────────────────────────────────────────

  async _fetchHistory(asset, interval) {
    const limit = HISTORY_BARS;
    const bars = { closes: [], highs: [], lows: [], volumes: [], timestamps: [] };

    try {
      const klines = await this.client.getKlines(asset.symbol, interval, limit);

      // Kraken returns oldest first — already chronological (no reverse needed)
      const sorted = klines.slice();

      for (const k of sorted) {
        bars.timestamps.push(Number(k[0]));
        bars.opens  = bars.opens || [];
        bars.opens.push(Number(k[1]));
        bars.highs.push(Number(k[2]));
        bars.lows.push(Number(k[3]));
        bars.closes.push(Number(k[4]));
        bars.volumes.push(Number(k[5]));
      }
    } catch (err) {
      log.error(`Failed to fetch history for ${asset.id} [${interval}]`, { err: err.message });
    }

    return bars;
  }
}
