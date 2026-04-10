#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V9 — Simulator (300-run validation)
//  Tests the full trading engine with synthetic crypto data
//  Run: node scripts/sim_crypto.mjs
// ═══════════════════════════════════════════════════════════════

import { TradingEngine } from '../backend/engine.mjs';
import { ASSETS, CAPITAL, HISTORY_BARS, FEE_RATE } from '../backend/config.mjs';

// V12: simuleer realistische spread/slippage (0.05%)
const SPREAD = 0.0005;

const isGrowth = process.argv.includes('--growth');
const NUM_WEEKS = 300;
const BARS_PER_WEEK = 288 * 7;  // 5-min bars, 24/7 = 2016 bars/week

// ── Synthetic Crypto Data Generator ────────────────────────────

function initBars(asset) {
  const closes = [], highs = [], lows = [], volumes = [];
  let p = asset.id === 'BTCUSDT' ? 65000 :
          asset.id === 'ETHUSDT' ? 3200 :
          asset.id === 'SOLUSDT' ? 145 :
          asset.id === 'XRPUSDT' ? 0.55 :
          asset.id === 'ADAUSDT' ? 0.45 :
          asset.id === 'DOTUSD'  ? 7.5 :
          asset.id === 'LINKUSD' ? 14 :
          asset.id === 'AVAXUSD' ? 30 :
          asset.id === 'DOGEUSD' ? 0.16 :
          asset.id === 'ATOMUSD' ? 8 :
          asset.id === 'LTCUSD'  ? 85 :
          asset.id === 'NEARUSD' ? 5.5 :
          asset.id === 'UNIUSD'  ? 7 :
          asset.id === 'AAVEUSD' ? 90 :
          asset.id === 'POLUSD'  ? 0.35 :
          asset.id === 'FILUSD'  ? 5 :
          asset.id === 'ARBUSD'  ? 0.65 : 10;

  for (let i = 0; i < HISTORY_BARS; i++) {
    // Longer trending phases (80 bars ~ 6.5 hours, like V12 stock sim)
    const phase = Math.floor(i / 80) % 3;
    const d = (asset.drift || 0.0003) * (phase === 0 ? 2.8 : phase === 1 ? 1.5 : -0.2);
    const ret = d + (Math.random() - 0.5) * asset.vol * 2 * (1 + Math.random() * 0.3);

    p = Math.max(p * (1 + ret), p * 0.7);
    closes.push(p);
    highs.push(p * (1 + Math.random() * asset.vol * 0.35));
    lows.push(p * (1 - Math.random() * asset.vol * 0.35));

    const vb = 500000 + Math.random() * 1500000;
    volumes.push(Math.abs(ret) > asset.vol * 1.6 ? vb * 1.8 : vb);
  }
  return { closes, highs, lows, volumes };
}

function nextBar(bars, asset) {
  const last = bars.closes[bars.closes.length - 1];
  const d = (asset.drift || 0.0003) + (Math.random() - 0.492) * asset.vol * 1.8;
  const p = Math.max(last * (1 + d), last * 0.7);
  const vb = 500000 + Math.random() * 1500000;

  return {
    closes: [...bars.closes.slice(-(HISTORY_BARS - 1)), p],
    highs: [...bars.highs.slice(-(HISTORY_BARS - 1)), p * (1 + Math.random() * asset.vol * 0.3)],
    lows: [...bars.lows.slice(-(HISTORY_BARS - 1)), p * (1 - Math.random() * asset.vol * 0.3)],
    volumes: [...bars.volumes.slice(-(HISTORY_BARS - 1)), Math.abs(d) > asset.vol * 1.5 ? vb * 1.8 : vb],
  };
}

// ── Run Simulation ────────────────────────────────────────────

function runOneWeek() {
  const engine = new TradingEngine(CAPITAL, { simMode: true, growthMode: isGrowth });
  const barData = {};
  for (const asset of ASSETS) {
    barData[asset.id] = initBars(asset);
  }

  for (let bar = 0; bar < BARS_PER_WEEK; bar++) {
    // Generate new bars
    for (const asset of ASSETS) {
      barData[asset.id] = nextBar(barData[asset.id], asset);
    }

    // Simulate daily risk reset every 288 bars (= 1 day of 5-min candles)
    if (bar > 0 && bar % 288 === 0) {
      engine.riskState.dailyLoss = 0;
      engine.riskState.riskReduction = Math.max(engine.riskState.riskReduction, 1.0);
    }

    // Run engine tick (use 5min data for all TFs in sim — synthetic data)
    engine.tick(barData, barData, barData);
  }

  // Force close any remaining positions at market (V12: met spread)
  const currentPrices = {};
  for (const asset of ASSETS) {
    const raw = barData[asset.id].closes[barData[asset.id].closes.length - 1];
    currentPrices[asset.id] = raw * (1 - SPREAD); // sell @ bid (slippage)
  }
  for (const [id, pos] of Object.entries(engine.positions)) {
    engine._closePosition(id, currentPrices[id], 'EOW');
  }

  const eq = engine.equity(currentPrices);
  const pnl = eq - CAPITAL;
  const closedTrades = engine.trades.filter(t => t.side === 'SELL');
  const wins = closedTrades.filter(t => t.win);
  const allTrades = engine.trades.filter(t => t.side !== 'BUY');

  return {
    pnl: +pnl.toFixed(2),
    returnPct: +(pnl / CAPITAL * 100).toFixed(2),
    trades: closedTrades.length,
    allEvents: allTrades.length,
    winRate: closedTrades.length > 0 ? +(wins.length / closedTrades.length * 100).toFixed(1) : 0,
    partials: engine.trades.filter(t => t.side === 'PARTIAL1' || t.side === 'PARTIAL2').length,
  };
}

