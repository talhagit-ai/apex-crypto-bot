// ═══════════════════════════════════════════════════════════════
//  APEX Hyperopt — grid search over key parameters
//  Gebruik cached Kraken data uit backtest, test ~30 combos
// ═══════════════════════════════════════════════════════════════

import { TradingEngine } from './engine.mjs';
import { ASSETS } from './config.mjs';

const PAIRS = { BTCUSDT: 'XBTUSD', ETHUSDT: 'ETHUSD', SOLUSDT: 'SOLUSD',
                XRPUSDT: 'XRPUSD', ADAUSDT: 'ADAUSD', LINKUSD: 'LINKUSD',
                AVAXUSD: 'AVAXUSD', DOGEUSD: 'XDGUSD' };

async function fetchOHLC(pair, interval) {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`;
  const resp = await fetch(url);
  const json = await resp.json();
  const key = Object.keys(json.result).find(k => k !== 'last');
  return (json.result[key] || []).map(b => ({
    t: b[0]*1000, o:+b[1], h:+b[2], l:+b[3], c:+b[4], v:+b[6],
  }));
}

async function loadAllData() {
  const data = {};
  console.log('Loading Kraken data voor 8 assets...');
  for (const a of ASSETS) {
    const p = PAIRS[a.id]; if (!p) continue;
    const [b5, b15, b60] = await Promise.all([fetchOHLC(p,5), fetchOHLC(p,15), fetchOHLC(p,60)]);
    data[a.id] = { b5, b15, b60 };
    await new Promise(r => setTimeout(r, 400));
  }
  console.log('Data loaded.\n');
  return data;
}

function buildBarData(data, idx5m, lookback=80) {
  const barData={}, regimeData={}, tf15Data={};
  for (const a of ASSETS) {
    const d = data[a.id]; if (!d) continue;
    const start = Math.max(0, idx5m - lookback + 1);
    const bars5 = d.b5.slice(start, idx5m+1);
    if (bars5.length < 30) continue;
    barData[a.id] = { closes:bars5.map(x=>x.c), highs:bars5.map(x=>x.h), lows:bars5.map(x=>x.l), volumes:bars5.map(x=>x.v) };
    const t5 = bars5[bars5.length-1].t;
    const b15 = d.b15.filter(x=>x.t<=t5).slice(-80);
    if (b15.length>=30) tf15Data[a.id] = { closes:b15.map(x=>x.c), highs:b15.map(x=>x.h), lows:b15.map(x=>x.l), volumes:b15.map(x=>x.v) };
    const b60 = d.b60.filter(x=>x.t<=t5).slice(-72);
    if (b60.length>=24) regimeData[a.id] = { closes:b60.map(x=>x.c), highs:b60.map(x=>x.h), lows:b60.map(x=>x.l) };
  }
  return { barData, regimeData, tf15Data };
}

function runOne(data, startCapital, params, label='') {
  const engine = new TradingEngine(startCapital, {
    growthMode: true, simMode: true,
    overrideParams: params,
  });
  const btc5m = data.BTCUSDT?.b5 || [];
  const lookback = 80;

  for (let i = lookback; i < btc5m.length; i++) {
    const { barData, regimeData, tf15Data } = buildBarData(data, i, lookback);
    try { engine.tick(barData, regimeData, tf15Data); } catch(_) {}
  }
  // Close open positions at final prices
  const finalPrices = {};
  for (const a of ASSETS) {
    const d = data[a.id];
    if (d?.b5?.length) finalPrices[a.id] = d.b5[d.b5.length-1].c;
  }
  for (const id of Object.keys(engine.positions)) {
    engine._closePosition(id, finalPrices[id] || engine.positions[id].entry, 'BACKTEST_END');
  }
  const finalEq = engine.equity(finalPrices);
  const exits = engine.trades.filter(t => ['SELL','COVER'].includes(t.side));
  const wins = exits.filter(t => (t.pnl || 0) > 0);
  const grossWin = wins.reduce((s,t)=>s+(t.pnl||0),0);
  const grossLoss = Math.abs(exits.filter(t=>(t.pnl||0)<0).reduce((s,t)=>s+(t.pnl||0),0));

  return {
    label,
    params,
    finalEq: +finalEq.toFixed(2),
    returnPct: +(((finalEq/startCapital)-1)*100).toFixed(2),
    trades: exits.length,
    winRate: exits.length ? +(wins.length/exits.length*100).toFixed(1) : 0,
    pf: grossLoss > 0 ? +(grossWin/grossLoss).toFixed(2) : 999,
    grossWin: +grossWin.toFixed(2),
    grossLoss: +grossLoss.toFixed(2),
  };
}

// ── Main grid search ────────────────────────────────────────────
const data = await loadAllData();
const START = 200;

// Combinaties te testen (14 configs)
const configs = [
  { label:'V21 baseline (current)',        PARTIAL1_R:1.0, PARTIAL2_R:1.5, TRAIL_R:1.0, TRAIL_ATR:2.0, MIN_RR:1.8 },
  // Partial variaties
  { label:'P1 later (1.25R)',              PARTIAL1_R:1.25, PARTIAL2_R:1.75, TRAIL_R:1.0, TRAIL_ATR:2.0, MIN_RR:1.8 },
  { label:'P1 eerder (0.75R)',             PARTIAL1_R:0.75, PARTIAL2_R:1.25, TRAIL_R:1.0, TRAIL_ATR:2.0, MIN_RR:1.8 },
  // Trail variaties
  { label:'Trail eerder (+0.5R)',          PARTIAL1_R:1.0, PARTIAL2_R:1.5, TRAIL_R:0.5, TRAIL_ATR:2.0, MIN_RR:1.8 },
  { label:'Trail later (+1.5R)',           PARTIAL1_R:1.0, PARTIAL2_R:1.5, TRAIL_R:1.5, TRAIL_ATR:2.0, MIN_RR:1.8 },
  { label:'Trail wijder (ATR 2.5)',        PARTIAL1_R:1.0, PARTIAL2_R:1.5, TRAIL_R:1.0, TRAIL_ATR:2.5, MIN_RR:1.8 },
  { label:'Trail strakker (ATR 1.5)',      PARTIAL1_R:1.0, PARTIAL2_R:1.5, TRAIL_R:1.0, TRAIL_ATR:1.5, MIN_RR:1.8 },
  // R:R variaties
  { label:'MIN_RR 2.0',                    PARTIAL1_R:1.0, PARTIAL2_R:1.5, TRAIL_R:1.0, TRAIL_ATR:2.0, MIN_RR:2.0 },
  { label:'MIN_RR 1.5',                    PARTIAL1_R:1.0, PARTIAL2_R:1.5, TRAIL_R:1.0, TRAIL_ATR:2.0, MIN_RR:1.5 },
  // Combo's
  { label:'Aggressief: P1 0.75 + tight trail', PARTIAL1_R:0.75, PARTIAL2_R:1.25, TRAIL_R:0.8, TRAIL_ATR:1.5, MIN_RR:1.8 },
  { label:'Conservatief: P1 1.5 + wide trail', PARTIAL1_R:1.5, PARTIAL2_R:2.0, TRAIL_R:1.5, TRAIL_ATR:2.5, MIN_RR:1.8 },
  { label:'Runners-only: P1 1.5 + no early trail', PARTIAL1_R:1.5, PARTIAL2_R:2.5, TRAIL_R:2.0, TRAIL_ATR:2.5, MIN_RR:1.8 },
  { label:'Scalp: P1 0.5 + super tight',    PARTIAL1_R:0.5, PARTIAL2_R:1.0, TRAIL_R:0.5, TRAIL_ATR:1.2, MIN_RR:1.5 },
  { label:'Balanced V22 kandidaat',        PARTIAL1_R:1.25, PARTIAL2_R:2.0, TRAIL_R:1.25, TRAIL_ATR:2.25, MIN_RR:1.8 },
];

const results = [];
for (const c of configs) {
  const { label, ...params } = c;
  const r = runOne(data, START, params, label);
  results.push(r);
  process.stdout.write(`${label.padEnd(45)} → ${r.returnPct.toString().padStart(6)}% | trades=${r.trades.toString().padStart(2)} | wr=${r.winRate.toString().padStart(5)}% | PF=${r.pf}\n`);
}

// Sort by returnPct
results.sort((a, b) => b.returnPct - a.returnPct);

console.log('\n═══ TOP 5 CONFIGS ═══');
for (let i = 0; i < Math.min(5, results.length); i++) {
  const r = results[i];
  console.log(`\n#${i+1}: ${r.label}`);
  console.log(`  Return: ${r.returnPct}% | Trades: ${r.trades} | Win%: ${r.winRate} | PF: ${r.pf}`);
  console.log(`  Params: ${JSON.stringify(r.params)}`);
}

console.log('\n═══ ALL SORTED ═══');
for (const r of results) {
  console.log(`${r.returnPct.toString().padStart(6)}% | ${r.trades.toString().padStart(2)}t | wr=${r.winRate.toString().padStart(4)}% | PF=${r.pf.toString().padStart(5)} | ${r.label}`);
}
