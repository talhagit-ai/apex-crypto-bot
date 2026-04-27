// ═══════════════════════════════════════════════════════════════
//  Market Scan — leest cache, bepaalt huidige regime per asset,
//  toont aanbeveling (long/short/skip) op basis van actuele data.
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import { ASSETS, ADX_MIN, SLOPE_BARS } from './config.mjs';
import { ema, calcATR, calcADX } from './indicators.mjs';
import { setLevel } from './logger.mjs';
setLevel('warn');

const CACHE_DIR = './cache';

// Try BTCUSDT + ETHUSDT cache too (zelfs als ze niet in ASSETS zitten)
const SCAN_LIST = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSD', 'AVAXUSD', 'DOGEUSD'];

function aggregate(bars5m, bucketMin) {
  const bucketMs = bucketMin * 60 * 1000;
  const map = new Map();
  for (const b of bars5m) {
    const key = Math.floor(b.t / bucketMs) * bucketMs;
    if (!map.has(key)) map.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    else {
      const a = map.get(key);
      if (b.h > a.h) a.h = b.h;
      if (b.l < a.l) a.l = b.l;
      a.c = b.c;
      a.v += b.v;
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function regimeOf(closes, highs, lows) {
  if (closes.length < 60) return { regime: 'unknown', adx: 0, slope: 0 };
  const n = closes.length - 1;
  const e50 = ema(closes, 50);
  const e21 = ema(closes, 21);
  const e8  = ema(closes, 8);
  const adx = calcADX(highs, lows, closes, 14);
  const slope = (e50[n] - e50[Math.max(0, n - SLOPE_BARS)]) / closes[n] * 100;
  const bull = e50[n] > e50[Math.max(0, n - SLOPE_BARS)] && e8[n] > e21[n] && adx > ADX_MIN;
  const bear = e50[n] < e50[Math.max(0, n - SLOPE_BARS)] && e8[n] < e21[n] && adx > ADX_MIN;
  return {
    regime: bull ? 'bull' : bear ? 'bear' : 'neutral',
    adx: +adx.toFixed(1),
    slope: +slope.toFixed(3),
    e8: +e8[n].toFixed(4), e21: +e21[n].toFixed(4), e50: +e50[n].toFixed(4),
  };
}

function changePct(bars, lookbackBars) {
  if (bars.length < lookbackBars + 1) return 0;
  const now = bars[bars.length - 1].c;
  const past = bars[bars.length - 1 - lookbackBars].c;
  return ((now - past) / past) * 100;
}

console.log('\n═══ MARKET SCAN — huidige regime + price action per asset ═══\n');
console.log('Asset      | Last Bar           | Regime  | ADX  | Slope%  | Δ24h%  | Δ7d%   | Action');
console.log('-'.repeat(110));

const results = [];
for (const id of SCAN_LIST) {
  try {
    const raw = await fs.readFile(`${CACHE_DIR}/${id}.json`, 'utf8');
    const cached = JSON.parse(raw);
    const bars5 = cached.bars;
    if (!bars5 || bars5.length < 100) continue;
    const bars60 = aggregate(bars5, 60);
    if (bars60.length < 60) continue;

    const closes60 = bars60.map(b => b.c);
    const highs60 = bars60.map(b => b.h);
    const lows60 = bars60.map(b => b.l);
    const r1h = regimeOf(closes60, highs60, lows60);

    const change24h = changePct(bars5, 288); // 288 × 5m = 24h
    const change7d  = changePct(bars5, 2016); // 7d
    const lastTs = new Date(bars5[bars5.length - 1].t).toISOString().slice(0, 16);

    let action = 'skip';
    if (r1h.regime === 'bull') action = 'LONG ✓';
    else if (r1h.regime === 'bear') action = 'SHORT (paper)';
    else if (Math.abs(change24h) > 5) action = 'volatile-watch';

    console.log(
      `${id.padEnd(10)} | ${lastTs} | ${r1h.regime.padEnd(7)} | ${String(r1h.adx).padStart(4)} | ${String(r1h.slope).padStart(7)} | ${String(change24h.toFixed(2)).padStart(6)} | ${String(change7d.toFixed(2)).padStart(6)} | ${action}`
    );
    results.push({ id, ...r1h, change24h, change7d, action, lastBar: lastTs });
  } catch (e) {
    console.log(`${id.padEnd(10)} | (no cache or error)`);
  }
}

// Cross-asset: BTC dominance proxy
const btc = results.find(r => r.id === 'BTCUSDT');
const alts = results.filter(r => r.id !== 'BTCUSDT' && r.id !== 'ETHUSDT');
if (btc && alts.length) {
  const altAvg = alts.reduce((s, r) => s + r.change7d, 0) / alts.length;
  const btcRel = btc.change7d - altAvg;
  console.log(`\n--- Cross-asset signaal ---`);
  console.log(`BTC 7d: ${btc.change7d.toFixed(2)}%, Alt avg 7d: ${altAvg.toFixed(2)}%, BTC outperformance: ${btcRel.toFixed(2)}%`);
  if (btcRel > 3) console.log(`→ BTC Season actief (BTC outperformance > +3%) — alts blijven onder druk`);
  else if (btcRel < -3) console.log(`→ Alt Season signaal (BTC underperformance > -3%) — alts kunnen opveren`);
  else console.log(`→ Neutraal cross-flow`);
}

// Aanbeveling
const bullAssets = results.filter(r => r.regime === 'bull');
const bearAssets = results.filter(r => r.regime === 'bear');
const neutralAssets = results.filter(r => r.regime === 'neutral');
console.log(`\n--- Samenvatting ---`);
console.log(`Bull regime (long-able):  ${bullAssets.length} asset(s) — ${bullAssets.map(r=>r.id).join(', ') || '(geen)'}`);
console.log(`Bear regime (paper short):${bearAssets.length} asset(s) — ${bearAssets.map(r=>r.id).join(', ') || '(geen)'}`);
console.log(`Neutral (skip):           ${neutralAssets.length} asset(s) — ${neutralAssets.map(r=>r.id).join(', ') || '(geen)'}`);

await fs.writeFile('./cache/market-scan.json', JSON.stringify({ timestamp: Date.now(), results }, null, 2));
console.log('\n→ Saved: cache/market-scan.json');
