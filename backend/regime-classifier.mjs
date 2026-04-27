// ═══════════════════════════════════════════════════════════════
//  V38 — 4-state regime classifier
//  States: bull-trend | bear-trend | range | transition
//
//  Pragmatische rule-based variant (geen full HMM Viterbi). Gebruikt
//  meerdere features met decisions trees ipv probabilistic inference.
//  Voor V42 LightGBM kunnen we naar echte HMM/probabilistic upgraden.
//
//  Features (op 1h closes):
//    slope     = EMA50 slope over SLOPE_BARS
//    adx       = ADX(14)
//    atrPct    = ATR percentile (vs 50-bar history)
//    bbWidth   = BB width / price (volatility proxy)
//    mtfAlign  = optional 5m+15m+1h alignment (-3..+3)
// ═══════════════════════════════════════════════════════════════

import { ema, calcADX, calcATR, atrPercentile, bollingerBands } from './indicators.mjs';
import { SLOPE_BARS, ADX_MIN } from './config.mjs';

const REGIME_STATES = ['bull-trend', 'bear-trend', 'range', 'transition'];

/**
 * Rich 4-state regime classifier.
 * @returns {{ state, confidence, features }}
 */
export function classifyRegime(closes, highs, lows) {
  if (!closes || closes.length < 60) {
    return { state: 'transition', confidence: 0, features: null };
  }
  const n = closes.length - 1;
  const e50 = ema(closes, 50);
  const slope = (e50[n] - e50[Math.max(0, n - SLOPE_BARS)]) / Math.max(closes[n], 1e-9);
  const adx = calcADX(highs, lows, closes, 14);
  const atrPct = atrPercentile(highs, lows, closes, 50);
  const bb = bollingerBands(closes, 20, 2);
  const bbWidth = (bb.upper - bb.lower) / Math.max(closes[n], 1e-9);

  const features = {
    slope: +slope.toFixed(5),
    adx: +adx.toFixed(1),
    atrPct: +atrPct.toFixed(0),
    bbWidth: +bbWidth.toFixed(5),
  };

  // Decision tree:
  // 1) ADX >= 20: trending. Direction by slope sign.
  // 2) ADX < 12 AND bbWidth small (<2%): range-bound (chop)
  // 3) Else: transition (regime forming or breaking)

  // Volatility-aware bull threshold: in low-vol coins, lower slope qualifies
  const slopeBullThresh = bbWidth > 0.04 ? 0.0008 : 0.0003;
  const slopeBearThresh = bbWidth > 0.04 ? -0.0008 : -0.0003;

  let state, confidence;

  if (adx >= 20) {
    // Trending — confidence from ADX strength
    if (slope > slopeBullThresh) {
      state = 'bull-trend';
      confidence = Math.min(1.0, (adx - 20) / 20 + 0.5);
    } else if (slope < slopeBearThresh) {
      state = 'bear-trend';
      confidence = Math.min(1.0, (adx - 20) / 20 + 0.5);
    } else {
      // High ADX but flat slope — likely trend ending
      state = 'transition';
      confidence = 0.5;
    }
  } else if (adx < 12 && bbWidth < 0.02) {
    // Tight chop — range bound
    state = 'range';
    confidence = Math.min(1.0, (12 - adx) / 12 + 0.3);
  } else {
    // ADX 12-20 = transition zone
    state = 'transition';
    confidence = 0.4 + ((20 - adx) / 8) * 0.2; // 0.4-0.6
  }

  // Boost: if MTF alignment provided (separate calc), upgrade range/transition to trend
  // (caller passes optional alignmentScore via overrideRegime helper if available)

  return { state, confidence: +confidence.toFixed(2), features };
}

/**
 * Compatibility helper: project 4-state regime to 3-state {bull/bear/neutral}
 * voor bestaande engine code paths.
 */
export function regimeToLegacy(state) {
  if (state === 'bull-trend')  return 'bull';
  if (state === 'bear-trend')  return 'bear';
  return 'neutral'; // range + transition treated as neutral
}

/**
 * Decision: should we enter long given new regime state?
 * Range allows micro-entries (mean-reversion only).
 * Transition blocks all (whipsaw zone).
 */
export function regimeAllowsLong(state) {
  return state === 'bull-trend';
}

/**
 * Decision: should we enter short?
 */
export function regimeAllowsShort(state) {
  return state === 'bear-trend';
}

/**
 * Decision: is range-bound regime (use mean-reversion strategy when added)
 */
export function regimeIsRange(state) {
  return state === 'range';
}

export { REGIME_STATES };
