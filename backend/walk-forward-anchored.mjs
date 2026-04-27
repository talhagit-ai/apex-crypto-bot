// ═══════════════════════════════════════════════════════════════
//  V35 Walk-Forward ANCHORED — rolling validation across 7 windows.
//  Replaces single 60/30 split with sliding (60d train / 30d test) × 7 steps,
//  10-day step. A config is "robust" if positive on ≥5/7 test windows.
//
//  Run: node backend/walk-forward-anchored.mjs
//  Output: cache/walk-forward-anchored.json
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import { TradingEngine } from './engine.mjs';
import { ASSETS } from './config.mjs';
import { setLevel } from './logger.mjs';

setLevel('error');

const CACHE_DIR = './cache';
const START = 200;
const LOOKBACK = 80;
// 5m bars: 60d ≈ 17280 bars, 30d ≈ 8640 bars, 10d ≈ 2880 bars
const TRAIN_BARS = 17280;
const TEST_BARS  = 8640;
const STEP_BARS  = 2880;

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
    const b5 = bars5Map[a.id]; if (!b5 || idx5m >= b5.length) continue;
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
  const pf = grossLoss > 0 ? grossWin/grossLoss : (grossWin>0 ? 999 : 0);
  return {
    ret: +(((finalEq/START)-1)*100).toFixed(2),
    trades: exits.length,
    wr: exits.length ? +(wins.length/exits.length*100).toFixed(1) : 0,
    pf: +pf.toFixed(2),
  };
}

const grid = [];
const p1s = [1.0, 1.25, 1.5];
const trs = [0.8, 1.0, 1.25, 1.5];
const tas = [1.5, 2.0, 2.5];
const rrs = [1.3, 1.5, 1.8];
for (const p1 of p1s) for (const tr of trs) for (const ta of tas) for (const rr of rrs)
  grid.push({ PARTIAL1_R: p1, PARTIAL2_R: p1+0.5, TRAIL_R: tr, TRAIL_ATR: ta, MIN_RR: rr });

const labelOf = (c) => `P1=${c.PARTIAL1_R} TR=${c.TRAIL_R} ATR=${c.TRAIL_ATR} RR=${c.MIN_RR}`;

const bars5Map = await loadCache();
const longest = Math.max(...Object.values(bars5Map).map(b => b.length));

// Define windows: each window has trainStart, trainEnd=testStart, testEnd
const windows = [];
let testEnd = longest;
while (testEnd - TEST_BARS - TRAIN_BARS >= LOOKBACK && windows.length < 7) {
  const testStart = testEnd - TEST_BARS;
  const trainStart = testStart - TRAIN_BARS;
  windows.unshift({ trainStart, trainEnd: testStart, testStart, testEnd });
  testEnd -= STEP_BARS;
}
console.log(`\n═══ ANCHORED WALK-FORWARD — ${windows.length} windows × ${grid.length} configs ═══`);
console.log(`Train: ${TRAIN_BARS} bars (~60d), Test: ${TEST_BARS} bars (~30d), Step: ${STEP_BARS} bars (~10d)`);
windows.forEach((w, i) => {
  console.log(`  Window ${i+1}: train [${w.trainStart}..${w.trainEnd}], test [${w.testStart}..${w.testEnd}]`);
});

const bars15Map = {}, bars60Map = {};
for (const a of Object.keys(bars5Map)) {
  bars15Map[a] = aggregate(bars5Map[a], 15);
  bars60Map[a] = aggregate(bars5Map[a], 60);
}

const results = [];
for (let g = 0; g < grid.length; g++) {
  const config = grid[g];
  const windowResults = [];
  for (const w of windows) {
    const train = runSlice(bars5Map, bars15Map, bars60Map, config, w.trainStart, w.trainEnd);
    const test  = runSlice(bars5Map, bars15Map, bars60Map, config, w.testStart, w.testEnd);
    windowResults.push({ train, test });
  }
  const positiveTests = windowResults.filter(w => w.test.ret > 0).length;
  const avgTestRet = windowResults.reduce((s,w) => s + w.test.ret, 0) / windowResults.length;
  const avgTestPF  = windowResults.reduce((s,w) => s + w.test.pf, 0) / windowResults.length;
  const sumTestRet = windowResults.reduce((s,w) => s + w.test.ret, 0);
  results.push({
    config, label: labelOf(config), windows: windowResults,
    positiveTests, avgTestRet, avgTestPF, sumTestRet,
  });
  if ((g+1) % 10 === 0) console.log(`  ${g+1}/${grid.length}`);
}

// Robust: positive on ≥5/7 test windows AND avgPF > 1
const robust = results.filter(r => r.positiveTests >= Math.ceil(windows.length * 0.7) && r.avgTestPF > 1);
robust.sort((a,b) => b.avgTestRet - a.avgTestRet);

console.log(`\n═══ ROBUST CONFIGS (≥${Math.ceil(windows.length*0.7)}/${windows.length} positive test windows AND avg PF >1) ═══`);
console.log(`Found ${robust.length}/${results.length} robust configs.`);
for (let i = 0; i < Math.min(10, robust.length); i++) {
  const r = robust[i];
  console.log(`  #${i+1}: ${r.positiveTests}/${windows.length} pos | avgTest=${r.avgTestRet.toFixed(2)}% avgPF=${r.avgTestPF.toFixed(2)} | ${r.label}`);
}

// Top by sum return across windows
const byTestSum = [...results].sort((a,b) => b.sumTestRet - a.sumTestRet);
console.log(`\n═══ TOP-10 BY SUM TEST RETURN ═══`);
for (let i = 0; i < 10; i++) {
  const r = byTestSum[i];
  console.log(`  #${i+1}: sum=${r.sumTestRet.toFixed(2)}% pos=${r.positiveTests}/${windows.length} avgPF=${r.avgTestPF.toFixed(2)} | ${r.label}`);
}

await fs.writeFile('./cache/walk-forward-anchored.json', JSON.stringify({
  timestamp: Date.now(),
  windows: windows.length,
  trainBars: TRAIN_BARS, testBars: TEST_BARS, stepBars: STEP_BARS,
  robust: robust.slice(0, 20),
  topByTestSum: byTestSum.slice(0, 20),
  all: results,
}, null, 2));
console.log('\n→ Saved: cache/walk-forward-anchored.json');
