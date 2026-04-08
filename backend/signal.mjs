// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Signal Generation
//  Long + Short signals, 6-factor confirmation, multi-TF regime
// ═══════════════════════════════════════════════════════════════

import { ema, rsi, calcATR, calcADX, macdH, vwap, volumeRatio, atrPercentile, volatilityRegime, detectDivergence } from './indicators.mjs';
import { ADX_MIN, SLOPE_BARS, MIN_CONF, MIN_RR, VWAP_WINDOW, FACTOR_WEIGHTS, FACTOR_WEIGHT_MAX } from './config.mjs';

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

// ── Regime Strength ───────────────────────────────────────────

/**
 * Assess how strong the current trend is (0-1 scale)
 * Returns { strength, weakening, strengthening }
 */
export function regimeStrength(closes, highs, lows) {
  if (closes.length < 60) return { strength: 0.5, weakening: false, strengthening: false };
  const n = closes.length - 1;
  const e8  = ema(closes, 8);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const adx = calcADX(highs, lows, closes, 14);
  const emaSpread = (e8[n] - e21[n]) / closes[n] * 100;
  const slopeNorm = (e50[n] - e50[Math.max(0, n - 10)]) / closes[n] * 100;

  const strength = (adx / 100) * 0.4 + Math.min(Math.abs(emaSpread), 2) / 2 * 0.3 + Math.min(Math.abs(slopeNorm), 1) * 0.3;
  return {
    strength,
    weakening: adx < 25 && Math.abs(emaSpread) < 0.3 && Math.abs(emaSpread) > 0,
    strengthening: adx > 30 && Math.abs(emaSpread) > 0.5,
  };
}

// ── Signal Generators ──────────────────────────────────────────

/**
 * LONG signal — proven APEX edge (6-factor)
 */
