// ═══════════════════════════════════════════════════════════════
//  APEX Backtest — replay engine.mjs tegen historische Kraken data
//  Fetched 5m/15m/1h OHLC voor alle 8 assets en simuleert tick-per-tick
// ═══════════════════════════════════════════════════════════════

import { TradingEngine } from './engine.mjs';
import { ASSETS, GROWTH_MODE, MIN_CONF, MIN_RR } from './config.mjs';

const PAIRS = { BTCUSDT: 'XBTUSD', ETHUSDT: 'ETHUSD', SOLUSDT: 'SOLUSD',
                XRPUSDT: 'XRPUSD', ADAUSDT: 'ADAUSD', LINKUSD: 'LINKUSD',
                AVAXUSD: 'AVAXUSD', DOGEUSD: 'XDGUSD' };

async function fetchOHLC(pair, interval) {
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (json.error?.length) throw new Error(json.error.join(';'));
  const key = Object.keys(json.result).find(k => k !== 'last');
  return (json.result[key] || []).map(b => ({
    t: b[0] * 1000, o: +b[1], h: +b[2], l: +b[3], c: +b[4], v: +b[6],
  }));
}

async function loadAllData() {
  const data = {};
  console.log('Fetching 5m/15m/1h data voor 8 assets...');
  for (const a of ASSETS) {
    const p = PAIRS[a.id];
    if (!p) continue;
    const [b5, b15, b60] = await Promise.all([
      fetchOHLC(p, 5), fetchOHLC(p, 15), fetchOHLC(p, 60),
    ]);
    data[a.id] = { b5, b15, b60 };
    console.log(`  ${a.id}: 5m=${b5.length} 15m=${b15.length} 1h=${b60.length}`);
    await new Promise(r => setTimeout(r, 500)); // rate limit
  }
  return data;
}

function buildBarData(data, idx5m, lookback = 100) {
  // Geef laatste 'lookback' 5m bars per asset op punt idx5m
  const barData = {}, regimeData = {}, tf15Data = {};
  for (const a of ASSETS) {
    const d = data[a.id];
    if (!d) continue;
    const start = Math.max(0, idx5m - lookback + 1);
    const bars5 = d.b5.slice(start, idx5m + 1);
    if (bars5.length < 30) continue;
    barData[a.id] = {
      closes: bars5.map(x => x.c),
      highs:  bars5.map(x => x.h),
      lows:   bars5.map(x => x.l),
      volumes: bars5.map(x => x.v),
    };
    // 15m: map 5m timestamp → laatste 15m bar waarvan t <= current
    const t5 = bars5[bars5.length - 1].t;
    const bars15 = d.b15.filter(x => x.t <= t5).slice(-80);
    if (bars15.length >= 30) {
      tf15Data[a.id] = {
        closes: bars15.map(x => x.c),
        highs:  bars15.map(x => x.h),
        lows:   bars15.map(x => x.l),
        volumes: bars15.map(x => x.v),
      };
    }
    const bars60 = d.b60.filter(x => x.t <= t5).slice(-72);
    if (bars60.length >= 24) {
      regimeData[a.id] = {
        closes: bars60.map(x => x.c),
        highs:  bars60.map(x => x.h),
        lows:   bars60.map(x => x.l),
      };
    }
  }
  return { barData, regimeData, tf15Data };
}

async function runBacktest(startCapital = 200, label = 'CURRENT') {
  const data = await loadAllData();
  const btc5m = data.BTCUSDT?.b5 || [];
  if (btc5m.length < 100) { console.log('Te weinig BTC data'); return; }

  const engine = new TradingEngine(startCapital, {
    growthMode: true, simMode: true,
  });

  console.log(`\n═══ BACKTEST ${label} (${btc5m.length} × 5m bars) ═══`);
  console.log(`StartCapital: $${startCapital} | MIN_RR=${engine.MRR} P1_R=${engine.P1_R} TRAIL_R=${engine.T_R} TRAIL_ATR=${engine.T_ATR}`);

  const lookback = 80;
  let equityCurve = [];

  for (let i = lookback; i < btc5m.length; i++) {
    const { barData, regimeData, tf15Data } = buildBarData(data, i, lookback);
    const prices = {};
    for (const a of ASSETS) {
      const bd = barData[a.id];
      if (bd) prices[a.id] = bd.closes[bd.closes.length - 1];
    }
    try { engine.tick(barData, regimeData, tf15Data); }
    catch (e) { if (i % 50 === 0) console.log(`tick ${i} err:`, e.message); }
    if (i % 60 === 0) {
      const eq = engine.equity(prices);
      equityCurve.push({ t: btc5m[i].t, eq });
    }
  }

  // Final metrics
  const finalPrices = {};
  for (const a of ASSETS) {
    const d = data[a.id];
    if (d?.b5?.length) finalPrices[a.id] = d.b5[d.b5.length - 1].c;
  }
  // Force close alle resterende posities
  for (const id of Object.keys(engine.positions)) {
    engine._closePosition(id, finalPrices[id] || engine.positions[id].entry, 'BACKTEST_END');
  }
  const finalEq = engine.equity(finalPrices);

  const exits = engine.trades.filter(t => ['SELL','COVER'].includes(t.side));
  const wins  = exits.filter(t => (t.pnl || 0) > 0);
  const totalPnL = exits.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossWin = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(exits.filter(t => (t.pnl || 0) < 0).reduce((s, t) => s + (t.pnl || 0), 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : 999;
  const winRate = exits.length > 0 ? wins.length / exits.length * 100 : 0;

  const exitReasons = {};
  for (const t of exits) {
    const r = (t.reason || 'UNK').split(' ')[0];
    exitReasons[r] = (exitReasons[r] || 0) + 1;
  }

  // Max drawdown
  let peak = startCapital, maxDD = 0;
  for (const e of equityCurve) {
    if (e.eq > peak) peak = e.eq;
    const dd = (peak - e.eq) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  console.log(`\n─── RESULTATEN ${label} ───`);
  console.log(`Final equity:  $${finalEq.toFixed(2)} (${((finalEq/startCapital-1)*100).toFixed(2)}%)`);
  console.log(`Total PnL:     $${totalPnL.toFixed(2)}`);
  console.log(`Trades:        ${exits.length} (W${wins.length}/L${exits.length-wins.length}) winRate=${winRate.toFixed(1)}%`);
  console.log(`Profit Factor: ${pf.toFixed(2)}`);
  console.log(`Max Drawdown:  ${(maxDD*100).toFixed(2)}%`);
  console.log(`Exit reasons:  ${JSON.stringify(exitReasons)}`);
  console.log(`Partials:      ${engine.trades.filter(t => t.side?.startsWith('PARTIAL')).length}`);
  console.log(`Pyramids:      ${engine.trades.filter(t => t.side === 'PYRAMID').length}`);

  return { label, finalEq, totalPnL, winRate, pf, maxDD, trades: exits.length, exitReasons };
}

// Main
const start = Date.now();
await runBacktest(200, 'V21 (huidige config)');
console.log(`\n⏱  ${((Date.now()-start)/1000).toFixed(1)}s`);
