// ═══════════════════════════════════════════════════════════════
//  APEX Hyperopt Extended — load cache, test 40+ configs
//  Bouwt 15m en 1h bars FROM 5m cache (geen extra API calls)
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import { TradingEngine } from './engine.mjs';
import { ASSETS } from './config.mjs';

const CACHE_DIR = './cache';
const START = 200;

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

// Aggregate 5m bars → 15m of 1h
function aggregate(bars5m, bucketMin) {
  const bucketMs = bucketMin * 60 * 1000;
  const map = new Map();
  for (const b of bars5m) {
    const key = Math.floor(b.t / bucketMs) * bucketMs;
    if (!map.has(key)) {
      map.set(key, { t: key, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    } else {
      const a = map.get(key);
      if (b.h > a.h) a.h = b.h;
      if (b.l < a.l) a.l = b.l;
      a.c = b.c;
      a.v += b.v;
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function buildBarData(bars5Map, bars15Map, bars60Map, idx5m, lookback = 80) {
  const barData = {}, regimeData = {}, tf15Data = {};
  for (const a of ASSETS) {
    const b5 = bars5Map[a.id]; if (!b5) continue;
    const start = Math.max(0, idx5m - lookback + 1);
    const slice5 = b5.slice(start, idx5m + 1);
    if (slice5.length < 30) continue;
    barData[a.id] = {
      closes: slice5.map(x => x.c), highs: slice5.map(x => x.h),
      lows:   slice5.map(x => x.l), volumes: slice5.map(x => x.v),
    };
    const t5 = slice5[slice5.length - 1].t;
    const b15 = bars15Map[a.id]?.filter(x => x.t <= t5).slice(-80) || [];
    if (b15.length >= 30) tf15Data[a.id] = {
      closes: b15.map(x=>x.c), highs: b15.map(x=>x.h), lows: b15.map(x=>x.l), volumes: b15.map(x=>x.v),
    };
    const b60 = bars60Map[a.id]?.filter(x => x.t <= t5).slice(-72) || [];
    if (b60.length >= 24) regimeData[a.id] = {
      closes: b60.map(x=>x.c), highs: b60.map(x=>x.h), lows: b60.map(x=>x.l),
    };
  }
  return { barData, regimeData, tf15Data };
}

function runBacktest(bars5Map, bars15Map, bars60Map, params, label) {
  const engine = new TradingEngine(START, {
    growthMode: true, simMode: true,
    overrideParams: params,
  });

  // Gebruik langste asset als tick-clock
  const longest = Object.values(bars5Map).reduce((a, b) => b.length > a.length ? b : a, []);
  const lookback = 80;

  for (let i = lookback; i < longest.length; i++) {
    const { barData, regimeData, tf15Data } = buildBarData(bars5Map, bars15Map, bars60Map, i, lookback);
    try { engine.tick(barData, regimeData, tf15Data); } catch(_) {}
  }

  // Final prices & close open positions
  const finalPrices = {};
  for (const a of ASSETS) {
    const arr = bars5Map[a.id];
    if (arr?.length) finalPrices[a.id] = arr[arr.length - 1].c;
  }
  for (const id of Object.keys(engine.positions)) {
    engine._closePosition(id, finalPrices[id] || engine.positions[id].entry, 'BT_END');
  }
  const finalEq = engine.equity(finalPrices);

  const exits = engine.trades.filter(t => ['SELL','COVER'].includes(t.side));
  const wins  = exits.filter(t => (t.pnl || 0) > 0);
  const grossWin  = wins.reduce((s,t)=>s+(t.pnl||0),0);
  const grossLoss = Math.abs(exits.filter(t=>(t.pnl||0)<0).reduce((s,t)=>s+(t.pnl||0),0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : 999;
  const ret = (finalEq / START - 1) * 100;
  const wr = exits.length ? wins.length / exits.length * 100 : 0;

  // Drawdown approximation
  let peak = START, maxDD = 0, eqNow = START;
  // Reconstruct equity curve from trades
  for (const t of engine.trades) {
    if (['SELL','COVER'].includes(t.side)) eqNow += (t.pnl || 0);
    if (['PARTIAL1','PARTIAL2'].includes(t.side)) eqNow += (t.pnl || 0);
    if (eqNow > peak) peak = eqNow;
    const dd = (peak - eqNow) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    label, params,
    ret: +ret.toFixed(2), trades: exits.length, wr: +wr.toFixed(1), pf: +pf.toFixed(2),
    maxDD: +(maxDD * 100).toFixed(2),
    finalEq: +finalEq.toFixed(2),
  };
}

// ── Main ────────────────────────────────────────────────────────
const bars5Map = await loadCache();
const assetList = Object.keys(bars5Map).sort();
console.log(`\n═══ HYPEROPT-EXT — gebruikt ${assetList.length} assets uit cache ═══`);
for (const a of assetList) {
  const bars = bars5Map[a];
  const days = (bars[bars.length-1].t - bars[0].t) / 86400_000;
  console.log(`  ${a}: ${bars.length} × 5m bars (${days.toFixed(1)}d)`);
}

// Derive 15m en 1h from 5m
const bars15Map = {}, bars60Map = {};
for (const a of assetList) {
  bars15Map[a] = aggregate(bars5Map[a], 15);
  bars60Map[a] = aggregate(bars5Map[a], 60);
}

// Grid search — 30+ combinaties
const configs = [];
const partial1Rs = [0.75, 1.0, 1.25, 1.5];
const trailRs = [0.8, 1.0, 1.25, 1.5];
const trailATRs = [1.5, 2.0, 2.5];
const minRRs = [1.5, 1.8, 2.0];

for (const p1 of partial1Rs) {
  for (const tr of trailRs) {
    for (const ta of trailATRs) {
      for (const rr of minRRs) {
        configs.push({
          PARTIAL1_R: p1, PARTIAL2_R: p1 + 0.5,
          TRAIL_R: tr, TRAIL_ATR: ta, MIN_RR: rr,
        });
      }
    }
  }
}

console.log(`\nTesten ${configs.length} configs...\n`);
const results = [];
let i = 0;
for (const c of configs) {
  i++;
  const label = `P1=${c.PARTIAL1_R} TR=${c.TRAIL_R} ATR=${c.TRAIL_ATR} RR=${c.MIN_RR}`;
  const r = runBacktest(bars5Map, bars15Map, bars60Map, c, label);
  results.push(r);
  if (i % 10 === 0) console.log(`  ${i}/${configs.length} tested...`);
}

results.sort((a, b) => b.ret - a.ret);

console.log('\n═══ TOP 10 ═══');
for (let k = 0; k < Math.min(10, results.length); k++) {
  const r = results[k];
  console.log(`#${k+1}: ${r.ret}% | ${r.trades}t | wr=${r.wr}% | PF=${r.pf} | maxDD=${r.maxDD}% — ${r.label}`);
}

console.log('\n═══ BOTTOM 5 (ter controle) ═══');
for (let k = results.length - 5; k < results.length; k++) {
  const r = results[k];
  console.log(`#${k+1}: ${r.ret}% | ${r.trades}t | wr=${r.wr}% | PF=${r.pf} — ${r.label}`);
}

console.log(`\n═══ ROBUST CHECK: top 10 naar PF ═══`);
const byPF = [...results].sort((a, b) => b.pf - a.pf);
for (let k = 0; k < 10; k++) {
  const r = byPF[k];
  console.log(`#${k+1}: PF=${r.pf} | ${r.ret}% | ${r.trades}t | wr=${r.wr}% | DD=${r.maxDD}% — ${r.label}`);
}

// Schrijf naar file voor naar-consulte
await fs.writeFile('./cache/hyperopt-results.json', JSON.stringify({
  timestamp: Date.now(),
  assetsUsed: assetList,
  configCount: configs.length,
  topByReturn: results.slice(0, 10),
  topByPF: byPF.slice(0, 10),
  all: results,
}, null, 2));
console.log('\n→ Volledige resultaten: cache/hyperopt-results.json');
