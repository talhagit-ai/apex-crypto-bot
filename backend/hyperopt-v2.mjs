// ═══════════════════════════════════════════════════════════════
//  APEX Hyperopt V2 — extended param search
//  Extra variabelen: PARTIAL1_PCT, PARTIAL2_PCT, finer TRAIL_ATR
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
      a.c = b.c; a.v += b.v;
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
      lows: slice5.map(x => x.l), volumes: slice5.map(x => x.v),
    };
    const t5 = slice5[slice5.length - 1].t;
    const b15 = bars15Map[a.id]?.filter(x => x.t <= t5).slice(-80) || [];
    if (b15.length >= 30) tf15Data[a.id] = {
      closes: b15.map(x => x.c), highs: b15.map(x => x.h), lows: b15.map(x => x.l), volumes: b15.map(x => x.v),
    };
    const b60 = bars60Map[a.id]?.filter(x => x.t <= t5).slice(-72) || [];
    if (b60.length >= 24) regimeData[a.id] = {
      closes: b60.map(x => x.c), highs: b60.map(x => x.h), lows: b60.map(x => x.l),
    };
  }
  return { barData, regimeData, tf15Data };
}

function runBacktest(bars5Map, bars15Map, bars60Map, params) {
  const engine = new TradingEngine(START, {
    growthMode: true, simMode: true,
    overrideParams: params,
  });
  const longest = Object.values(bars5Map).reduce((a, b) => b.length > a.length ? b : a, []);
  const lookback = 80;
  for (let i = lookback; i < longest.length; i++) {
    const { barData, regimeData, tf15Data } = buildBarData(bars5Map, bars15Map, bars60Map, i, lookback);
    try { engine.tick(barData, regimeData, tf15Data); } catch (_) {}
  }
  const fp = {};
  for (const a of ASSETS) { const b = bars5Map[a.id]; if (b?.length) fp[a.id] = b[b.length - 1].c; }
  for (const id of Object.keys(engine.positions)) engine._closePosition(id, fp[id] || engine.positions[id].entry, 'BT_END');
  const finalEq = engine.equity(fp);
  const exits = engine.trades.filter(t => ['SELL', 'COVER'].includes(t.side));
  const wins = exits.filter(t => (t.pnl || 0) > 0);
  const gw = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const gl = Math.abs(exits.filter(t => (t.pnl || 0) < 0).reduce((s, t) => s + (t.pnl || 0), 0));
  const pf = gl > 0 ? gw / gl : 999;
  const ret = (finalEq / START - 1) * 100;
  const wr = exits.length ? wins.length / exits.length * 100 : 0;
  // Sharpe-achtige metric: ret / stddev van individuele trade pnl
  const pnls = exits.map(t => t.pnl || 0);
  const mean = pnls.reduce((s, x) => s + x, 0) / Math.max(pnls.length, 1);
  const variance = pnls.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(pnls.length - 1, 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(exits.length) : 0;
  return { params, ret: +ret.toFixed(2), trades: exits.length, wr: +wr.toFixed(1), pf: +pf.toFixed(2), sharpe: +sharpe.toFixed(2), finalEq: +finalEq.toFixed(2) };
}

// ── Main ──
const bars5Map = await loadCache();
const assetList = Object.keys(bars5Map).sort();
console.log(`═══ HYPEROPT V2 — ${assetList.length} assets ═══`);
const bars15Map = {}, bars60Map = {};
for (const a of assetList) {
  bars15Map[a] = aggregate(bars5Map[a], 15);
  bars60Map[a] = aggregate(bars5Map[a], 60);
}

// Fine-grained grid rond V23 winner, plus PARTIAL_PCT variaties
const configs = [];
for (const p1r of [0.5, 0.6, 0.75, 0.85, 1.0, 1.15]) {
  for (const p1pct of [0.20, 0.25, 0.33]) {
    for (const p2pct of [0.20, 0.25, 0.33]) {
      for (const trailAtr of [1.5, 2.0, 2.5]) {
        configs.push({
          PARTIAL1_R: p1r,
          PARTIAL1_PCT: p1pct,
          PARTIAL2_R: p1r + 0.5,
          PARTIAL2_PCT: p2pct,
          TRAIL_R: 1.0,
          TRAIL_ATR: trailAtr,
          MIN_RR: 2.0,
        });
      }
    }
  }
}
console.log(`Testen ${configs.length} configs (MIN_RR=2.0, TRAIL_R=1.0 vast)...\n`);

const results = [];
let i = 0;
for (const c of configs) {
  i++;
  const r = runBacktest(bars5Map, bars15Map, bars60Map, c);
  results.push(r);
  if (i % 30 === 0) console.log(`  ${i}/${configs.length}...`);
}

results.sort((a, b) => b.ret - a.ret);

const toS = p => `P1=${p.PARTIAL1_R} P1%=${p.PARTIAL1_PCT} P2%=${p.PARTIAL2_PCT} ATR=${p.TRAIL_ATR}`;

console.log('\n═══ TOP 15 naar RETURN ═══');
for (let k = 0; k < 15; k++) {
  const r = results[k];
  console.log(`#${k+1}: ${r.ret}% | ${r.trades}t wr=${r.wr}% PF=${r.pf} Sharpe=${r.sharpe} — ${toS(r.params)}`);
}

const byPF = [...results].sort((a, b) => b.pf - a.pf);
console.log('\n═══ TOP 10 naar PF ═══');
for (let k = 0; k < 10; k++) {
  const r = byPF[k];
  console.log(`#${k+1}: PF=${r.pf} | ${r.ret}% ${r.trades}t wr=${r.wr}% — ${toS(r.params)}`);
}

const bySharpe = [...results].sort((a, b) => b.sharpe - a.sharpe);
console.log('\n═══ TOP 10 naar Sharpe ═══');
for (let k = 0; k < 10; k++) {
  const r = bySharpe[k];
  console.log(`#${k+1}: Sharpe=${r.sharpe} | ${r.ret}% PF=${r.pf} ${r.trades}t — ${toS(r.params)}`);
}

await fs.writeFile('./cache/hyperopt-v2-results.json', JSON.stringify({
  timestamp: Date.now(),
  configCount: configs.length,
  topRet: results.slice(0, 20),
  topPF: byPF.slice(0, 10),
  topSharpe: bySharpe.slice(0, 10),
  all: results,
}, null, 2));
console.log('\n→ Results: cache/hyperopt-v2-results.json');