export function generateSignal(asset, closes, highs, lows, volumes, regimeOK, opts = {}, regimeData = null) {
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

  // Use 1H ATR for SL/TP if available (more stable than 5m ATR)
  const ATR_SL = (regimeData && regimeData.highs.length >= 14)
    ? calcATR(regimeData.highs, regimeData.lows, regimeData.closes, 14)
    : ATR;

  if (ADX < ADX_MIN) return null;

  // Volatility regime filter: skip choppy/volatile markets
  const volRegime = volatilityRegime(closes, highs, lows);
  if (volRegime === 'volatile' || volRegime === 'ranging') return null;

  // ADX must be rising over 6 bars (30 min, with 5% tolerance)
  const ADX_prev = calcADX(highs.slice(0, -6), lows.slice(0, -6), closes.slice(0, -6), 14);
  if (ADX < ADX_prev * 0.95) return null;

  // Price must be above EMA50 (confirms bullish bias, symmetric with short's cur < e50)
  if (cur < e50[n]) return null;

  // Multi-TF: reject if regime (1H) close below 1H EMA8
  if (regimeData && regimeData.closes.length >= 10) {
    const re8 = ema(regimeData.closes, 8);
    const rn  = regimeData.closes.length - 1;
    if (regimeData.closes[rn] < re8[rn]) return null;
  }

  // Regime strength: skip if trend is weakening
  const rs = regimeStrength(closes, highs, lows);
  if (rs.weakening) return null;

  const f1 = e8[n] > e13[n] && e13[n] > e21[n];  // EMA stack bull
  const f2 = cur > VWAP;                           // Above VWAP
  const f3 = RSI > 42 && RSI < 68;                 // RSI sweet spot
  const f4 = MH > MH1;                             // MACD rising
  const f5 = VR >= 1.2;                            // Volume above average (real confirmation)
  const f6 = RSI > RSI2 && RSI2 > RSI3;           // RSI accelerating up

  // Weighted quality score (max = FACTOR_WEIGHT_MAX ≈ 5.0)
  const W = FACTOR_WEIGHTS;
  let qualityScore = (f1?W.emaStack:0) + (f2?W.vwap:0) + (f3?W.rsi:0) + (f4?W.macd:0) + (f5?W.volume:0) + (f6?W.rsiAccel:0);

  // Divergence bonus: bullish divergence = extra quality
  const { bullDiv, bearDiv } = detectDivergence(closes);
  if (bullDiv) qualityScore += 0.5;
  if (bearDiv) qualityScore -= 0.3; // bearish div weakens long signal

  const conf = Math.round(qualityScore / FACTOR_WEIGHT_MAX * 6); // normalized 0-6

  const minConf = opts.MIN_CONF ?? MIN_CONF;
  if (conf < minConf) return null;
  if (RSI > 68) return null; // don't chase

  // ATR percentile for dynamic TP + volatility-adjusted sizing
  const atrPctile = atrPercentile(highs, lows, closes);

  // Dynamic TP: tighter in low vol, wider in high vol
  let dynTpM = asset.tpM;
  if (atrPctile < 30) dynTpM *= 0.80;
  else if (atrPctile > 70) dynTpM *= 1.15;

  const sl    = cur - ATR_SL * asset.slM;
  const tp    = cur + ATR_SL * dynTpM;
  const slDist = Math.abs(cur - sl);
  const tpDist = Math.abs(tp - cur);
  const rr    = tpDist / Math.max(slDist, 1e-9);

  const minRR = opts.MIN_RR ?? MIN_RR;
  if (rr < minRR) return null;

  return {
    action: 'BUY',
    side:   'long',
    asset:  asset.id,
    conf, qualityScore: +qualityScore.toFixed(2), rr: +rr.toFixed(2),
    price: cur,
    sl:    +sl.toFixed(asset.pricePrecision),
    tp:    +tp.toFixed(asset.pricePrecision),
    atr:   ATR,
    atrPercentile: +atrPctile.toFixed(0),
    volRegime,
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
export function generateShortSignal(asset, closes, highs, lows, volumes, regimeOK, opts = {}, regimeData = null) {
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

  // Use 1H ATR for SL/TP if available
  const ATR_SL = (regimeData && regimeData.highs.length >= 14)
    ? calcATR(regimeData.highs, regimeData.lows, regimeData.closes, 14)
    : ATR;

  // Pre-filter: below EMA50 + trending
  if (ADX < ADX_MIN || cur > e50[n]) return null;

  // Volatility regime filter
  const volRegime = volatilityRegime(closes, highs, lows);
  if (volRegime === 'volatile' || volRegime === 'ranging') return null;

  // ADX must be rising over 6 bars (30 min, with 5% tolerance)
  const ADX_prev = calcADX(highs.slice(0, -6), lows.slice(0, -6), closes.slice(0, -6), 14);
  if (ADX < ADX_prev * 0.95) return null;

  // Multi-TF: reject if regime (1H) close above 1H EMA8
  if (regimeData && regimeData.closes.length >= 10) {
    const re8 = ema(regimeData.closes, 8);
    const rn  = regimeData.closes.length - 1;
    if (regimeData.closes[rn] > re8[rn]) return null;
  }

  // Regime strength: skip if downtrend is weakening
  const rs = regimeStrength(closes, highs, lows);
  if (rs.weakening) return null;

  // ── 6-Factor Bearish Confirmation ─────────────────────────
  const f1 = e8[n] < e13[n] && e13[n] < e21[n];  // EMA stack bear
  const f2 = cur < VWAP;                           // Below VWAP
  const f3 = RSI > 32 && RSI < 58;                 // RSI sweet spot (symmetric with long 42-68)
  const f4 = MH < MH1;                             // MACD falling
  const f5 = VR >= 1.2;                            // Volume above average (real confirmation)
  const f6 = RSI < RSI2 && RSI2 < RSI3;           // RSI accelerating down

  // Weighted quality score
  const W = FACTOR_WEIGHTS;
  let qualityScore = (f1?W.emaStack:0) + (f2?W.vwap:0) + (f3?W.rsi:0) + (f4?W.macd:0) + (f5?W.volume:0) + (f6?W.rsiAccel:0);

  // Divergence bonus: bearish divergence = extra quality for short
  const { bullDiv, bearDiv } = detectDivergence(closes);
  if (bearDiv) qualityScore += 0.5;
  if (bullDiv) qualityScore -= 0.3; // bullish div weakens short signal

  const conf = Math.round(qualityScore / FACTOR_WEIGHT_MAX * 6);

  const minConf = opts.MIN_CONF ?? MIN_CONF;
  if (conf < minConf) return null;
  if (RSI < 32) return null; // don't chase oversold

  const atrPctile = atrPercentile(highs, lows, closes);

  // Dynamic TP
  let dynTpM = asset.tpM;
  if (atrPctile < 30) dynTpM *= 0.80;
  else if (atrPctile > 70) dynTpM *= 1.15;

  // Short: SL above entry, TP below entry
  const sl    = cur + ATR_SL * asset.slM;
  const tp    = cur - ATR_SL * dynTpM;
  const slDist = Math.abs(sl - cur);
  const tpDist = Math.abs(cur - tp);
  const rr    = tpDist / Math.max(slDist, 1e-9);

  const minRR = opts.MIN_RR ?? MIN_RR;
  if (rr < minRR) return null;

  return {
    action: 'SELL',
    side:   'short',
    asset:  asset.id,
    conf, qualityScore: +qualityScore.toFixed(2), rr: +rr.toFixed(2),
    price: cur,
    sl:    +sl.toFixed(asset.pricePrecision),
    tp:    +tp.toFixed(asset.pricePrecision),
    atr:   ATR,
    atrPercentile: +atrPctile.toFixed(0),
    volRegime,
    factors: { f1, f2, f3, f4, f5, f6 },
    indicators: {
      rsi: +RSI.toFixed(1), adx: +ADX.toFixed(1),
      macdH: +MH.toFixed(6), vr: +VR.toFixed(2),
    },
    timestamp: Date.now(),
  };
}
