// ═══════════════════════════════════════════════════════════════
//  V32 — Kraken Futures Funding Rate Client
//  Free, no-auth tickers endpoint. Used to:
//    - Block long entries on overheated funding (>+0.05%/4h)
//    - Boost short conviction when funding > +0.10%/4h
//    - Block short entries on inverse-overheated funding (<-0.05%/4h)
//
//  fundingRate from Kraken is the *current rate* per 4h interval (signed).
//  Source: https://futures.kraken.com/derivatives/api/v3/tickers
// ═══════════════════════════════════════════════════════════════

import { log } from './logger.mjs';
import { FUTURES_SYMBOL } from './kraken-futures-client.mjs';

const TICKERS_URL  = 'https://futures.kraken.com/derivatives/api/v3/tickers';
const REFRESH_MS   = 30 * 60 * 1000; // refresh elke 30 min
const MAX_AGE_MS   = 60 * 60 * 1000; // stale na 1u

// Thresholds (per 4h funding interval)
export const FUNDING_BLOCK_LONG_AT  = 0.0005;   // +0.05% → too crowded longs, block long entries
export const FUNDING_FORCE_SHORT_AT = 0.0010;   // +0.10% → premium high enough to bias short
export const FUNDING_BLOCK_SHORT_AT = -0.0005;  // -0.05% → crowded shorts, block short entries

let cache = {}; // assetId → { fundingRate, fetchedAt }
let lastFetch = 0;
let inFlight = null;

async function fetchTickers() {
  const resp = await fetch(TICKERS_URL);
  if (!resp.ok) throw new Error(`Kraken tickers HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.result !== 'success') throw new Error(`Kraken tickers result=${json.result}`);
  return json.tickers || [];
}

/**
 * Refresh funding rate cache. Idempotent + dedupes parallel calls.
 */
export async function refreshFunding() {
  const now = Date.now();
  if (now - lastFetch < REFRESH_MS && Object.keys(cache).length > 0) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const tickers = await fetchTickers();
      const symbolToAsset = Object.fromEntries(
        Object.entries(FUTURES_SYMBOL).map(([asset, sym]) => [sym, asset])
      );
      const updated = {};
      for (const t of tickers) {
        const assetId = symbolToAsset[t.symbol];
        if (!assetId) continue;
        if (typeof t.fundingRate !== 'number') continue;
        updated[assetId] = { fundingRate: t.fundingRate, fetchedAt: now, symbol: t.symbol };
      }
      cache = updated;
      lastFetch = now;
      log.info(`Funding cache refreshed: ${Object.keys(cache).length} assets`);
    } catch (e) {
      log.warn('Funding refresh failed', { err: e.message });
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Get current funding rate for asset (synchronous; uses cache).
 * Returns null if no data or stale.
 */
export function getFunding(assetId) {
  const entry = cache[assetId];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > MAX_AGE_MS) return null;
  return entry.fundingRate;
}

/**
 * Filter helper: should we block a long entry due to overheated funding?
 */
export function blockLongDueToFunding(assetId) {
  const fr = getFunding(assetId);
  if (fr === null) return { blocked: false, fundingRate: null };
  return { blocked: fr >= FUNDING_BLOCK_LONG_AT, fundingRate: fr };
}

/**
 * Filter helper: should we block a short entry due to over-discounted funding?
 */
export function blockShortDueToFunding(assetId) {
  const fr = getFunding(assetId);
  if (fr === null) return { blocked: false, fundingRate: null };
  return { blocked: fr <= FUNDING_BLOCK_SHORT_AT, fundingRate: fr };
}

/**
 * Should we boost short conviction (because funding very high = squeeze risk)?
 */
export function shouldBoostShort(assetId) {
  const fr = getFunding(assetId);
  if (fr === null) return false;
  return fr >= FUNDING_FORCE_SHORT_AT;
}

/**
 * Periodic background refresh — call once at server startup.
 */
export function startFundingPoller(intervalMs = REFRESH_MS) {
  refreshFunding().catch(() => {});
  setInterval(() => refreshFunding().catch(() => {}), intervalMs);
}

export function getFundingCache() {
  return { ...cache, lastFetch };
}
