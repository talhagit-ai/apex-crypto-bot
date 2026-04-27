// ═══════════════════════════════════════════════════════════════
//  Asset Scout — voor elke cached asset, run engine SOLO op
//  test slice (recente 30d) en rank op return + PF + trade count.
//  Goal: vind welke coins een echte edge hebben in huidige regime.
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import path from 'path';
import { TradingEngine } from './engine.mjs';
import { setLevel } from './logger.mjs';
setLevel('warn');

const CACHE_DIR = './cache';
const START = 200;
const LOOKBACK = 80;
const SKIP_FILES = new Set(['market-scan.json', 'walk-forward.json',
  'walk-forward-robust.json', 'per-asset-params.json',
  'hyperopt-results.json', 'hyperopt-v2-results.json',
  'opt-progress.json', 'opt-progress-v2.json']);

function pricePrecisionFromPrice(p) {
  if (p > 100) return 2;
  if (p > 1) return 3;
  if (p > 0.01) return 5;
  if (p > 0.0001) return 7;
  return 9;
}
function qtyStepFromPrice(p) {
  if (p > 1000) return 0.0001;
  if (p > 100) return 0.001;
  if (p > 10) return 0.01;
  if (p > 1) return 0.1;
  if (p > 0.01) return 1;
  return 10;
}
function minQtyFromPrice(p) { return qtyStepFromPrice(p) * 10; }

function buildDefaultAsset(id, lastPrice, idx) {
  return {
    id,
    symbol: id,
    krakenSymbol: id.replace('USDT','/USD').replace('USD','/USD'),
    krakenPair: id,
    category: 'spot',
    vol: 0.018,
    drift: 0.00040,
    slM: 2.5,
    tpM: 4.5,
    minQty: minQtyFromPrice(lastPrice),
    qtyStep: qtyStepFromPrice(lastPrice),
    pricePrecision: pricePrecisionFromPrice(lastPrice),
    color: '#888',
    corrGroup: `SCOUT${idx}`, // unique group → no correlation block
    regimeATR: 0.08,
  };
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

async function loadCache(id) {
  try {
    const raw = await fs.readFile(`${CACHE_DIR}/${id}.json`, 'utf8');
    const cached = JSON.parse(raw);
    return cached.bars || [];
  } catch (_) { return []; }
}

function evaluateAsset(id, bars5, fromRatio = 0.66) {
  if (!bars5 || bars5.length < 200) return null;
  const lastPrice = bars5[bars5.length - 1].c;
  const asset = buildDefaultAsset(id, lastPrice, 0);
  const bars15 = aggregate(bars5, 15);
  const bars60 = aggregate(bars5, 60);
  const fromIdx = Math.max(LOOKBACK, Math.floor(bars5.length * fromRatio));
  const toIdx = bars5.length;

  const engine = new TradingEngine(START, {
    growthMode: true, simMode: true,
    overrideAssets: [asset],
  });

  for (let i = fromIdx; i < toIdx; i++) {
    const start5 = Math.max(0, i - LOOKBACK + 1);
    const slice5 = bars5.slice(start5, i + 1);
    if (slice5.length < 30) continue;
    const t5 = slice5[slice5.length - 1].t;
    const slice15 = bars15.filter(x => x.t <= t5).slice(-80);
    const slice60 = bars60.filter(x => x.t <= t5).slice(-72);
    const barData = { [id]: {
      closes: slice5.map(x=>x.c), highs: slice5.map(x=>x.h),
      lows: slice5.map(x=>x.l), volumes: slice5.map(x=>x.v),
    }};
    const tf15Data = slice15.length >= 30 ? { [id]: {
      closes: slice15.map(x=>x.c), highs: slice15.map(x=>x.h),
      lows: slice15.map(x=>x.l), volumes: slice15.map(x=>x.v),
    }} : {};
    const regimeData = slice60.length >= 24 ? { [id]: {
      closes: slice60.map(x=>x.c), highs: slice60.map(x=>x.h), lows: slice60.map(x=>x.l),
    }} : {};
    try { engine.tick(barData, regimeData, tf15Data); } catch(_) {}
  }
  if (engine.positions[id]) {
    engine._closePosition(id, lastPrice, 'BT_END');
  }
  const finalEq = engine.equity({ [id]: lastPrice });
  const exits = engine.trades.filter(t => ['SELL','COVER'].includes(t.side));
  const wins = exits.filter(t => (t.pnl || 0) > 0);
  const grossWin = wins.reduce((s,t)=>s+(t.pnl||0),0);
  const grossLoss = Math.abs(exits.filter(t=>(t.pnl||0)<0).reduce((s,t)=>s+(t.pnl||0),0));
  const pf = grossLoss > 0 ? grossWin/grossLoss : (grossWin>0 ? 999 : 0);
  const days = (bars5[bars5.length-1].t - bars5[fromIdx].t) / 86400_000;
  return {
    id, ret: +(((finalEq/START)-1)*100).toFixed(2),
    trades: exits.length,
    wr: exits.length ? +(wins.length/exits.length*100).toFixed(1) : 0,
    pf: +pf.toFixed(2),
    days: +days.toFixed(1),
    pnl: +(finalEq - START).toFixed(2),
    barsTotal: bars5.length,
  };
}

const files = await fs.readdir(CACHE_DIR);
const assetIds = files
  .filter(f => f.endsWith('.json') && !SKIP_FILES.has(f))
  .map(f => path.basename(f, '.json'));

console.log(`\n═══ ASSET SCOUT — solo evaluatie op test slice (laatste 33%) ═══\n`);
console.log(`Cache: ${assetIds.length} kandidaten`);

const results = [];
for (const id of assetIds) {
  const bars = await loadCache(id);
  if (!bars.length || bars.length < 500) {
    console.log(`  ${id.padEnd(10)} skip — onvoldoende bars (${bars.length})`);
    continue;
  }
  const r = evaluateAsset(id, bars, 0.66);
  if (!r) { console.log(`  ${id.padEnd(10)} skip — eval failed`); continue; }
  results.push(r);
}

results.sort((a, b) => b.ret - a.ret);

console.log(`\n${'Asset'.padEnd(10)} | ${'Ret%'.padStart(7)} | ${'PF'.padStart(5)} | ${'WR'.padStart(5)} | Trades | Days | $PnL`);
console.log('-'.repeat(75));
for (const r of results) {
  const tag = r.ret > 0 && r.pf > 1 && r.trades >= 3 ? '✓' : ' ';
  console.log(`${tag} ${r.id.padEnd(8)} | ${String(r.ret).padStart(6)}% | ${String(r.pf).padStart(5)} | ${String(r.wr).padStart(4)}% | ${String(r.trades).padStart(6)} | ${String(r.days).padStart(4)} | ${r.pnl > 0 ? '+' : ''}${r.pnl}`);
}

const winners = results.filter(r => r.ret > 0 && r.pf > 1 && r.trades >= 3);
console.log(`\n=== ${winners.length} edge-bearing assets (ret>0, PF>1, ≥3 trades) ===`);
console.log(winners.map(r => r.id).join(', ') || '(geen)');

await fs.writeFile('./cache/asset-scout.json', JSON.stringify({ timestamp: Date.now(), results }, null, 2));
console.log('\n→ Saved: cache/asset-scout.json');
