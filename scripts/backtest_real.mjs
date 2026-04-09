#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V9 — Real-Data Backtest
//  Fetches real Kraken OHLCV and replays through engine
//  Run: node scripts/backtest_real.mjs
//  Optional: node scripts/backtest_real.mjs --days=14
// ═══════════════════════════════════════════════════════════════

import 'dotenv/config';
import { Kraken } from 'node-kraken-api';
import { TradingEngine } from '../backend/engine.mjs';
import {
  ASSETS, CAPITAL, HISTORY_BARS,
  CANDLE_INTERVAL, TF15_INTERVAL, REGIME_INTERVAL,
  KRAKEN_API_KEY, KRAKEN_API_SECRET,
} from '../backend/config.mjs';

// ── CLI args ──────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => a.slice(2).split('='))
);
// Kraken stores max 720 5m bars = ~60h. Use 3 days to stay within range.
// For longer backtests, bars must be recorded locally as they arrive.
const DAYS   = parseInt(args.days || '3', 10);
const QUIET  = args.quiet === 'true';

// ── Kraken REST ───────────────────────────────────────────────
const api = new Kraken({ key: KRAKEN_API_KEY, secret: KRAKEN_API_SECRET });
const INTERVAL_MAP = { '5': 5, '15': 15, '60': 60 };

// Fetch all bars since a given timestamp, paginating as needed (Kraken caps at 720/call)
async function fetchKlines(krakenPair, interval, since) {
  const intervalMin = INTERVAL_MAP[interval] || 5;
  const allBars = [];
  let cursor = Math.floor(since / 1000); // Kraken uses seconds
  const nowSec = Math.floor(Date.now() / 1000);
  let pages = 0;

  while (cursor < nowSec && pages < 20) {
    pages++;
    const resp = await api.ohlc({ pair: krakenPair, interval: intervalMin, since: cursor });
    const pairKey = Object.keys(resp).find(k => k !== 'last');
    const bars = resp[pairKey] || [];

    if (bars.length === 0) break;

    // Drop last (in-progress) bar
    const closed = bars.slice(0, -1);
    for (const b of closed) {
      allBars.push({
        timestamp: Number(b[0]) * 1000,
        open:   parseFloat(b[1]),
        high:   parseFloat(b[2]),
        low:    parseFloat(b[3]),
        close:  parseFloat(b[4]),
        volume: parseFloat(b[6]),
      });
    }

    if (bars.length < 2) break; // nothing useful returned

    // Advance cursor to just after the last bar's timestamp
    const lastBarTs = Number(bars[bars.length - 1][0]); // seconds
    if (lastBarTs <= cursor) break; // safety: no progress
    cursor = lastBarTs + 1;

    await new Promise(r => setTimeout(r, 250)); // rate limit
  }

  // Deduplicate by timestamp and sort
  const seen = new Set();
  return allBars.filter(b => {
    if (seen.has(b.timestamp)) return false;
    seen.add(b.timestamp);
    return true;
  }).sort((a, b) => a.timestamp - b.timestamp);
}

// ── Build bar arrays from candle list ─────────────────────────
function buildBuffers(candles) {
  return {
    closes:     candles.map(c => c.close),
    highs:      candles.map(c => c.high),
    lows:       candles.map(c => c.low),
    volumes:    candles.map(c => c.volume),
    timestamps: candles.map(c => c.timestamp),
  };
}

