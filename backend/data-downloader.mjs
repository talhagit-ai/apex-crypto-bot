// ═══════════════════════════════════════════════════════════════
//  APEX Data Downloader — fetch Kraken trades, build 5m candles
//  Doel: 14 dagen historie per asset → ./cache/<ASSET>.json
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import { ASSETS } from './config.mjs';

const PAIRS = { BTCUSDT: 'XBTUSD', ETHUSDT: 'ETHUSD', SOLUSDT: 'SOLUSD',
                XRPUSDT: 'XRPUSD', ADAUSDT: 'ADAUSD', LINKUSD: 'LINKUSD',
                AVAXUSD: 'AVAXUSD', DOGEUSD: 'XDGUSD' };

const DAYS_BACK = parseInt(process.env.DAYS_BACK || '90');
const CACHE_DIR = './cache';
const MAX_REQ_PER_ASSET = 2000; // ruim genoeg voor 3 maanden
const PARALLEL = parseInt(process.env.PARALLEL || '4'); // parallel downloads

async function fetchTrades(pair, sinceNs) {
  const url = `https://api.kraken.com/0/public/Trades?pair=${pair}&since=${sinceNs}&count=1000`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (json.error?.length) throw new Error(json.error.join(';'));
  const key = Object.keys(json.result).find(k => k !== 'last');
  return { trades: json.result[key] || [], last: json.result.last };
}

function bucketTo5m(trades) {
  // trades: [[price, volume, timestamp, side, type, misc, trade_id], ...]
  const candles = new Map();
  for (const [priceStr, volStr, ts] of trades) {
    const price = +priceStr;
    const vol   = +volStr;
    const bucket = Math.floor(ts / 300) * 300; // 5m = 300s
    if (!candles.has(bucket)) {
      candles.set(bucket, { t: bucket * 1000, o: price, h: price, l: price, c: price, v: 0 });
    }
    const c = candles.get(bucket);
    if (price > c.h) c.h = price;
    if (price < c.l) c.l = price;
    c.c = price;
    c.v += vol;
  }
  return [...candles.values()].sort((a, b) => a.t - b.t);
}

async function downloadAsset(assetId) {
  const pair = PAIRS[assetId];
  if (!pair) return null;
  const cachePath = `${CACHE_DIR}/${assetId}.json`;

  // Check bestaande cache — RESUME vanaf laatst bekende bar
  let existing = null;
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    existing = JSON.parse(raw);
  } catch (_) {}

  const startTarget = Date.now() - DAYS_BACK * 86400 * 1000;
  let startNs;
  const existingBars = existing?.bars || [];
  if (existingBars.length > 0) {
    // Resume vanaf laatste bar +1s
    const lastBarMs = existingBars[existingBars.length - 1].t;
    startNs = BigInt(lastBarMs + 1000) * 1_000_000n;
    console.log(`  ${assetId}: resume vanaf ${new Date(lastBarMs).toISOString()} (${existingBars.length} bars in cache)`);
  } else {
    startNs = BigInt(startTarget) * 1_000_000n;
  }

  let since = startNs.toString();
  const allTrades = [];
  let requests = 0;

  console.log(`  ${assetId} (${pair}): downloading trades vanaf ${new Date(Number(startNs / 1_000_000n)).toISOString()}`);

  while (requests < MAX_REQ_PER_ASSET) {
    try {
      const { trades, last } = await fetchTrades(pair, since);
      if (!trades.length) break;
      allTrades.push(...trades);
      requests++;
      // `last` is next-since pointer (nanoseconds)
      if (last === since) break;
      since = last;
      // Stop als we voorbij vandaag zijn
      const lastTs = trades[trades.length - 1][2] * 1000;
      if (lastTs >= Date.now() - 60_000) break;
      // Progress elke 50 requests
      if (requests % 50 === 0) {
        const daysDone = (lastTs - Number(startNs/1_000_000n)) / 86400_000;
        console.log(`    ${assetId}: ${requests} req, ${allTrades.length} trades, ${daysDone.toFixed(1)}/${DAYS_BACK}d`);
      }
      await new Promise(r => setTimeout(r, 2000)); // conservatief: 30/min, voorkomt Too many requests
    } catch (e) {
      // Retry met exponential backoff bij rate limit
      if (e.message.includes('Rate') || e.message.includes('Too many') || e.message.includes('429')) {
        const wait = Math.min(60_000, 10_000 * Math.pow(1.5, requests % 5));
        console.log(`    ${assetId}: rate limit — wacht ${(wait/1000).toFixed(0)}s`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      console.log(`  ${assetId}: fout na ${requests} req, ${allTrades.length} trades — ${e.message}`);
      break;
    }
  }

  // Merge nieuwe bars met bestaande cache
  const newBars = bucketTo5m(allTrades);
  const mergedMap = new Map();
  for (const b of existingBars) mergedMap.set(b.t, b);
  for (const b of newBars) mergedMap.set(b.t, b);
  const bars = [...mergedMap.values()].sort((a, b) => a.t - b.t);

  const result = {
    assetId, pair, downloadedAt: Date.now(),
    requests, tradeCount: (existing?.tradeCount || 0) + allTrades.length,
    bars,
    timespan: bars.length
      ? { first: new Date(bars[0].t).toISOString(), last: new Date(bars[bars.length-1].t).toISOString(),
          hours: (bars[bars.length-1].t - bars[0].t) / 3600_000 }
      : null,
  };

  await fs.writeFile(cachePath, JSON.stringify(result));
  console.log(`  ${assetId}: ${allTrades.length} trades → ${bars.length} × 5m bars over ${result.timespan?.hours.toFixed(0) || 0}u (${requests} req)`);
  return result;
}

// Main — parallel met semaphore
console.log(`═══ Downloading ${DAYS_BACK}d data voor ${ASSETS.length} assets (${PARALLEL} parallel) ═══\n`);
const start = Date.now();

async function runPool(items, workerFn, parallel) {
  const results = [];
  const queue = [...items];
  const workers = Array(parallel).fill(0).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      try {
        const r = await workerFn(item);
        results.push(r);
      } catch (e) {
        console.log(`Worker error: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
  return results;
}

const results = await runPool(ASSETS, a => downloadAsset(a.id), PARALLEL);

console.log(`\n═══ KLAAR in ${((Date.now()-start)/1000/60).toFixed(1)}min ═══`);
console.log('Summary:');
for (const r of results.filter(Boolean).sort((a,b)=>a.assetId.localeCompare(b.assetId))) {
  console.log(`  ${r.assetId}: ${r.bars.length} bars (${(r.timespan?.hours/24).toFixed(1)}d)`);
}