// ── Main ──────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════════════════');
console.log(`  APEX CRYPTO ${isGrowth ? 'V10 GROWTH' : 'V9 SAFE'} — SIMULATOR`);
console.log(`  Capital: €${CAPITAL} | Assets: ${ASSETS.map(a => a.id).join(', ')}`);
console.log(`  Running ${NUM_WEEKS} weekly simulations...`);
console.log('═══════════════════════════════════════════════════════════');
console.log('');

const results = [];
const startTime = Date.now();

for (let w = 0; w < NUM_WEEKS; w++) {
  const result = runOneWeek();
  results.push(result);

  if ((w + 1) % 50 === 0 || w === NUM_WEEKS - 1) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const avgPnl = (results.reduce((s, r) => s + r.pnl, 0) / results.length).toFixed(2);
    console.log(`  [${w + 1}/${NUM_WEEKS}] Avg P&L: €${avgPnl}/week (${elapsed}s elapsed)`);
  }
}

// ── Statistics ────────────────────────────────────────────────

const pnls = results.map(r => r.pnl).sort((a, b) => a - b);
const avg = +(pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2);
const med = +pnls[Math.floor(pnls.length / 2)].toFixed(2);
const min = +pnls[0].toFixed(2);
const max = +pnls[pnls.length - 1].toFixed(2);
const p5 = +pnls[Math.floor(pnls.length * 0.05)].toFixed(2);
const p25 = +pnls[Math.floor(pnls.length * 0.25)].toFixed(2);
const p75 = +pnls[Math.floor(pnls.length * 0.75)].toFixed(2);
const p95 = +pnls[Math.floor(pnls.length * 0.95)].toFixed(2);
const posWeeks = results.filter(r => r.pnl > 0).length;
const avgWR = +(results.reduce((s, r) => s + r.winRate, 0) / results.length).toFixed(1);
const avgTrades = +(results.reduce((s, r) => s + r.trades, 0) / results.length).toFixed(0);
const avgPartials = +(results.reduce((s, r) => s + r.partials, 0) / results.length).toFixed(0);
const stdDev = +Math.sqrt(pnls.reduce((s, p) => s + (p - avg) ** 2, 0) / pnls.length).toFixed(2);

console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log('  RESULTS');
console.log('═══════════════════════════════════════════════════════════');
console.log('');
console.log('  P&L DISTRIBUTION:');
console.log(`    Worst:     €${min} (${(min / CAPITAL * 100).toFixed(1)}%)`);
console.log(`    5%-tile:   €${p5} (${(p5 / CAPITAL * 100).toFixed(1)}%)`);
console.log(`    25%-tile:  €${p25} (${(p25 / CAPITAL * 100).toFixed(1)}%)`);
console.log(`    MEDIAN:    €${med} (${(med / CAPITAL * 100).toFixed(1)}%)`);
console.log(`    AVERAGE:   €${avg} (${(avg / CAPITAL * 100).toFixed(1)}%)`);
console.log(`    75%-tile:  €${p75} (${(p75 / CAPITAL * 100).toFixed(1)}%)`);
console.log(`    95%-tile:  €${p95} (${(p95 / CAPITAL * 100).toFixed(1)}%)`);
console.log(`    Best:      €${max} (${(max / CAPITAL * 100).toFixed(1)}%)`);
console.log(`    Std Dev:   €${stdDev}`);
console.log('');
console.log('  QUALITY METRICS:');
console.log(`    Win weeks:     ${posWeeks}/${NUM_WEEKS} (${(posWeeks / NUM_WEEKS * 100).toFixed(0)}%)`);
console.log(`    Avg Win Rate:  ${avgWR}% per trade`);
console.log(`    Avg Trades/w:  ${avgTrades} exits`);
console.log(`    Avg Partials:  ${avgPartials} partial profits/week`);
console.log('');
console.log('  REAL MARKET ESTIMATE (55% of simulator):');
console.log(`    Expected:  €${(avg * 0.55).toFixed(2)}/week`);
console.log(`    Monthly:   €${(avg * 0.55 * 4.33).toFixed(2)}`);
console.log(`    Annual:    €${(avg * 0.55 * 52).toFixed(2)} (${(avg * 0.55 / CAPITAL * 52 * 100).toFixed(0)}% ROI)`);
console.log('');
console.log('  SCALING PROJECTIONS:');
console.log(`    €2,000 spot:     €${(avg * 0.55).toFixed(0)}/week`);
console.log(`    €5,000 spot:     €${(avg * 0.55 * 2.5).toFixed(0)}/week`);
console.log(`    €5,000 + 2x lev: €${(avg * 0.55 * 5).toFixed(0)}/week`);
console.log(`    €10,000 spot:    €${(avg * 0.55 * 5).toFixed(0)}/week`);
console.log('');
console.log('═══════════════════════════════════════════════════════════');
console.log(`  Completed in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
console.log('═══════════════════════════════════════════════════════════');