function sliceWindow(buf, upTo, size) {
  const end = upTo + 1;
  const start = Math.max(0, end - size);
  return {
    closes:     buf.closes.slice(start, end),
    highs:      buf.highs.slice(start, end),
    lows:       buf.lows.slice(start, end),
    volumes:    buf.volumes.slice(start, end),
    timestamps: buf.timestamps.slice(start, end),
  };
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const since = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  const startLabel = new Date(since).toISOString().slice(0, 10);
  const endLabel   = new Date().toISOString().slice(0, 10);

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  APEX CRYPTO V9 — REAL-DATA BACKTEST');
  console.log(`  Period : ${startLabel} → ${endLabel} (${DAYS} days)`);
  console.log(`  Assets : ${ASSETS.length} × Kraken OHLCV`);
  console.log(`  Capital: $${CAPITAL}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Fetching Kraken data...');

  // Fetch all bars for all assets and timeframes
  const rawBars = {}; // assetId → { '5': [...], '15': [...], '60': [...] }
  let fetchErrors = 0;

  for (const asset of ASSETS) {
    rawBars[asset.id] = {};
    for (const interval of [CANDLE_INTERVAL, TF15_INTERVAL, REGIME_INTERVAL]) {
      try {
        const candles = await fetchKlines(asset.krakenPair, interval, since);
        rawBars[asset.id][interval] = candles;
        if (!QUIET) {
          process.stdout.write(`  ${asset.id} [${interval}m]: ${candles.length} bars\n`);
        }
        await new Promise(r => setTimeout(r, 250)); // rate limit
      } catch (err) {
        console.warn(`  WARN: ${asset.id} [${interval}m] fetch failed — ${err.message}`);
        rawBars[asset.id][interval] = [];
        fetchErrors++;
      }
    }
  }

  // Build full buffer arrays
  const bufs = {};
  for (const asset of ASSETS) {
    bufs[asset.id] = {};
    for (const interval of [CANDLE_INTERVAL, TF15_INTERVAL, REGIME_INTERVAL]) {
      bufs[asset.id][interval] = buildBuffers(rawBars[asset.id][interval] || []);
    }
  }

  // Determine replay timeline from BTC 5m bars (master clock)
  const btcBars5m = rawBars['BTCUSDT']?.[CANDLE_INTERVAL] || [];
  if (btcBars5m.length < 50) {
    console.error('  ERROR: Not enough BTC bars to run backtest. Check API keys.');
    process.exit(1);
  }

  console.log(`\n  Replaying ${btcBars5m.length} 5m bars...\n`);

  const engine = new TradingEngine(CAPITAL, { simMode: true });
  let tickCount = 0;

  for (let i = HISTORY_BARS; i < btcBars5m.length; i++) {
    const currentTs = btcBars5m[i].timestamp;

    // Build snapshot windows for each asset at this point in time
    const barData5m  = {};
    const barData15m = {};
    const barDataReg = {};

    for (const asset of ASSETS) {
      const buf5  = bufs[asset.id][CANDLE_INTERVAL];
      const buf15 = bufs[asset.id][TF15_INTERVAL];
      const buf60 = bufs[asset.id][REGIME_INTERVAL];

      // Find the bar index at or just before currentTs
      const idx5 = buf5.timestamps.findLastIndex(t => t <= currentTs);
      if (idx5 >= 20) {
        barData5m[asset.id] = sliceWindow(buf5, idx5, HISTORY_BARS);
      }

      const idx15 = buf15.timestamps.findLastIndex(t => t <= currentTs);
      if (idx15 >= 10) {
        barData15m[asset.id] = sliceWindow(buf15, idx15, HISTORY_BARS);
      }

      const idx60 = buf60.timestamps.findLastIndex(t => t <= currentTs);
      if (idx60 >= 10) {
        barDataReg[asset.id] = sliceWindow(buf60, idx60, HISTORY_BARS);
      }
    }

    // Reset daily risk every 288 bars (~1 day)
    if (tickCount > 0 && tickCount % 288 === 0) {
      engine.riskState.dailyLoss = 0;
      engine.riskState.riskReduction = Math.max(engine.riskState.riskReduction || 1, 1.0);
    }

    engine.tick(barData5m, barDataReg, barData15m);
    tickCount++;
  }

  // Force close remaining positions
  const finalPrices = {};
  for (const asset of ASSETS) {
    const buf = bufs[asset.id][CANDLE_INTERVAL];
    if (buf.closes.length > 0) finalPrices[asset.id] = buf.closes[buf.closes.length - 1];
  }
  for (const [id] of Object.entries(engine.positions)) {
    engine._closePosition(id, finalPrices[id] || 0, 'EOT');
  }

  // ── Results ────────────────────────────────────────────────
  const allTrades  = engine.trades.filter(t => !['BUY', 'SHORT_OPEN'].includes(t.side));
  const fullExits  = allTrades.filter(t => ['SELL', 'SHORT_CLOSE', 'SL', 'TP', 'TRAIL', 'MAX_BARS', 'EOT'].includes(t.side));
  const partials   = allTrades.filter(t => t.side === 'PARTIAL1' || t.side === 'PARTIAL2');
  const wins       = fullExits.filter(t => (t.pnl || 0) > 0);
  const losses     = fullExits.filter(t => (t.pnl || 0) <= 0);

  const totalPnl   = allTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossWin   = wins.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : Infinity;
  const winRate    = fullExits.length > 0 ? +(wins.length / fullExits.length * 100).toFixed(1) : 0;
  const maxDd      = engine.riskState?.maxDrawdown ? +(engine.riskState.maxDrawdown * 100).toFixed(2) : 0;

  const finalEq  = engine.equity(finalPrices);
  const returnPct = +((finalEq - CAPITAL) / CAPITAL * 100).toFixed(2);

  // Per-asset breakdown
  const byAsset = {};
  for (const t of fullExits) {
    const key = t.id || t.assetId || 'unknown';
    if (!byAsset[key]) byAsset[key] = { trades: 0, wins: 0, pnl: 0 };
    byAsset[key].trades++;
    if ((t.pnl || 0) > 0) byAsset[key].wins++;
    byAsset[key].pnl += t.pnl || 0;
  }

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('  SUMMARY:');
  console.log(`    Total P&L:      $${totalPnl.toFixed(2)} (${returnPct}%)`);
  console.log(`    Final Equity:   $${finalEq.toFixed(2)}`);
  console.log(`    Profit Factor:  ${profitFactor}`);
  console.log(`    Win Rate:       ${winRate}% (${wins.length}W / ${losses.length}L)`);
  console.log(`    Full Exits:     ${fullExits.length}`);
  console.log(`    Partials:       ${partials.length}`);
  console.log(`    Max Drawdown:   ${maxDd}%`);
  console.log(`    Fetch Errors:   ${fetchErrors}`);
  console.log('');
  console.log('  EXIT TYPES:');
  const exitTypes = {};
  for (const t of fullExits) exitTypes[t.side] = (exitTypes[t.side] || 0) + 1;
  for (const [type, cnt] of Object.entries(exitTypes)) {
    console.log(`    ${type.padEnd(14)} ${cnt}`);
  }
  console.log('');
  console.log('  PER-ASSET (sorted by P&L):');
  const sorted = Object.entries(byAsset).sort((a, b) => b[1].pnl - a[1].pnl);
  for (const [id, s] of sorted) {
    const wr = s.trades > 0 ? (s.wins / s.trades * 100).toFixed(0) : 0;
    console.log(`    ${id.padEnd(10)} ${s.trades}t  ${wr}%WR  $${s.pnl.toFixed(2)}`);
  }
  console.log('');
  console.log('  WEEKLY ESTIMATE:');
  const weeks = DAYS / 7;
  console.log(`    Avg/week:   $${(totalPnl / weeks).toFixed(2)}`);
  console.log(`    Avg trades: ${(fullExits.length / weeks).toFixed(0)}/week`);
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Backtest failed:', err.message);
  process.exit(1);
});
