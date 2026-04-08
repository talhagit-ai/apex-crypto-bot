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
