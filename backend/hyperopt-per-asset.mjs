// ═══════════════════════════════════════════════════════════════
//  APEX Hyperopt Per-Asset (V26)
//  Run hyperopt on each asset INDIVIDUALLY → unique optimal params per asset.
//  SOL ≠ AVAX ≠ DOGE — verschillende ATR, volume, regime-cycli.
//  Output: cache/per-asset-params.json (gebruikt door engine via overrideParams.assets)
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import { TradingEngine } from './engine.mjs';
import { ASSETS } from './config.mjs';
import { setLevel } from './logger.mjs';

setLevel(process.env.LOG_LEVEL || 'warn');

const CACHE_DIR = './cache';
const START = 200;
const LOOKBACK = 80;

async function loadCache() {
  const data = {};
  for (const a of ASSETS) {
    try {
      const raw = await fs.readFile(`${CACHE_DIR}/${a.id}.json`, 'utf8');
      const cached = JSON.parse(raw);
      if (cached.bars?.length >= 100) data[a.id] = cached.bars;
    } catch (_) {}
  }
  return data;
}

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

function buildBarData(assetId, bars5, bars15, bars60, idx5m) {
  const start = Math.max(0, idx5m - LOOKBACK + 1);
  const slice5 = bars5.slice(start, idx5m + 1);
  if (slice5.length < 30) return null;
  const t5 = slice5[slice5.length - 1].t;
  const b15 = bars15.filter(x => x.t <= t5).slice(-80);
  const b60 = bars60.filter(x => x.t <= t5).slice(-72);
  const barData = { [assetId]: {
    closes: slice5.map(x=>x.c), highs: slice5.map(x=>x.h),
    lows: slice5.map(x=>x.l), volumes: slice5.map(x=>x.v),
  }};
  const tf15Data = b15.length >= 30 ? { [assetId]: {
    closes: b15.map(x=>x.c), highs: b15.map(x=>x.h), lows: b15.map(x=>x.l), volumes: b15.map(x=>x.v),
  }} : {};
  const regimeData = b60.length >= 24 ? { [assetId]: {
    closes: b60.map(x=>x.c), highs: b60.map(x=>x.h), lows: b60.map(x=>x.l),
  }} : {};
  return { barData, regimeData, tf15Data };
}

function runSingleAsset(asset, bars5, bars15, bars60, params) {
  const filteredAssets = [asset];
  const engine = new TradingEngine(START, {
    growthMode: true, simMode: true,
    overrideAssets: filteredAssets,
    overrideParams: params,
  });
  for (let i = LOOKBACK; i < bars5.length; i++) {
    const data = buildBarData(asset.id, bars5, bars15, bars60, i);
    if (!data) continue;
    try { engine.tick(data.barData, data.regimeData, data.tf15Data); } catch(_) {}
  }
  const finalPrice = bars5[bars5.length - 1].c;
  for (const id of Object.keys(engine.positions)) {
    engine._closePosition(id, finalPrice, 'BT_END');
  }
  const finalEq = engine.equity({ [asset.id]: finalPrice });
  const exits = engine.trades.filter(t => ['SELL','COVER'].includes(t.side));
  const wins = exits.filter(t => (t.pnl || 0) > 0);
  const grossWin = wins.reduce((s,t)=>s+(t.pnl||0),0);
  const grossLoss = Math.abs(exits.filter(t=>(t.pnl||0)<0).reduce((s,t)=>s+(t.pnl||0),0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
  let peak = START, eq = START, maxDD = 0;
  for (const t of engine.trades) {
    if (['SELL','COVER','PARTIAL1','PARTIAL2'].includes(t.side)) eq += (t.pnl || 0);
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  return {
    ret: +(((finalEq/START)-1)*100).toFixed(2),
    trades: exits.length,
    wr: exits.length ? +(wins.length/exits.length*100).toFixed(1) : 0,
    pf: +pf.toFixed(2),
    maxDD: +(maxDD*100).toFixed(2),
  };
}

// ── Build grid ─────────────────────────────────────────────────
const grid = [];
const partial1Rs = [0.75, 1.0, 1.25, 1.5];
const trailRs = [0.6, 0.8, 1.0, 1.25];
const trailATRs = [1.5, 2.0, 2.5];
const minRRs = [1.5, 1.8, 2.0];
for (const p1 of partial1Rs)
  for (const tr of trailRs)
    for (const ta of trailATRs)
      for (const rr of minRRs)
        grid.push({
          PARTIAL1_R: p1, PARTIAL2_R: p1 + 0.5,
          TRAIL_R: tr, TRAIL_ATR: ta, MIN_RR: rr,
        });

const labelOf = (c) => `P1=${c.PARTIAL1_R} TR=${c.TRAIL_R} ATR=${c.TRAIL_ATR} RR=${c.MIN_RR}`;

// ── Main ───────────────────────────────────────────────────────
const bars5Map = await loadCache();
console.log(`\n═══ HYPEROPT PER-ASSET (V26) — ${grid.length} configs × ${Object.keys(bars5Map).length} assets ═══\n`);

const perAssetResults = {};
const finalParams = {};
for (const asset of ASSETS) {
  const bars5 = bars5Map[asset.id];
  if (!bars5) { console.log(`  Skip ${asset.id}: no cache`); continue; }
  const bars15 = aggregate(bars5, 15);
  const bars60 = aggregate(bars5, 60);
  console.log(`▶ ${asset.id}: ${bars5.length} 5m bars, optimizing ${grid.length} configs...`);

  const results = [];
  for (let i = 0; i < grid.length; i++) {
    const r = runSingleAsset(asset, bars5, bars15, bars60, grid[i]);
    results.push({ params: grid[i], ...r });
  }
  // Pick winner: highest return AND PF > 1 AND trades >= 10
  const valid = results.filter(r => r.trades >= 10 && r.pf >= 1.0);
  const sorted = (valid.length ? valid : results).sort((a,b) => b.ret - a.ret);
  const winner = sorted[0];

  perAssetResults[asset.id] = sorted.slice(0, 5);
  finalParams[asset.id] = winner.params;

  console.log(`  WIN: ${labelOf(winner.params)} → ${winner.ret}% / ${winner.trades}t / WR ${winner.wr}% / PF ${winner.pf} / DD ${winner.maxDD}%`);
  if (sorted.length > 1) {
    const r2 = sorted[1];
    console.log(`  #2:  ${labelOf(r2.params)} → ${r2.ret}% / ${r2.trades}t / WR ${r2.wr}% / PF ${r2.pf}`);
  }
}

console.log('\n═══ FINAL PER-ASSET PARAMETERS ═══');
for (const [id, p] of Object.entries(finalParams)) {
  console.log(`  ${id}: P1=${p.PARTIAL1_R} P2=${p.PARTIAL2_R} TR=${p.TRAIL_R} ATR=${p.TRAIL_ATR} RR=${p.MIN_RR}`);
}

await fs.writeFile('./cache/per-asset-params.json', JSON.stringify({
  timestamp: Date.now(),
  finalParams,
  top5PerAsset: perAssetResults,
}, null, 2));
console.log('\n→ Saved: cache/per-asset-params.json');
