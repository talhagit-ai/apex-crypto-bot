// ═══════════════════════════════════════════════════════════════
//  V36 — CryptoPanic News Client
//  Detect high-impact crypto events → pause bot 30 min, dan
//  0.5× sizing voor 1h.
//
//  Free tier: ~200 req/hour, auth_token verplicht.
//  Set CRYPTOPANIC_API_TOKEN environment variable.
// ═══════════════════════════════════════════════════════════════

import { log } from './logger.mjs';

const TOKEN = process.env.CRYPTOPANIC_API_TOKEN || '';
const POSTS_URL = 'https://cryptopanic.com/api/v1/posts/';
const POLL_INTERVAL_MS = 5 * 60 * 1000;   // poll elke 5 min
const PAUSE_MS         = 30 * 60 * 1000;  // 30 min full pause
const REDUCED_MS       = 60 * 60 * 1000;  // +60 min reduced sizing

// High-impact keywords. CryptoPanic doesn't tag these directly so we filter
// on title text (lowercased).
const HIGH_IMPACT_KEYWORDS = [
  'sec ', 'cftc', 'lawsuit', 'sued',
  'hack', 'hacked', 'exploit', 'rug',
  'liquidat', 'crash', 'plunge', 'plummet',
  'ban', 'banned', 'shutdown', 'shut down',
  'outage', 'halt', 'halted',
  'fed ', 'cpi', 'inflation', 'rate hike', 'rate cut',
  'bankruptc', 'insolven',
];

let pauseUntil    = 0;
let reducedUntil  = 0;
let lastPolledIds = new Set();
let lastTrigger   = null;

async function fetchPosts() {
  if (!TOKEN) return [];
  const url = `${POSTS_URL}?auth_token=${TOKEN}&public=true&kind=news&filter=hot&currencies=BTC,ETH,SOL,XRP,DOGE,AVAX`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`CryptoPanic HTTP ${resp.status}`);
  const json = await resp.json();
  return json.results || [];
}

function isHighImpact(post) {
  const title = (post.title || '').toLowerCase();
  return HIGH_IMPACT_KEYWORDS.some(k => title.includes(k));
}

export async function pollNews() {
  if (!TOKEN) return;
  try {
    const posts = await fetchPosts();
    const now = Date.now();
    for (const p of posts) {
      const id = p.id || p.slug;
      if (lastPolledIds.has(id)) continue;
      lastPolledIds.add(id);
      if (isHighImpact(p)) {
        pauseUntil   = Math.max(pauseUntil,   now + PAUSE_MS);
        reducedUntil = Math.max(reducedUntil, now + PAUSE_MS + REDUCED_MS);
        lastTrigger = { title: p.title, url: p.url, ts: now };
        log.warn(`NEWS PAUSE triggered: "${p.title}"`);
      }
    }
    // Cap memory: keep last 200 IDs
    if (lastPolledIds.size > 200) {
      lastPolledIds = new Set([...lastPolledIds].slice(-150));
    }
  } catch (e) {
    log.warn('News poll failed', { err: e.message });
  }
}

export function isNewsPaused() {
  return Date.now() < pauseUntil;
}

export function newsRiskMult() {
  const now = Date.now();
  if (now < pauseUntil)   return 0;    // hard block
  if (now < reducedUntil) return 0.5;  // reduced sizing post-event
  return 1.0;
}

export function startNewsPoller(intervalMs = POLL_INTERVAL_MS) {
  if (!TOKEN) {
    log.info('CRYPTOPANIC_API_TOKEN not set — news pause disabled');
    return;
  }
  pollNews().catch(() => {});
  setInterval(() => pollNews().catch(() => {}), intervalMs);
}

export function getNewsState() {
  return {
    enabled: !!TOKEN,
    pauseUntil, reducedUntil,
    isPaused: isNewsPaused(),
    riskMult: newsRiskMult(),
    lastTrigger,
  };
}
