// ═══════════════════════════════════════════════════════════════
//  APEX Walk-Forward Validation (V26)
//  Splits 90d cache → 60d train (in-sample) + 30d test (out-of-sample).
//  Train winner getest op holdout om overfitting te detecteren.
//  Output: cache/walk-forward.json
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import { TradingEngine } from './engine.mjs';
import { ASSETS } from './config.mjs';
import { setLevel } from './logger.mjs';

setLevel(process.env.LOG_LEVEL || 'warn');

const CACHE_DIR = './cache';
const START = 200;
const LOOKBACK = 80;
const TRAIN_RATIO = 2/3;  // 60 of 90 days

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

function buildBarData(bars5Map, bars15Map, bars60Map, idx5m) {
  const barData = {}, regimeData = {}, tf15Data = {};
  for (const a of ASSETS) {
    const b5 = bars5Map[a.id]; if (!b5) continue;
    if (idx5m >= b5.length) continue;
    const start = Math.max(0, idx5m - LOOKBACK + 1);
    const slice5 = b5.slice(start, idx5m + 1);
    if (slice5.length < 30) continue;
    barData[a.id] = {
      closes: slice5.map(x=>x.c), highs: slice5.map(x=>x.h),
      lows: slice5.map(x=>x.l), volumes: slice5.map(x=>x.v),
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

function runSlice(bars5Map, bars15Map, bars60Map, params, fromIdx, toIdx) {
  const engine = new TradingEngine(START, {
    growthMode: true, simMode: true,
    overrideParams: params,
  });
  for (let i = Math.max(LOOKBACK, fromIdx); i < toIdx; i++) {
    const data = buildBarData(bars5Map, bars15Map, bars60Map, i);
    try { engine.tick(data.barData, data.regimeData, data.tf15Data); } catch(_) {}
  }
  const finalPrices = {};
  for (const a of ASSETS) {
    const b = bars5Map[a.id];
    if (b && toIdx - 1 < b.length) finalPrices[a.id] = b[toIdx - 1].c;
  }
  for (const id of Object.keys(engine.positions)) {
    engine._closePosition(id, finalPrices[id] || engine.positions[id].entry, 'BT_END');
  }
  const finalEq = engine.equity(finalPrices);
  const exits = engine.trades.filter(t => ['SELL','COVER'].includes(t.side));
  const wins = exits.filter(t => (t.pnl || 0) > 0);
  const grossWin = wins.reduce((s,t)=>s+(t.pnl||0),0);
  const grossLoss = Math.abs(exits.filter(t=>(t.pnl||0)<0).reduce((s,t)=>s+(t.pnl||0),0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
  return {
    ret: +(((finalEq/START)-1)*100).toFixed(2),
    trades: exits.length,
    wr: exits.length ? +(wins.length/exits.length*100).toFixed(1) : 0,
    pf: +pf.toFixed(2),
  };
}

// Build grid (same as hyperopt-ext)
const grid = [];
const p1s = [0.75, 1.0, 1.25, 1.5];
const trs = [0.6, 0.8, 1.0, 1.25];
const tas = [1.5, 2.0, 2.5];
const rrs = [1.5, 1.8, 2.0];
for (const p1 of p1s) for (const tr of trs) for (const ta of tas) for (const rr of rrs)
  grid.push({ PARTIAL1_R: p1, PARTIAL2_R: p1+0.5, TRAIL_R: tr, TRAIL_ATR: ta, MIN_RR: rr });

const labelOf = (c) => `P1=${c.PARTIAL1_R} TR=${c.TRAIL_R} ATR=${c.TRAIL_ATR} RR=${c.MIN_RR}`;

// ── Main ───────────────────────────────────────────────────────
const bars5Map = await loadCache();
const longest = Math.max(...Object.values(bars5Map).map(b => b.length));
const splitIdx = Math.floor(longest * TRAIN_RATIO);
console.log(`\n═══ WALK-FORWARD VALIDATION (V26) ═══`);
console.log(`Total bars: ${longest}, train: ${splitIdx} (${(splitIdx/longest*100).toFixed(0)}%), test: ${longest-splitIdx} (${((longest-splitIdx)/longest*100).toFixed(0)}%)\n`);

const bars15Map = {}, bars60Map = {};
for (const a of Object.keys(bars5Map)) {
  bars15Map[a] = aggregate(bars5Map[a], 15);
  bars60Map[a] = aggregate(bars5Map[a], 60);
}

// Step 1: optimize on TRAIN slice
console.log(`▶ Phase 1: optimizing ${grid.length} configs on TRAIN slice...`);
const trainResults = [];
for (let i = 0; i < grid.length; i++) {
  const r = runSlice(bars5Map, bars15Map, bars60Map, grid[i], LOOKBACK, splitIdx);
  trainResults.push({ params: grid[i], ...r });
  if ((i+1) % 30 === 0) console.log(`  ${i+1}/${grid.length}`);
}
const trainSorted = trainResults.sort((a,b) => b.ret - a.ret);

console.log(`\n═══ TRAIN TOP 5 ═══`);
for (let i = 0; i < 5; i++) {
  const r = trainSorted[i];
  console.log(`  #${i+1}: ${r.ret}% / ${r.trades}t / WR ${r.wr}% / PF ${r.pf} — ${labelOf(r.params)}`);
}

// Step 2: validate top 5 on TEST slice
console.log(`\n▶ Phase 2: validating top-5 on TEST slice (out-of-sample)...`);
const validation = [];
for (let i = 0; i < 5; i++) {
  const r = trainSorted[i];
  const test = runSlice(bars5Map, bars15Map, bars60Map, r.params, splitIdx, longest);
  validation.push({
    rank: i+1,
    params: r.params,
    train: { ret: r.ret, trades: r.trades, wr: r.wr, pf: r.pf },
    test,
  });
}

console.log(`\n═══ WALK-FORWARD RESULT ═══`);
console.log(`Rank | Train ret | Test ret | Δ      | Train PF | Test PF | Config`);
for (const v of validation) {
  const delta = (v.test.ret - v.train.ret).toFixed(2);
  const verdict = (v.test.ret > 0 && v.test.pf > 1) ? '✓ROBUST' : (v.test.ret < v.train.ret/2 ? '✗OVERFIT' : '~OK');
  console.log(`  #${v.rank} | ${String(v.train.ret).padStart(7)}% | ${String(v.test.ret).padStart(7)}% | ${delta.padStart(6)} | ${String(v.train.pf).padStart(7)} | ${String(v.test.pf).padStart(7)} | ${labelOf(v.params)} ${verdict}`);
}

const robust = validation.filter(v => v.test.ret > 0 && v.test.pf > 1);
console.log(`\n→ ${robust.length}/5 configs survived out-of-sample test.`);
if (robust.length > 0) {
  const winner = robust.sort((a,b) => b.test.ret - a.test.ret)[0];
  console.log(`→ Best robust config: ${labelOf(winner.params)} (test ret ${winner.test.ret}%, test PF ${winner.test.pf})`);
}

await fs.writeFile('./cache/walk-forward.json', JSON.stringify({
  timestamp: Date.now(),
  splitRatio: TRAIN_RATIO,
  trainTop10: trainSorted.slice(0, 10),
  validation,
  robustWinner: robust.length ? robust[0] : null,
}, null, 2));
console.log('\n→ Saved: cache/walk-forward.json');
