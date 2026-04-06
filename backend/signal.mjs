// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Signal Generation
//  Long + Short signals, 6-factor confirmation, multi-TF regime
// ═══════════════════════════════════════════════════════════════

import { ema, rsi, calcATR, calcADX, macdH, vwap, volumeRatio } from './indicators.mjs';
import { ADX_MIN, SLOPE_BARS, MIN_CONF, MIN_RR, VWAP_WINDOW } from './config.mjs';

// ── Regime Filters ─────────────────────────────────────────────

/**
 * Bullish regime (1H): macro uptrend required for LONG entries
 */
export function checkRegime(closes, highs, lows, regimeATR = 0.05) {
  if (closes.length < 60) return false;
  const n   = closes.length - 1;
  const e50 = ema(closes, 50);
  const e21 = ema(closes, 21);
  const e8  = ema(closes, 8);
  const ATR = calcATR(highs, lows, closes, 14);
  const adx = calcADX(highs, lows, closes, 14);

  return (
    e50[n] > e50[Math.max(0, n - SLOPE_BARS)]   // EMA50 rising
    && e8[n] > e21[n]                             // Short above medium
    && adx > ADX_MIN                              // Trending
  );
}

/**
 * Bearish regime (1H): macro downtrend required for SHORT entries
 */
export function checkBearishRegime(closes, highs, lows, regimeATR = 0.05) {
  if (closes.length < 60) return false;
  const n   = closes.length - 1;
  const e50 = ema(closes, 50);
  const e21 = ema(closes, 21);
  const e8  = ema(closes, 8);
  const ATR = calcATR(highs, lows, closes, 14);
  const adx = calcADX(highs, lows, closes, 14);

  return (
    e50[n] < e50[Math.max(0, n - SLOPE_BARS)]   // EMA50 falling (macro downtrend)
    && e8[n] < e21[n]                             // Short below medium
    && adx > ADX_MIN                              // Trending (not sideways)
  );
}

// ── Signal Generators ──────────────────────────────────────────

/**
 * LONG signal — proven APEX edge (6-factor)
 */
export function generateSignal(asset, closes, highs, lows, volumes, regimeOK, opts = {}) {
  if (closes.length < 72) return null;

  const n   = closes.length - 1;
  const cur = closes[n];

  const e8  = ema(closes, 8);
  const e13 = ema(closes, 13);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  const RSI  = rsi(closes, 14);
  const RSI2 = rsi(closes.slice(0, -2), 14);
  const RSI3 = rsi(closes.slice(0, -3), 14);

  const { h: MH, h1: MH1 } = macdH(closes);
  const ATR  = calcATR(highs, lows, closes, 14);
  const ADX  = calcADX(highs, lows, closes, 14);
  const VWAP = vwap(highs, lows, closes, volumes, VWAP_WINDOW);
  const VR   = volumeRatio(volumes, 20);

  if (ADX < ADX_MIN) return null;

  const f1 = e8[n] > e13[n] && e13[n] > e21[n];  // EMA stack bull
  const f2 = cur > VWAP;                           // Above VWAP
  const f3 = RSI > 38 && RSI < 74;                 // RSI sweet spot
  const f4 = MH > MH1;                             // MACD rising
  const f5 = VR >= 0.85;                            // Volume active (crypto 24/7, no big surges needed)
  const f6 = RSI > RSI2 && RSI2 > RSI3;           // RSI accelerating up

  const conf    = [f1, f2, f3, f4, f5, f6].filter(Boolean).length;
  const minConf = opts.MIN_CONF ?? MIN_CONF;
  if (conf < minConf) return null;
  if (RSI > 74) return null; // don't chase

  const sl    = cur - ATR * asset.slM;
  const tp    = cur + ATR * asset.tpM;
  const slDist = Math.abs(cur - sl);
  const tpDist = Math.abs(tp - cur);
  const rr    = tpDist / Math.max(slDist, 1e-9);

  const minRR = opts.MIN_RR ?? MIN_RR;
  if (rr < minRR) return null;

  return {
    action: 'BUY',
    side:   'long',
    asset:  asset.id,
    conf, rr: +rr.toFixed(2),
    price: cur,
    sl:    +sl.toFixed(asset.pricePrecision),
    tp:    +tp.toFixed(asset.pricePrecision),
    atr:   ATR,
    factors: { f1, f2, f3, f4, f5, f6 },
    indicators: {
      rsi: +RSI.toFixed(1), adx: +ADX.toFixed(1),
      macdH: +MH.toFixed(6), vr: +VR.toFixed(2),
    },
    timestamp: Date.now(),
  };
}

/**
 * SHORT signal — mirror of LONG, bearish 6-factor
 */
export function generateShortSignal(asset, closes, highs, lows, volumes, regimeOK, opts = {}) {
  if (closes.length < 72) return null;

  const n   = closes.length - 1;
  const cur = closes[n];

  const e8  = ema(closes, 8);
  const e13 = ema(closes, 13);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);

  const RSI  = rsi(closes, 14);
  const RSI2 = rsi(closes.slice(0, -2), 14);
  const RSI3 = rsi(closes.slice(0, -3), 14);

  const { h: MH, h1: MH1 } = macdH(closes);
  const ATR  = calcATR(highs, lows, closes, 14);
  const ADX  = calcADX(highs, lows, closes, 14);
  const VWAP = vwap(highs, lows, closes, volumes, VWAP_WINDOW);
  const VR   = volumeRatio(volumes, 20);

  // Pre-filter: below EMA50 + trending
  if (ADX < ADX_MIN || cur > e50[n]) return null;

  // ── 6-Factor Bearish Confirmation ─────────────────────────
  const f1 = e8[n] < e13[n] && e13[n] < e21[n];  // EMA stack bear
  const f2 = cur < VWAP;                           // Below VWAP
  const f3 = RSI > 26 && RSI < 62;                 // RSI not oversold yet
  const f4 = MH < MH1;                             // MACD falling
  const f5 = VR >= 0.85;                            // Volume active (crypto 24/7, no big surges needed)
  const f6 = RSI < RSI2 && RSI2 < RSI3;           // RSI accelerating down

  const conf    = [f1, f2, f3, f4, f5, f6].filter(Boolean).length;
  const minConf = opts.MIN_CONF ?? MIN_CONF;
  if (conf < minConf) return null;
  if (RSI < 26) return null; // don't chase oversold

  // Short: SL above entry, TP below entry
  const sl    = cur + ATR * asset.slM;
  const tp    = cur - ATR * asset.tpM;
  const slDist = Math.abs(sl - cur);
  const tpDist = Math.abs(cur - tp);
  const rr    = tpDist / Math.max(slDist, 1e-9);

  const minRR = opts.MIN_RR ?? MIN_RR;
  if (rr < minRR) return null;

  return {
    action: 'SELL',
    side:   'short',
    asset:  asset.id,
    conf, rr: +rr.toFixed(2),
    price: cur,
    sl:    +sl.toFixed(asset.pricePrecision),
    tp:    +tp.toFixed(asset.pricePrecision),
    atr:   ATR,
    factors: { f1, f2, f3, f4, f5, f6 },
    indicators: {
      rsi: +RSI.toFixed(1), adx: +ADX.toFixed(1),
      macdH: +MH.toFixed(6), vr: +VR.toFixed(2),
    },
    timestamp: Date.now(),
  };
}
