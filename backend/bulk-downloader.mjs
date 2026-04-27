// ═══════════════════════════════════════════════════════════════
//  Bulk Downloader — download top-25 Kraken USD pairs voor research
//  Onafhankelijk van config.ASSETS — bouwt brede edge-database.
// ═══════════════════════════════════════════════════════════════

import fs from 'fs/promises';

// Extended Kraken USD pair map — top ~25 liquid coins
const PAIRS = {
  BTCUSDT:  'XBTUSD',
  ETHUSDT:  'ETHUSD',
  SOLUSDT:  'SOLUSD',
  XRPUSDT:  'XRPUSD',
  DOGEUSD:  'XDGUSD',
  ADAUSDT:  'ADAUSD',
  LINKUSD:  'LINKUSD',
  AVAXUSD:  'AVAXUSD',
  DOTUSD:   'DOTUSD',
  MATICUSD: 'MATICUSD',
  ATOMUSD:  'ATOMUSD',
  LTCUSD:   'LTCUSD',
  UNIUSD:   'UNIUSD',
  AAVEUSD:  'AAVEUSD',
  ALGOUSD:  'ALGOUSD',
  FILUSD:   'FILUSD',
  NEARUSD:  'NEARUSD',
  APEUSD:   'APEUSD',
  SHIBUSD:  'SHIBUSD',
  TRXUSD:   'TRXUSD',
  INJUSD:   'INJUSD',
  ARBUSD:   'ARBUSD',
  OPUSD:    'OPUSD',
  SUIUSD:   'SUIUSD',
  PEPEUSD:  'PEPEUSD',
  TIAUSD:   'TIAUSD',
  RUNEUSD:  'RUNEUSD',
  FETUSD:   'FETUSD',
};

const DAYS_BACK = parseInt(process.env.DAYS_BACK || '90');
const CACHE_DIR = './cache';
const MAX_REQ_PER_ASSET = 2000;
const PARALLEL = parseInt(process.env.PARALLEL || '2'); // Kraken rate limits — lower for thin coins

async function fetchTrades(pair, sinceNs) {
  const url = `https://api.kraken.com/0/public/Trades?pair=${pair}&since=${sinceNs}&count=1000`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (json.error?.length) throw new Error(json.error.join(';'));
  const key = Object.keys(json.result).find(k => k !== 'last');
  return { trades: json.result[key] || [], last: json.result.last, key };
}

function bucketTo5m(trades) {
  const candles = new Map();
  for (const tr of trades) {
    const priceStr = tr[0], volStr = tr[1], ts = tr[2];
    const p = parseFloat(priceStr); const v = parseFloat(volStr);
    const tMs = Math.floor(ts * 1000 / 300000) * 300000;
    if (!candles.has(tMs)) candles.set(tMs, { t: tMs, o: p, h: p, l: p, c: p, v: v });
    else {
      const c = candles.get(tMs);
      c.c = p;
      if (p > c.h) c.h = p;
      if (p < c.l) c.l = p;
      c.v += v;
    }
  }
  return [...candles.values()].sort((a, b) => a.t - b.t);
}

function mergeBars(existing, fresh) {
  const map = new Map();
  for (const b of existing) map.set(b.t, b);
  for (const b of fresh) {
    if (!map.has(b.t)) map.set(b.t, b);
    else { // update last bar with new data
      const old = map.get(b.t);
      old.c = b.c;
      if (b.h > old.h) old.h = b.h;
      if (b.l < old.l) old.l = b.l;
      old.v += b.v;
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

async function downloadAsset(assetId) {
  const pair = PAIRS[assetId];
  if (!pair) return { assetId, error: 'no pair mapping' };
  let existing = [];
  let sinceNs;
  try {
    const raw = await fs.readFile(`${CACHE_DIR}/${assetId}.json`, 'utf8');
    const cached = JSON.parse(raw);
    existing = cached.bars || [];
    if (existing.length) {
      sinceNs = String((existing[existing.length - 1].t + 1000) * 1_000_000);
      console.log(`  ${assetId}: resume vanaf ${new Date(existing[existing.length-1].t).toISOString().slice(0,16)} (${existing.length} bars)`);
    }
  } catch (_) {}
  if (!sinceNs) {
    const startMs = Date.now() - DAYS_BACK * 86400_000;
    sinceNs = String(startMs * 1_000_000);
    console.log(`  ${assetId} (${pair}): cold start ${DAYS_BACK}d back`);
  }

  let allTrades = [];
  let req = 0;
  try {
    while (req < MAX_REQ_PER_ASSET) {
      let trades, last;
      let backoff = 1500;
      let attempts = 0;
      while (true) {
        try {
          const r = await fetchTrades(pair, sinceNs);
          trades = r.trades; last = r.last;
          break;
        } catch (e) {
          if (!String(e.message).includes('Too many requests') || attempts >= 6) throw e;
          attempts++;
          console.log(`    ${assetId}: rate-limit, backoff ${backoff/1000}s (attempt ${attempts})`);
          await new Promise(r => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 30000);
        }
      }
      req++;
      if (!trades.length) break;
      allTrades = allTrades.concat(trades);
      sinceNs = last;
      const lastTradeMs = trades[trades.length - 1][2] * 1000;
      if (Date.now() - lastTradeMs < 5 * 60_000) break;
      if (req % 25 === 0) console.log(`    ${assetId}: ${req} req, ${allTrades.length} trades`);
      await new Promise(r => setTimeout(r, 1500)); // safer rate limit
    }
  } catch (e) {
    console.log(`  ${assetId}: error after ${req} req: ${e.message}`);
    if (allTrades.length === 0) return { assetId, error: e.message };
  }

  const fresh = bucketTo5m(allTrades);
  const merged = mergeBars(existing, fresh);
  await fs.writeFile(`${CACHE_DIR}/${assetId}.json`, JSON.stringify({
    asset: assetId, pair, bars: merged, updated: Date.now(),
  }));
  const days = merged.length ? (merged[merged.length-1].t - merged[0].t) / 86400_000 : 0;
  console.log(`  ${assetId}: ${allTrades.length} trades → ${merged.length} bars (${days.toFixed(1)}d, ${req} req)`);
  return { assetId, bars: merged.length, days };
}

async function runPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) break;
      try { results[idx] = await fn(items[idx]); }
      catch (e) { results[idx] = { assetId: items[idx], error: e.message }; }
    }
  }
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  return results;
}

const args = process.argv.slice(2);
const targetAssets = args.length ? args : Object.keys(PAIRS);

await fs.mkdir(CACHE_DIR, { recursive: true });
const t0 = Date.now();
console.log(`═══ Bulk download ${targetAssets.length} pairs (${PARALLEL} parallel, ${DAYS_BACK}d) ═══\n`);
const results = await runPool(targetAssets, downloadAsset, PARALLEL);
const min = ((Date.now() - t0) / 60000).toFixed(1);
console.log(`\n═══ KLAAR in ${min}min ═══`);
console.log('Summary:');
for (const r of results.filter(Boolean).sort((a,b)=>a.assetId.localeCompare(b.assetId))) {
  if (r.error) console.log(`  ${r.assetId}: ERROR ${r.error}`);
  else console.log(`  ${r.assetId}: ${r.bars} bars (${r.days?.toFixed(1)}d)`);
}
