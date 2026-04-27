// Run engine with current config.mjs params on 90d cache.
// Single-run, summary-only — geen 144-config grid (te veel log-spam).

import fs from 'fs/promises';
import { TradingEngine } from './engine.mjs';
import { ASSETS, PARTIAL1_R, PARTIAL2_R, TRAIL_R, TRAIL_ATR, MIN_RR } from './config.mjs';

// Mute info/signal spam — run via `npm run validate` (sets LOG_LEVEL=warn automatically)
import { setLevel } from './logger.mjs';
setLevel(process.env.LOG_LEVEL || 'warn');

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

const bars5Map = await loadCache();
const ids = Object.keys(bars5Map);
console.error(`Loaded ${ids.length} assets: ${ids.join(', ')}`);
const bars15Map = {}, bars60Map = {};
for (const id of ids) {
  bars15Map[id] = aggregate(bars5Map[id], 15);
  bars60Map[id] = aggregate(bars5Map[id], 60);
}

// V34: load per-asset overrides from cache for backtest (skip if stale >14d)
// Set NO_PER_ASSET=true om global params te valideren zonder per-asset overrides.
let perAsset = {};
if (!process.env.NO_PER_ASSET) {
  try {
    const raw = await fs.readFile('./cache/per-asset-params.json', 'utf8');
    const parsed = JSON.parse(raw);
    const ageMs = Date.now() - (parsed.timestamp || 0);
    if (ageMs <= 3 * 24 * 60 * 60 * 1000) {
      perAsset = parsed.finalParams || {};
      console.error(`Loaded per-asset params (${Math.round(ageMs/86400000)}d oud): ${Object.keys(perAsset).join(', ') || '(geen)'}`);
    } else {
      console.error(`per-asset-params.json is ${Math.round(ageMs/86400000)}d oud — skip`);
    }
  } catch (_) {}
} else {
  console.error('NO_PER_ASSET=1 — skip per-asset overrides voor global validation');
}

const engine = new TradingEngine(START, {
  growthMode: true, simMode: true,
  overrideParams: { PARTIAL1_R, PARTIAL2_R, TRAIL_R, TRAIL_ATR, MIN_RR, perAsset },
});

const longest = Object.values(bars5Map).reduce((a, b) => b.length > a.length ? b : a, []);
const lookback = 80;
const totalTicks = longest.length - lookback;
console.error(`Running ${totalTicks} ticks...`);

for (let i = lookback; i < longest.length; i++) {
  const { barData, regimeData, tf15Data } = buildBarData(bars5Map, bars15Map, bars60Map, i, lookback);
  try { engine.tick(barData, regimeData, tf15Data); } catch(_) {}
  if ((i - lookback) % 5000 === 0 && i > lookback) console.error(`  ${i-lookback}/${totalTicks}`);
}

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
const wins = exits.filter(t => (t.pnl || 0) > 0);
const grossWin = wins.reduce((s,t)=>s+(t.pnl||0),0);
const grossLoss = Math.abs(exits.filter(t=>(t.pnl||0)<0).reduce((s,t)=>s+(t.pnl||0),0));
const pf = grossLoss > 0 ? grossWin / grossLoss : 999;
const ret = (finalEq / START - 1) * 100;
const wr = exits.length ? wins.length / exits.length * 100 : 0;

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

console.log('\n═══ RESULT (current live config V25, 3-asset universe) ═══');
console.log(`Params: P1=${PARTIAL1_R} P2=${PARTIAL2_R} TR=${TRAIL_R} ATR=${TRAIL_ATR} RR=${MIN_RR}`);
console.log(`Final equity: $${finalEq.toFixed(2)} (start $${START})`);
console.log(`Return: ${ret.toFixed(2)}%`);
console.log(`Trades: ${exits.length}  WR: ${wr.toFixed(1)}%  PF: ${pf.toFixed(2)}`);
console.log(`Gross win: $${grossWin.toFixed(2)}  Gross loss: $${grossLoss.toFixed(2)}`);
console.log('\nPer-asset:');
const sorted = Object.entries(byAsset).sort((a,b)=>b[1].pnl - a[1].pnl);
for (const [id, s] of sorted) {
  const aWr = s.trades ? (s.wins/s.trades*100).toFixed(0) : '-';
  console.log(`  ${id.padEnd(10)} pnl=$${s.pnl.toFixed(2).padStart(7)}  trades=${String(s.trades).padStart(3)}  wr=${aWr}%`);
}
