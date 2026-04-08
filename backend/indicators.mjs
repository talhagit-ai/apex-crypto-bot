// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V1 — Technical Indicators
//  Extracted from APEX V12 (apex_v13.jsx:46-52)
//  All 7 indicators are 100% generic — work on any asset
// ═══════════════════════════════════════════════════════════════

/**
 * Exponential Moving Average
 * @param {number[]} arr - Close prices
 * @param {number} n - Period (8, 13, 21, 50)
 * @returns {Float64Array}
 */
export function ema(arr, n) {
  const k = 2 / (n + 1);
  const out = new Float64Array(arr.length);
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) {
    out[i] = arr[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

/**
 * Relative Strength Index
 * @param {number[]} arr - Close prices
 * @param {number} n - Period (default 14)
 * @returns {number} RSI value 0-100
 */
export function rsi(arr, n = 14) {
  let g = 0, l = 0;
  const start = Math.max(1, arr.length - n - 1);
  for (let i = start; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  return 100 - 100 / (1 + g / (l || 1e-9));
}

/**
 * Average True Range
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} n - Period (default 14)
 * @returns {number} ATR value
 */
export function calcATR(highs, lows, closes, n = 14) {
  const trs = [];
  const s = Math.max(1, closes.length - n);
  for (let i = s; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length || closes[closes.length - 1] * 0.01;
}

/**
 * Average Directional Index — Wilder's standard (trend strength)
 * Uses proper Wilder smoothing for +DM, -DM, TR, and DX.
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number} n - Period (default 14)
 * @returns {number} ADX value 0-100
 */
export function calcADX(highs, lows, closes, n = 14) {
  // Need at least 2*n+1 bars for a meaningful ADX
  if (closes.length < n * 2 + 1) return 15;

  // Step 1: Raw True Range, +DM, -DM for each bar
  const rawTR = [], rawPDM = [], rawNDM = [];
  for (let i = 1; i < closes.length; i++) {
    rawTR.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
    const up = highs[i] - highs[i - 1];
    const dn = lows[i - 1] - lows[i];
    rawPDM.push(up > dn && up > 0 ? up : 0);
    rawNDM.push(dn > up && dn > 0 ? dn : 0);
  }

  // Step 2: Wilder smooth over n periods (first = SMA, then Wilder)
  const len = rawTR.length;
  const start = len - n * 2; // use last 2*n bars for smoothing
  if (start < 0) return 15;

  // Initial SMA for first smoothed value
  let sTR = 0, sPDM = 0, sNDM = 0;
  for (let i = start; i < start + n; i++) {
    sTR  += rawTR[i];
    sPDM += rawPDM[i];
    sNDM += rawNDM[i];
  }

  // Wilder smooth remaining bars
  const dxValues = [];
  for (let i = start + n; i < len; i++) {
    sTR  = sTR  - sTR / n + rawTR[i];
    sPDM = sPDM - sPDM / n + rawPDM[i];
    sNDM = sNDM - sNDM / n + rawNDM[i];

    const pdi = 100 * sPDM / (sTR || 1e-9);
    const ndi = 100 * sNDM / (sTR || 1e-9);
    const dx  = 100 * Math.abs(pdi - ndi) / ((pdi + ndi) || 1e-9);
    dxValues.push(dx);
  }

  // Step 3: Smooth DX over n periods to get ADX
  if (dxValues.length < n) return dxValues[dxValues.length - 1] || 15;

  let adx = 0;
  for (let i = 0; i < n; i++) adx += dxValues[i];
  adx /= n; // initial SMA

  for (let i = n; i < dxValues.length; i++) {
    adx = (adx * (n - 1) + dxValues[i]) / n; // Wilder smooth
  }

  return adx;
}

/**
 * MACD Histogram (current and previous)
 * @param {number[]} closes
 * @returns {{ h: number, h1: number }}
 */
export function macdH(closes) {
  if (closes.length < 35) return { h: 0, h1: 0 };
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const m = Array.from({ length: closes.length }, (_, i) => e12[i] - e26[i]);
  const s = ema(m, 9);
  const n = closes.length - 1;
  return { h: m[n] - s[n], h1: m[n - 1] - s[n - 1] };
}

/**
 * Volume Weighted Average Price (rolling window)
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number[]} volumes
 * @param {number} window - Lookback bars (default 288 = 24h of 5min)
 * @returns {number} VWAP value
 */
export function vwap(highs, lows, closes, volumes, window = 288) {
  let n = 0, d = 0;
  const cnt = Math.min(closes.length, window);
  for (let i = closes.length - cnt; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    n += tp * volumes[i];
    d += volumes[i];
  }
  return n / (d || 1);
}

/**
 * Volume Ratio (current vs average)
 * @param {number[]} volumes
 * @param {number} n - Lookback period (default 20)
 * @returns {number} Ratio (1.0 = average, >1.0 = above average)
 */
export function volumeRatio(volumes, n = 20) {
  const sl = volumes.slice(-n);
  const avg = sl.reduce((a, b) => a + b, 0) / sl.length;
  return volumes[volumes.length - 1] / (avg || 1);
}

/**
 * Detect RSI/Price Divergence
 * Bullish: price lower low, RSI higher low
 * Bearish: price higher high, RSI lower high
 * @returns {{ bullDiv: boolean, bearDiv: boolean }}
 */
export function detectDivergence(closes, n = 14, lookback = 20) {
  if (closes.length < lookback + n) return { bullDiv: false, bearDiv: false };
  const end = closes.length;
  const start = end - lookback;

  // Find two lowest lows and two highest highs in lookback window
  let lo1 = Infinity, lo1i = start, lo2 = Infinity, lo2i = start;
  let hi1 = -Infinity, hi1i = start, hi2 = -Infinity, hi2i = start;

  for (let i = start; i < end; i++) {
    if (closes[i] < lo1) { lo2 = lo1; lo2i = lo1i; lo1 = closes[i]; lo1i = i; }
    else if (closes[i] < lo2) { lo2 = closes[i]; lo2i = i; }
    if (closes[i] > hi1) { hi2 = hi1; hi2i = hi1i; hi1 = closes[i]; hi1i = i; }
    else if (closes[i] > hi2) { hi2 = closes[i]; hi2i = i; }
  }

  // RSI at those points
  const rsiAtLo1 = rsi(closes.slice(0, lo1i + 1), n);
  const rsiAtLo2 = rsi(closes.slice(0, lo2i + 1), n);
  const rsiAtHi1 = rsi(closes.slice(0, hi1i + 1), n);
  const rsiAtHi2 = rsi(closes.slice(0, hi2i + 1), n);

  // Bullish div: price makes lower low but RSI makes higher low
  const bullDiv = lo1 < lo2 && lo1i > lo2i && rsiAtLo1 > rsiAtLo2;
  // Bearish div: price makes higher high but RSI makes lower high
  const bearDiv = hi1 > hi2 && hi1i > hi2i && rsiAtHi1 < rsiAtHi2;

  return { bullDiv, bearDiv };
}

/**
 * ATR Percentile — where current ATR sits in recent history (0-100)
 * High = volatile, Low = quiet
 */
export function atrPercentile(highs, lows, closes, n = 14, lookback = 50) {
  if (closes.length < n + lookback) return 50; // default if not enough data
  const atrs = [];
  for (let i = 0; i < lookback; i++) {
    const end = closes.length - lookback + i + 1;
    if (end < n + 1) continue;
    atrs.push(calcATR(highs.slice(0, end), lows.slice(0, end), closes.slice(0, end), n));
  }
  const current = calcATR(highs, lows, closes, n);
  const rank = atrs.filter(a => a <= current).length / (atrs.length || 1);
  return rank * 100;
}

/**
 * Volatility Regime — classifies market condition using Kaufman Efficiency Ratio
 * Returns: 'clean_trend' | 'trending' | 'volatile' | 'ranging'
 */
export function volatilityRegime(closes, highs, lows, lookback = 50) {
  if (closes.length < lookback + 1) return 'trending'; // default
  const n = closes.length;
  const netMove = Math.abs(closes[n - 1] - closes[n - lookback]);
  let totalMove = 0;
  for (let i = n - lookback + 1; i < n; i++) {
    totalMove += Math.abs(closes[i] - closes[i - 1]);
  }
  const efficiency = netMove / (totalMove || 1e-9);
  const atrPct = calcATR(highs, lows, closes, 14) / (closes[n - 1] || 1);

  if (efficiency > 0.35 && atrPct < 0.030) return 'clean_trend';  // Crypto: ATR < 3%
  if (efficiency > 0.20) return 'trending';                       // Crypto: lower bar (was 0.25)
  if (atrPct > 0.045) return 'volatile';                          // Crypto: ATR > 4.5% (was 2.5%)
  return 'ranging';
}

/**
 * Breakout Detection — identifies consolidation → breakout patterns
 * Consolidation: price range narrows (ATR decreasing), then suddenly expands.
 * Returns: { breakout: boolean, direction: 'bull'|'bear'|null, strength: 0-1 }
 */
export function detectBreakout(closes, highs, lows, lookback = 20) {
  if (closes.length < lookback + 5) return { breakout: false, direction: null, strength: 0 };
  const n = closes.length;

  // Measure range contraction over lookback window
  const recentHigh = Math.max(...highs.slice(n - lookback, n - 2));
  const recentLow  = Math.min(...lows.slice(n - lookback, n - 2));
  const consolidationRange = recentHigh - recentLow;

  // Current bar's move relative to the consolidation range
  const cur = closes[n - 1];
  const prev = closes[n - 2];
  const barMove = Math.abs(cur - prev);
  const avgBarMove = closes.slice(n - lookback, n - 1)
    .reduce((sum, c, i, arr) => i > 0 ? sum + Math.abs(c - arr[i - 1]) : sum, 0) / (lookback - 1);

  // ATR contraction: compare recent ATR to older ATR
  const recentATR = calcATR(highs.slice(-10), lows.slice(-10), closes.slice(-10), 5);
  const olderATR  = calcATR(highs.slice(-lookback, -10), lows.slice(-lookback, -10), closes.slice(-lookback, -10), 5);
  const atrContracting = recentATR < olderATR * 0.75; // ATR shrank 25%+

  // Breakout: price breaks outside consolidation range with above-average move
  const bullBreak = cur > recentHigh && barMove > avgBarMove * 1.5;
  const bearBreak = cur < recentLow  && barMove > avgBarMove * 1.5;

  if (!atrContracting && !bullBreak && !bearBreak) {
    return { breakout: false, direction: null, strength: 0 };
  }

  const strength = Math.min(1.0, barMove / (consolidationRange || 1));

  if (bullBreak) return { breakout: true, direction: 'bull', strength };
  if (bearBreak) return { breakout: true, direction: 'bear', strength };
  return { breakout: false, direction: null, strength: 0 };
}
