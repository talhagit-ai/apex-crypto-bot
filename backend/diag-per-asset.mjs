// Diagnostic: per-asset PnL on the cached 90d data, current config.
// Goal: find which assets are net negative so we can disable them.

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

function runOnAssets(bars5Map, bars15Map, bars60Map, allowedIds) {
  // Filter to allowed assets only (at engine level)
  const filteredASSETS = ASSETS.filter(a => allowedIds.includes(a.id));
  const engine = new TradingEngine(START, {
    growthMode: true, simMode: true,
    overrideAssets: filteredASSETS,
  });
  const longest = Object.values(bars5Map).reduce((a, b) => b.length > a.length ? b : a, []);
  const lookback = 80;
  for (let i = lookback; i < longest.length; i++) {
    const { barData, regimeData, tf15Data } = buildBarData(bars5Map, bars15Map, bars60Map, i, lookback);
    // Strip non-allowed assets
    for (const id of Object.keys(barData)) if (!allowedIds.includes(id)) delete barData[id];
    for (const id of Object.keys(regimeData)) if (!allowedIds.includes(id)) delete regimeData[id];
    for (const id of Object.keys(tf15Data)) if (!allowedIds.includes(id)) delete tf15Data[id];
    try { engine.tick(barData, regimeData, tf15Data); } catch(_) {}
  }
  const finalPrices = {};
  for (const a of filteredASSETS) {
    const arr = bars5Map[a.id];
    if (arr?.length) finalPrices[a.id] = arr[arr.length - 1].c;
  }
  for (const id of Object.keys(engine.positions)) {
    engine._closePosition(id, finalPrices[id] || engine.positions[id].entry, 'BT_END');
  }
  const finalEq = engine.equity(finalPrices);
  const exits = engine.trades.filter(t => ['SELL','COVER'].includes(t.side));
  const wins = exits.filter(t => (t.pnl || 0) > 0);
  const grossWin = wins.reduce((s,t)=>s+(t.pnl||0),0);
  const grossLoss = Math.abs(exits.filter(t=>(t.pnl||0)<0).reduce((s,t)=>s+(t.pnl||0),0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : 999;

  // Per-asset breakdown of the closed trades
  const byAsset = {};
  for (const t of engine.trades) {
    const id = t.asset || t.id;
    if (!id) continue;
    if (!byAsset[id]) byAsset[id] = { trades: 0, wins: 0, pnl: 0 };
    if (['SELL','COVER'].includes(t.side)) {
      byAsset[id].trades++;
      if ((t.pnl||0) > 0) byAsset[id].wins++;
      byAsset[id].pnl += (t.pnl || 0);
    } else if (['PARTIAL1','PARTIAL2'].includes(t.side)) {
      byAsset[id].pnl += (t.pnl || 0);
    }
  }
  return {
    ret: +(((finalEq/START)-1)*100).toFixed(2),
    finalEq: +finalEq.toFixed(2),
    trades: exits.length,
    wr: exits.length ? +(wins.length/exits.length*100).toFixed(1) : 0,
    pf: +pf.toFixed(2),
    byAsset,
  };
}

const bars5Map = await loadCache();
const assetList = Object.keys(bars5Map).sort();
console.log(`\n═══ DIAG — per-asset PnL contributie (huidige live config) ═══\n`);
console.log(`Cache: ${assetList.length} assets`);
for (const a of assetList) {
  const bars = bars5Map[a];
  const days = (bars[bars.length-1].t - bars[0].t) / 86400_000;
  console.log(`  ${a}: ${bars.length} × 5m bars (${days.toFixed(1)}d)`);
}

const bars15Map = {}, bars60Map = {};
for (const a of assetList) {
  bars15Map[a] = aggregate(bars5Map[a], 15);
  bars60Map[a] = aggregate(bars5Map[a], 60);
}

// Run 1: full set
console.log('\n--- Full set (alle 8 assets) ---');
const full = runOnAssets(bars5Map, bars15Map, bars60Map, assetList);
console.log(`Return ${full.ret}%  PF ${full.pf}  WR ${full.wr}%  Trades ${full.trades}`);
console.log('Per-asset PnL:');
const sorted = Object.entries(full.byAsset).sort((a,b)=>a[1].pnl - b[1].pnl);
for (const [id, s] of sorted) {
  console.log(`  ${id.padEnd(10)} pnl=$${s.pnl.toFixed(2).padStart(7)}  trades=${String(s.trades).padStart(3)}  wr=${s.trades?(s.wins/s.trades*100).toFixed(0):'-'}%`);
}

// Run 2: only winners (positive contributors)
const winnerIds = sorted.filter(([id,s])=>s.pnl>0).map(([id])=>id);
console.log(`\n--- Winners only (${winnerIds.length} assets: ${winnerIds.join(', ')}) ---`);
if (winnerIds.length === 0) {
  console.log('Geen winners — alle assets verliezen geld.');
} else {
  const w = runOnAssets(bars5Map, bars15Map, bars60Map, winnerIds);
  console.log(`Return ${w.ret}%  PF ${w.pf}  WR ${w.wr}%  Trades ${w.trades}`);
}

// Run 3: drop the single biggest loser
const biggestLoser = sorted[0]?.[0];
if (biggestLoser && sorted[0][1].pnl < 0) {
  const noLoser = assetList.filter(id => id !== biggestLoser);
  console.log(`\n--- Drop biggest loser (${biggestLoser}) ---`);
  const r = runOnAssets(bars5Map, bars15Map, bars60Map, noLoser);
  console.log(`Return ${r.ret}%  PF ${r.pf}  WR ${r.wr}%  Trades ${r.trades}`);
}

// Run 4: drop top-3 losers
const top3Losers = sorted.slice(0,3).filter(([id,s])=>s.pnl<0).map(([id])=>id);
if (top3Losers.length >= 2) {
  const survivors = assetList.filter(id => !top3Losers.includes(id));
  console.log(`\n--- Drop top-3 losers (${top3Losers.join(', ')}) ---`);
  const r = runOnAssets(bars5Map, bars15Map, bars60Map, survivors);
  console.log(`Return ${r.ret}%  PF ${r.pf}  WR ${r.wr}%  Trades ${r.trades}`);
}

// Run 5: progressive — drop losers one at a time
console.log(`\n--- Progressive drop (sorted by loss): ---`);
let surviving = [...assetList];
for (const [id, s] of sorted) {
  if (s.pnl >= 0) break;
  surviving = surviving.filter(x => x !== id);
  if (surviving.length < 2) break;
  const r = runOnAssets(bars5Map, bars15Map, bars60Map, surviving);
  console.log(`Drop ${id.padEnd(10)} → ${surviving.length} left → ret=${r.ret}%  PF=${r.pf}  WR=${r.wr}%  trades=${r.trades}`);
}
