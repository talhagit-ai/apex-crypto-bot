// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Signal Generation
//  Long + Short signals, 6-factor confirmation, multi-TF regime
// ═══════════════════════════════════════════════════════════════

import { ema, rsi, calcATR, calcADX, macdH, vwap, volumeRatio, atrPercentile, volatilityRegime, detectDivergence, detectBreakout, heikinAshi, haColorStreak, bollingerBands, keltnerChannels, bbKcSqueeze, ichimoku, mtfAlignment } from './indicators.mjs';
import { ADX_MIN, SLOPE_BARS, MIN_CONF, MIN_RR, VWAP_WINDOW, FACTOR_WEIGHTS, FACTOR_WEIGHT_MAX, VR_THRESHOLD, FEE_RATE } from './config.mjs';

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
export function generateSignal(asset, closes, highs, lows, volumes, regimeOK, opts = {}, regimeData = null, tf15Data = null) {
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

  // V16: volatile is nu een quality penalty, niet een hard block
  // Data toont: TP wordt vaker bereikt in volatile markten (prijs beweegt daadwerkelijk)
  const volRegime = volatilityRegime(closes, highs, lows);

  // ADX must not be collapsing: allow up to 20% decline over 30 min (5% was too strict —
  // in slow bull grind, 5m ADX oscillates and was blocking all signals for 18+ hours)
  if (closes.length > 120) {
    const ADX_prev = calcADX(highs.slice(0, -6), lows.slice(0, -6), closes.slice(0, -6), 14);
    if (ADX < ADX_prev * 0.80) return null;
  }

  // Price must be above EMA50 (confirms bullish bias, symmetric with short's cur < e50)
  if (cur < e50[n]) return null;

  // Multi-TF: reject if regime (1H) close below 1H EMA8
  if (regimeData && regimeData.closes.length >= 50) {
    const re8 = ema(regimeData.closes, 8);
    const rn  = regimeData.closes.length - 1;
    if (regimeData.closes[rn] < re8[rn]) return null;
  }

  // Regime strength: calculated for quality scoring and position sizing
  const rs = regimeStrength(closes, highs, lows);

  const f1 = e8[n] > e13[n] && e13[n] > e21[n];  // EMA stack bull
  const f2 = cur > VWAP;                           // Above VWAP
  const f3 = RSI > 42 && RSI < 68;                 // RSI sweet spot
  const f4 = MH > MH1;                             // MACD rising
  const f5 = VR >= VR_THRESHOLD;                     // Volume above average (V11: 1.15, was 1.05)
  const f6 = RSI > RSI2 && RSI2 > RSI3;           // RSI accelerating up

  // Weighted quality score (max = FACTOR_WEIGHT_MAX ≈ 5.0)
  const W = FACTOR_WEIGHTS;
  let qualityScore = (f1?W.emaStack:0) + (f2?W.vwap:0) + (f3?W.rsi:0) + (f4?W.macd:0) + (f5?W.volume:0) + (f6?W.rsiAccel:0);

  // V11: Pullback quality — entry op pullback i.p.v. momentum chase
  const recentLow = Math.min(...closes.slice(-7, -1).map((c, i) => {
    const slc = closes.slice(0, closes.length - 6 + i);
    return slc.length >= 14 ? rsi(slc, 14) : 50;
  }));
  // Divergence detection (used for pullback AND quality scoring)
  const { bullDiv, bearDiv } = detectDivergence(closes);
  if (recentLow < 40 || bullDiv) qualityScore += 0.4;  // V13: pullback bonus (verlaagd van 0.6)
  // V13: momentum penalty verwijderd — in trending markten is momentum entry vaak correct

  // Volatility regime quality adjustments (ranging = penalty, clean_trend = bonus)
  if (volRegime === 'ranging')     qualityScore -= 0.5;
  if (volRegime === 'volatile')    qualityScore -= 0.8;  // V16: penalty i.p.v. hard block
  if (volRegime === 'clean_trend') qualityScore += 0.4;

  // Regime strength: weakening trend = penalty (was hard block, now soft)
  if (rs.weakening) qualityScore -= 0.4;
  if (rs.strengthening) qualityScore += 0.3;

  // V21: 15m HARD gate (NFIX-inspired) — voorkomt signals tegen 15m trend
  // Bonus bij aligned, REJECT als 15m sterk bearish
  if (tf15Data && tf15Data.closes.length >= 30) {
    const e8_15  = ema(tf15Data.closes, 8);
    const e21_15 = ema(tf15Data.closes, 21);
    const n15    = tf15Data.closes.length - 1;
    const aligned = e8_15[n15] > e21_15[n15];
    // HARD gate: 15m trend tegen long + spread > 0.5% = reject
    const spread = (e21_15[n15] - e8_15[n15]) / e21_15[n15];
    if (!aligned && spread > 0.005) return null;
    if (aligned) qualityScore += 0.5;
    else          qualityScore -= 0.3;
  }

  // Divergence quality adjustment
  if (bullDiv) qualityScore += 0.5;
  if (bearDiv) qualityScore -= 0.3; // bearish div weakens long signal

  // Breakout bonus: consolidation → breakout = high-probability entry
  const breakout = detectBreakout(closes, highs, lows);
  if (breakout.breakout && breakout.direction === 'bull') {
    qualityScore += 0.8 * breakout.strength; // up to +0.8
  }

  // V30 LONG: Heikin-Ashi color streak (smoothed trend confirmation)
  const opensSeed = opts._opens || closes; // engine doesn't always pass opens; fall back
  const ha = heikinAshi(opensSeed, highs, lows, closes);
  const streak = haColorStreak(ha.haOpen, ha.haClose);
  if (streak >= 5)      qualityScore += 0.8;
  else if (streak >= 3) qualityScore += 0.5;
  else if (streak <= -3) qualityScore -= 0.5;

  // V30 LONG: BB-KC Squeeze release (breakout proxy)
  const sq = bbKcSqueeze(closes, highs, lows);
  if (sq.bb && cur > sq.bb.upper) qualityScore += 0.7;       // breaking out top BB
  else if (sq.squeeze)            qualityScore += 0.3;       // in squeeze, anticipate

  // V30 LONG: Ichimoku 1h cloud (use regimeData if 1h available)
  if (regimeData && regimeData.closes.length >= 80) {
    const ich = ichimoku(regimeData.highs, regimeData.lows, regimeData.closes);
    if (ich.priceAboveCloud && ich.cloudBull) qualityScore += 0.6;
    else if (ich.priceBelowCloud)             qualityScore -= 0.4;
  }

  // V30 LONG: Multi-timeframe alignment (5m + 15m + 1h)
  if (tf15Data && regimeData) {
    const mtf = mtfAlignment(closes, tf15Data.closes, regimeData.closes);
    qualityScore += mtf * 0.35; // -1.05 to +1.05
  }

  const conf = Math.round(qualityScore / FACTOR_WEIGHT_MAX * 6); // normalized 0-6

  // Growth mode: dynamic MIN_CONF (V11: floor op 4, niet 3)
  const minConf = opts.MIN_CONF ?? MIN_CONF;
  let effectiveMinConf = minConf;
  if (opts.growthMode && ADX > 30 && rs.strengthening) {
    effectiveMinConf = Math.max(4, minConf - 1); // conf=4 minimum (was 3)
  }
  if (conf < effectiveMinConf) return null;

  // ATR percentile for dynamic TP + volatility-adjusted sizing
  const atrPctile = atrPercentile(highs, lows, closes);

  // V19: Anti-chop filter — reject extreme ATR percentiles hard
  // Te lage ATR = geen beweging = fees eten winst op
  // Te hoge ATR = whipsaw, SL wordt sneller geraakt
  if (atrPctile < 8) return null;   // volledig dode markt
  if (atrPctile > 92 && ADX < 28) return null;  // extreme vol zonder trend = chaos

  // ATR extremes = poor entry timing (quality penalty)
  if (atrPctile > 85) qualityScore -= 0.6;  // extreme vol = whipsaw risk
  if (atrPctile < 10 && ADX < 22) qualityScore -= 0.4;  // dead market chop

  // V33: Asymmetric SL/TP per regime — strong trend krijgt wijdere TP
  // Strong-trend (ADX>30): TP boost 25%, SL tighter 10%
  // Normal-trend (ADX 20-30): baseline
  // Weak (ADX<20): TP shorter (sneller verzilveren), SL wider
  let dynTpM = asset.tpM;
  let dynSlM = asset.slM;
  if (ADX > 30) {
    dynTpM *= 1.25;
    dynSlM *= 0.90;
  } else if (ADX < 20) {
    dynTpM *= 0.85;
    dynSlM *= 1.10;
  }
  if (breakout.breakout) dynTpM *= 1.20;
  if (atrPctile > 70) dynTpM *= 1.10;

  const sl    = cur - ATR * dynSlM;
  const tp    = cur + ATR * dynTpM;
  const slDist = Math.abs(cur - sl);
  const tpDist = Math.abs(tp - cur);
  const rr    = tpDist / Math.max(slDist, 1e-9);

  const minRR = opts.MIN_RR ?? MIN_RR;
  if (rr < minRR) return null;

  // V21: Fee-aware filter (NFIX-inspired) — TP-afstand moet > 3× round-trip fee zijn
  // Voorkomt entries waar fees ~25%+ van winst opeten
  const feeCost = 2 * FEE_RATE;  // round-trip als % van notional
  const tpPct = tpDist / cur;    // TP-afstand als % van prijs
  if (tpPct < feeCost * 3) return null;

  // V19: score 0-100 (bouwlijst): EMA 25 + VWAP 20 + RSI 15 + MACD 15 + Vol 15 + RSIspd 10
  const score100 = Math.round(
    (f1 ? 25 : 0) + (f2 ? 20 : 0) + (f3 ? 15 : 0) +
    (f4 ? 15 : 0) + (f5 ? 15 : 0) + (f6 ? 10 : 0)
  );

  return {
    action: 'BUY',
    side:   'long',
    asset:  asset.id,
    conf, qualityScore: +qualityScore.toFixed(2), rr: +rr.toFixed(2),
    score100,
    price: cur,
    sl:    +sl.toFixed(asset.pricePrecision),
    tp:    +tp.toFixed(asset.pricePrecision),
    atr:   ATR,
    atrPercentile: +atrPctile.toFixed(0),
    volRegime,
    regimeStrength:      +rs.strength.toFixed(2),
    regimeStrengthening: rs.strengthening,
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
export function generateShortSignal(asset, closes, highs, lows, volumes, regimeOK, opts = {}, regimeData = null, tf15Data = null) {
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

  // V16: volatile is nu een quality penalty, niet een hard block
  const volRegime = volatilityRegime(closes, highs, lows);

  // ADX must not be collapsing: allow up to 20% decline (same as long signal)
  if (closes.length > 120) {
    const ADX_prev = calcADX(highs.slice(0, -6), lows.slice(0, -6), closes.slice(0, -6), 14);
    if (ADX < ADX_prev * 0.80) return null;
  }

  // Multi-TF: reject if regime (1H) close above 1H EMA8
  if (regimeData && regimeData.closes.length >= 50) {
    const re8 = ema(regimeData.closes, 8);
    const rn  = regimeData.closes.length - 1;
    if (regimeData.closes[rn] > re8[rn]) return null;
  }

  // Regime strength: calculated for quality scoring and position sizing
  const rs = regimeStrength(closes, highs, lows);

  // ── 6-Factor Bearish Confirmation ─────────────────────────
  const f1 = e8[n] < e13[n] && e13[n] < e21[n];  // EMA stack bear
  const f2 = cur < VWAP;                           // Below VWAP
  const f3 = RSI > 32 && RSI < 58;                 // RSI sweet spot (symmetric with long 42-68)
  const f4 = MH < MH1;                             // MACD falling
  const f5 = VR >= VR_THRESHOLD;                     // Volume above average (V11: 1.15, was 1.05)
  const f6 = RSI < RSI2 && RSI2 < RSI3;           // RSI accelerating down

  // Weighted quality score
  const W = FACTOR_WEIGHTS;
  let qualityScore = (f1?W.emaStack:0) + (f2?W.vwap:0) + (f3?W.rsi:0) + (f4?W.macd:0) + (f5?W.volume:0) + (f6?W.rsiAccel:0);

  // V11: Pullback quality — entry op bounce i.p.v. momentum chase (SHORT versie)
  const recentHigh = Math.max(...closes.slice(-7, -1).map((c, i) => {
    const slc = closes.slice(0, closes.length - 6 + i);
    return slc.length >= 14 ? rsi(slc, 14) : 50;
  }));
  // Divergence detection (used for pullback AND quality scoring)
  const { bullDiv, bearDiv } = detectDivergence(closes);
  if (recentHigh > 60 || bearDiv) qualityScore += 0.4;  // V13: bounce bonus (verlaagd van 0.6)
  // V13: momentum penalty verwijderd

  // Volatility regime quality adjustments
  if (volRegime === 'ranging')     qualityScore -= 0.5;
  if (volRegime === 'volatile')    qualityScore -= 0.8;  // V16: penalty i.p.v. hard block
  if (volRegime === 'clean_trend') qualityScore += 0.4;

  // Regime strength: weakening downtrend = penalty (was hard block, now soft)
  if (rs.weakening) qualityScore -= 0.4;
  if (rs.strengthening) qualityScore += 0.3;

  // V21: 15m HARD gate voor shorts (tegen bullish 15m trend = reject)
  if (tf15Data && tf15Data.closes.length >= 30) {
    const e8_15  = ema(tf15Data.closes, 8);
    const e21_15 = ema(tf15Data.closes, 21);
    const n15    = tf15Data.closes.length - 1;
    const aligned = e8_15[n15] < e21_15[n15];
    const spread = (e8_15[n15] - e21_15[n15]) / e21_15[n15];
    if (!aligned && spread > 0.005) return null;
    if (aligned) qualityScore += 0.5;
    else          qualityScore -= 0.3;
  }

  // Divergence quality adjustment
  if (bearDiv) qualityScore += 0.5;
  if (bullDiv) qualityScore -= 0.3; // bullish div weakens short signal

  // Breakout bonus: bearish breakout = high-probability short entry
  const breakout = detectBreakout(closes, highs, lows);
  if (breakout.breakout && breakout.direction === 'bear') {
    qualityScore += 0.8 * breakout.strength;
  }

  // V30 SHORT: Heikin-Ashi color streak (red streak = bearish momentum)
  const opensSeed = opts._opens || closes;
  const ha = heikinAshi(opensSeed, highs, lows, closes);
  const streak = haColorStreak(ha.haOpen, ha.haClose);
  if (streak <= -5)     qualityScore += 0.8;
  else if (streak <= -3) qualityScore += 0.5;
  else if (streak >= 3)  qualityScore -= 0.5;

  // V30 SHORT: BB-KC Squeeze release (breakdown)
  const sq = bbKcSqueeze(closes, highs, lows);
  if (sq.bb && cur < sq.bb.lower) qualityScore += 0.7;
  else if (sq.squeeze)            qualityScore += 0.3;

  // V30 SHORT: Ichimoku 1h cloud (price below + bear cloud = strong short)
  if (regimeData && regimeData.closes.length >= 80) {
    const ich = ichimoku(regimeData.highs, regimeData.lows, regimeData.closes);
    if (ich.priceBelowCloud && !ich.cloudBull) qualityScore += 0.6;
    else if (ich.priceAboveCloud)              qualityScore -= 0.4;
  }

  // V30 SHORT: Multi-timeframe alignment (negative score = bear stack)
  if (tf15Data && regimeData) {
    const mtf = mtfAlignment(closes, tf15Data.closes, regimeData.closes);
    qualityScore += -mtf * 0.35; // bear: invert score
  }

  const conf = Math.round(qualityScore / FACTOR_WEIGHT_MAX * 6);

  // Growth mode: dynamic MIN_CONF (V11: floor op 4, niet 3)
  const minConf = opts.MIN_CONF ?? MIN_CONF;
  let effectiveMinConf = minConf;
  if (opts.growthMode && ADX > 30 && rs.strengthening) {
    effectiveMinConf = Math.max(4, minConf - 1); // conf=4 minimum (was 3)
  }
  if (conf < effectiveMinConf) return null;

  const atrPctile = atrPercentile(highs, lows, closes);

  // ATR extremes = poor entry timing
  if (atrPctile > 85) qualityScore -= 0.6;
  if (atrPctile < 10 && ADX < 22) qualityScore -= 0.4;

  // V33: Asymmetric SL/TP per regime — strong trend krijgt wijdere TP
  let dynTpM = asset.tpM;
  let dynSlM = asset.slM;
  if (ADX > 30) {
    dynTpM *= 1.25;
    dynSlM *= 0.90;
  } else if (ADX < 20) {
    dynTpM *= 0.85;
    dynSlM *= 1.10;
  }
  if (breakout.breakout) dynTpM *= 1.20;
  if (atrPctile > 70) dynTpM *= 1.10;

  // Short: SL above entry, TP below entry
  const sl    = cur + ATR * dynSlM;
  const tp    = cur - ATR * dynTpM;
  const slDist = Math.abs(sl - cur);
  const tpDist = Math.abs(cur - tp);
  const rr    = tpDist / Math.max(slDist, 1e-9);

  const minRR = opts.MIN_RR ?? MIN_RR;
  if (rr < minRR) return null;

  // V21: Fee-aware filter voor shorts
  const feeCost = 2 * FEE_RATE;
  const tpPct = tpDist / cur;
  if (tpPct < feeCost * 3) return null;

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
    regimeStrength:      +rs.strength.toFixed(2),
    regimeStrengthening: rs.strengthening,
    factors: { f1, f2, f3, f4, f5, f6 },
    indicators: {
      rsi: +RSI.toFixed(1), adx: +ADX.toFixed(1),
      macdH: +MH.toFixed(6), vr: +VR.toFixed(2),
    },
    timestamp: Date.now(),
  };
}
