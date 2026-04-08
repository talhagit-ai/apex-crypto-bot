// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V7 — Self-Learning Engine (Enhanced)
//  Real-time updates · Bayesian win rates · Recency decay
//  Factor interactions · Regime×Factor matrix · Session tracking
// ═══════════════════════════════════════════════════════════════

import { getTradeAnalytics } from './persistence.mjs';
import { log } from './logger.mjs';

// ── Statistical helpers ────────────────────────────────────────

/**
 * Wilson score lower bound — Bayesian conservative win rate estimate.
 * Returns meaningful estimate from even 1 trade (prior = 50%).
 * z=1.28 = 80% CI (practical, not overly conservative).
 */
function wilsonLower(wins, total, z = 1.28) {
  if (total === 0) return 0.50;
  const p    = wins / total;
  const z2   = z * z;
  const denom  = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt(p * (1 - p) / total + z2 / (4 * total * total));
  return (centre - spread) / denom;
}

/**
 * Exponential recency weight.
 * tradeIndex=0 = oldest, tradeIndex=n-1 = newest.
 * halfLife=25: weight halves every 25 trades → adapts to regime change in ~50 trades.
 */
function recencyWeight(tradeIndex, total, halfLife = 25) {
  const age = total - 1 - tradeIndex; // 0 = newest
  return Math.pow(0.5, age / halfLife);
}

/** UTC hour → trading session */
function session(h) {
  if (h >= 0  && h < 8)  return 'asia';
  if (h >= 8  && h < 16) return 'europe';
  return 'us';
}

/** Timestamp → day-of-week label */
function dow(ts) {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(ts || Date.now()).getDay()];
}

// ── Group builder (weighted + Bayesian) ────────────────────────

function buildGroups(trades, keyFn) {
  const groups = {};
  const n = trades.length;
  for (let i = 0; i < n; i++) {
    const t = trades[i];
    const key = keyFn(t);
    if (key == null) continue;
    const w = recencyWeight(i, n);
    if (!groups[key]) groups[key] = { wins: 0, losses: 0, totalPnl: 0, totalR: 0, count: 0, wWins: 0, wTotal: 0 };
    const g = groups[key];
    g.count++;
    g.totalPnl += t.pnl || 0;
    g.totalR   += t.r_multiple || 0;
    g.wTotal   += w;
    if ((t.pnl || 0) > 0) { g.wins++; g.wWins += w; }
    else g.losses++;
  }
  for (const g of Object.values(groups)) {
    // Weighted Bayesian win rate (uniform prior α=β=1)
    g.winRate      = (g.wWins + 1) / (g.wTotal + 2);
    // Wilson lower bound for conservative signal (uses raw counts)
    g.winRateLower = wilsonLower(g.wins, g.count);
    g.avgPnl = g.totalPnl / Math.max(g.count, 1);
    g.avgR   = g.totalR   / Math.max(g.count, 1);
  }
  return groups;
}

// ── Incremental group patcher ──────────────────────────────────

function patchGroup(group, key, pnl, rMul, win) {
  if (key == null) return;
  if (!group[key]) group[key] = { wins: 0, losses: 0, totalPnl: 0, totalR: 0, count: 0, wWins: 0, wTotal: 0 };
  const g = group[key];
  // New trade gets maximum recency weight (1.0) relative to existing entries
  const w = 1.0;
  g.count++;  g.totalPnl += pnl;  g.totalR += rMul;
  g.wTotal += w;
  if (win) { g.wins++; g.wWins += w; }
  else g.losses++;
  g.winRate      = (g.wWins + 1) / (g.wTotal + 2);
  g.winRateLower = wilsonLower(g.wins, g.count);
  g.avgPnl       = g.totalPnl / g.count;
  g.avgR         = g.totalR   / g.count;
}

// ══════════════════════════════════════════════════════════════
export class LearningEngine {
  constructor() {
    this.profiles    = {};
    this.lastRefresh = 0;
    this.REFRESH_MS  = 5 * 60 * 1000; // full DB sync every 5 min
    // No MIN_TRADES gate — Bayesian handles low-data gracefully from trade 1
  }

  // ── Real-time: called IMMEDIATELY when a trade closes ─────────
  recordTrade(trade) {
    this._patchProfiles(trade);
    const wr = this.profiles.byAsset?.[trade.asset]?.winRate;
    log.info('Learning: live update', {
      asset:   trade.asset,
      side:    trade.side,
      pnl:     trade.pnl?.toFixed(2),
      assetWR: wr ? (wr * 100).toFixed(0) + '%' : 'n/a',
    });
  }

  /** Incrementally patch all in-memory profiles with one new trade */
  _patchProfiles(t) {
    if (!this.profiles.byAsset) return; // not initialized yet — wait for full refresh

    const hour = t.entry_hour_utc ?? new Date().getUTCHours();
    const ts   = t.timestamp || Date.now();
    const pnl  = t.pnl || 0;
    const rMul = t.r_multiple || 0;
    const win  = pnl > 0;

    // Core group patches
    patchGroup(this.profiles.byAsset,   t.asset,              pnl, rMul, win);
    patchGroup(this.profiles.byHour,    hour,                 pnl, rMul, win);
    patchGroup(this.profiles.bySession, session(hour),        pnl, rMul, win);
    patchGroup(this.profiles.byDow,     dow(ts),              pnl, rMul, win);
    patchGroup(this.profiles.byRegime,  t.regime,             pnl, rMul, win);
    patchGroup(this.profiles.byVolReg,  t.vol_regime,         pnl, rMul, win);
    patchGroup(this.profiles.byConf,    t.conf,               pnl, rMul, win);
    patchGroup(this.profiles.byExit,    t.exit_reason,        pnl, rMul, win);
    patchGroup(this.profiles.byPaperVsReal, t.paper_only ? 'paper' : 'real', pnl, rMul, win);

    // Factor correlation patch
    const factors = typeof t.factors === 'string' ? JSON.parse(t.factors || '{}') : (t.factors || {});
    const fc = this.profiles.byFactor || (this.profiles.byFactor = {});
    for (const [key, active] of Object.entries(factors)) {
      if (!fc[key]) fc[key] = { trueWins: 0, trueCount: 0, count: 0 };
      fc[key].count++;
      if (active) {
        fc[key].trueCount++;
        if (win) fc[key].trueWins++;
      }
      fc[key].winCorrelation = (fc[key].trueWins + 1) / (fc[key].trueCount + 2);
    }

    // Regime × Factor matrix patch
    const regime  = t.regime || 'neutral';
    const rMatrix = this.profiles.byRegimeXFactor || (this.profiles.byRegimeXFactor = {});
    if (!rMatrix[regime]) rMatrix[regime] = {};
    for (const [key, active] of Object.entries(factors)) {
      if (!active) continue;
      if (!rMatrix[regime][key]) rMatrix[regime][key] = { wins: 0, count: 0, wWins: 0, wTotal: 0 };
      rMatrix[regime][key].count++;
      rMatrix[regime][key].wTotal += 1;
      if (win) { rMatrix[regime][key].wins++; rMatrix[regime][key].wWins += 1; }
      rMatrix[regime][key].winRate = (rMatrix[regime][key].wWins + 1) / (rMatrix[regime][key].wTotal + 2);
    }

    // Factor interaction pairs patch
    const fi = this.profiles.byFactorInteraction || (this.profiles.byFactorInteraction = {});
    const activeKeys = Object.entries(factors).filter(([, v]) => v).map(([k]) => k);
    for (let i = 0; i < activeKeys.length; i++) {
      for (let j = i + 1; j < activeKeys.length; j++) {
        const pair = `${activeKeys[i]}+${activeKeys[j]}`;
        if (!fi[pair]) fi[pair] = { wins: 0, count: 0 };
        fi[pair].count++;
        if (win) fi[pair].wins++;
        fi[pair].winRate = wilsonLower(fi[pair].wins, fi[pair].count);
      }
    }
  }

  // ── Full DB refresh (recency-weighted, every 5 min) ───────────
  async refresh() {
    if (Date.now() - this.lastRefresh < this.REFRESH_MS) return;
    try {
      // Fetch trades ordered OLDEST FIRST so recencyWeight(i, n) works correctly
      const trades = await getTradeAnalytics(1000);
      if (!trades.length) { this.lastRefresh = Date.now(); return; }

      this.profiles = {
        byAsset:             buildGroups(trades, t => t.asset),
        byHour:              buildGroups(trades, t => t.entry_hour_utc),
        bySession:           buildGroups(trades, t => session(t.entry_hour_utc || 0)),
        byDow:               buildGroups(trades, t => dow(t.timestamp || 0)),
        byRegime:            buildGroups(trades, t => t.regime),
        byVolReg:            buildGroups(trades, t => t.vol_regime),
        byConf:              buildGroups(trades, t => t.conf),
        byExit:              buildGroups(trades, t => t.exit_reason),
        byPaperVsReal:       buildGroups(trades, t => t.paper_only ? 'paper' : 'real'),
        byFactor:            this._buildFactorCorrelation(trades),
        byFactorInteraction: this._buildFactorInteractions(trades),
        byRegimeXFactor:     this._buildRegimeFactorMatrix(trades),
        byHoldBars:          this._buildHoldBuckets(trades),
      };

      this.lastRefresh = Date.now();
      log.info('Learning engine synced', {
        trades: trades.length,
        assets: Object.keys(this.profiles.byAsset).length,
        topAsset: this._topAsset(),
      });
    } catch (e) {
      log.warn('Learning engine refresh failed', { err: e.message });
    }
  }

  // ── Signal scoring (0.40 – 1.60 multiplier) ──────────────────
  scoreSignal(asset, hourUTC, regime, volRegime, conf, factors) {
    if (!this.profiles.byAsset) return 1.0;

    let score = 1.0;
    const sess = session(hourUTC || 0);

    // 1. Asset historical performance
    const ap = this.profiles.byAsset?.[asset];
    if (ap && ap.count >= 1) {
      if      (ap.winRateLower < 0.28) score *= 0.60;   // persistent loser
      else if (ap.winRate      < 0.40) score *= 0.82;
      else if (ap.winRate      > 0.62) score *= 1.28;   // star performer
      else if (ap.winRate      > 0.52) score *= 1.12;
    }

    // 2. Trading session (3 buckets: learns 8× faster than per-hour)
    const sp = this.profiles.bySession?.[sess];
    if (sp && sp.count >= 2) {
      if      (sp.avgPnl  < -0.4) score *= 0.80;
      else if (sp.winRate >  0.58) score *= 1.12;
      else if (sp.winRate <  0.38) score *= 0.85;
    }

    // 3. Hour (granular, only use once we have enough data)
    const hp = this.profiles.byHour?.[hourUTC];
    if (hp && hp.count >= 4) {
      if      (hp.avgPnl  < -0.3) score *= 0.88;
      else if (hp.winRate >  0.62) score *= 1.10;
    }

    // 4. Macro regime performance
    const rp = this.profiles.byRegime?.[regime];
    if (rp && rp.count >= 3) {
      if      (rp.winRateLower < 0.22) score *= 0.68;
      else if (rp.winRate      > 0.58) score *= 1.12;
    }

    // 5. Volatility regime
    const vp = this.profiles.byVolReg?.[volRegime];
    if (vp && vp.count >= 3) {
      if      (vp.winRate < 0.35) score *= 0.82;
      else if (vp.winRate > 0.58) score *= 1.10;
    }

    // 6. Factor effectiveness — regime-aware (regime-specific overrides global)
    if (factors) {
      const rMatrix = this.profiles.byRegimeXFactor?.[regime];
      const fc      = this.profiles.byFactor;

      for (const [key, active] of Object.entries(factors)) {
        if (!active) continue;
        const rf = rMatrix?.[key];
        if (rf && rf.count >= 4) {
          if      (rf.winRate > 0.68) score *= 1.10;
          else if (rf.winRate < 0.28) score *= 0.90;
        } else if (fc?.[key]) {
          if      (fc[key].winCorrelation > 0.68 && fc[key].count >= 8) score *= 1.08;
          else if (fc[key].winCorrelation < 0.28 && fc[key].count >= 8) score *= 0.92;
        }
      }

      // 7. Factor interaction pairs (which combos historically outperform)
      const fi = this.profiles.byFactorInteraction;
      if (fi) {
        const activeKeys = Object.entries(factors).filter(([, v]) => v).map(([k]) => k);
        for (let i = 0; i < activeKeys.length; i++) {
          for (let j = i + 1; j < activeKeys.length; j++) {
            const pair = fi[`${activeKeys[i]}+${activeKeys[j]}`];
            if (pair && pair.count >= 4) {
              if      (pair.winRate > 0.68) score *= 1.07;
              else if (pair.winRate < 0.28) score *= 0.94;
            }
          }
        }
      }
    }

    return Math.max(0.40, Math.min(1.60, score));
  }

  // ── Dashboard insights ─────────────────────────────────────────
  getInsights() {
    if (!this.profiles.byAsset) return null;

    const assets = Object.entries(this.profiles.byAsset)
      .filter(([, p]) => p.count >= 1)
      .map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => b.winRate - a.winRate);

    const sessions = Object.entries(this.profiles.bySession || {})
      .filter(([, p]) => p.count >= 1)
      .map(([s, p]) => ({ session: s, ...p }))
      .sort((a, b) => b.winRate - a.winRate);

    const factors = Object.entries(this.profiles.byFactor || {})
      .filter(([, p]) => p.count >= 2)
      .map(([f, p]) => ({ factor: f, winCorr: +p.winCorrelation.toFixed(2), count: p.count }))
      .sort((a, b) => b.winCorr - a.winCorr);

    const interactions = Object.entries(this.profiles.byFactorInteraction || {})
      .filter(([, p]) => p.count >= 3)
      .map(([pair, p]) => ({ pair, winRate: +p.winRate.toFixed(2), count: p.count }))
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 5);

    const pvr = this.profiles.byPaperVsReal || {};
    const totalTrades = Object.values(this.profiles.byAsset)
      .reduce((s, p) => s + p.count, 0);

    return {
      bestAssets:      assets.slice(0, 3),
      worstAssets:     assets.slice(-3).reverse(),
      sessions,
      topFactors:      factors.slice(0, 3),
      weakFactors:     factors.slice(-2).reverse(),
      topInteractions: interactions,
      holdBuckets:     this.profiles.byHoldBars,
      paperVsReal: {
        paper: pvr.paper ? { count: pvr.paper.count, winRate: (pvr.paper.winRate * 100).toFixed(0) + '%' } : null,
        real:  pvr.real  ? { count: pvr.real.count,  winRate: (pvr.real.winRate  * 100).toFixed(0) + '%' } : null,
      },
      totalTrades,
    };
  }

  // ── Internal builders (full DB rebuild) ───────────────────────

  _buildFactorCorrelation(trades) {
    const factors = {};
    const n = trades.length;
    for (let i = 0; i < n; i++) {
      const t = trades[i];
      if (!t.factors) continue;
      const w = recencyWeight(i, n);
      const parsed = typeof t.factors === 'string' ? JSON.parse(t.factors) : t.factors;
      for (const [key, active] of Object.entries(parsed)) {
        if (!factors[key]) factors[key] = { trueWins: 0, trueCount: 0, count: 0, wTrueWins: 0, wTrueCount: 0 };
        factors[key].count++;
        if (active) {
          factors[key].trueCount++;
          factors[key].wTrueCount += w;
          if ((t.pnl || 0) > 0) { factors[key].trueWins++; factors[key].wTrueWins += w; }
        }
      }
    }
    for (const f of Object.values(factors)) {
      f.winCorrelation = (f.wTrueWins + 1) / (f.wTrueCount + 2); // Bayesian smoothing
    }
    return factors;
  }

  _buildFactorInteractions(trades) {
    const pairs = {};
    const n = trades.length;
    for (let i = 0; i < n; i++) {
      const t = trades[i];
      if (!t.factors) continue;
      const f    = typeof t.factors === 'string' ? JSON.parse(t.factors) : t.factors;
      const win  = (t.pnl || 0) > 0;
      const keys = Object.entries(f).filter(([, v]) => v).map(([k]) => k);
      for (let a = 0; a < keys.length; a++) {
        for (let b = a + 1; b < keys.length; b++) {
          const pair = `${keys[a]}+${keys[b]}`;
          if (!pairs[pair]) pairs[pair] = { wins: 0, count: 0 };
          pairs[pair].count++;
          if (win) pairs[pair].wins++;
        }
      }
    }
    for (const p of Object.values(pairs)) {
      p.winRate = wilsonLower(p.wins, p.count);
    }
    return pairs;
  }

  _buildRegimeFactorMatrix(trades) {
    const matrix = {};
    const n = trades.length;
    for (let i = 0; i < n; i++) {
      const t = trades[i];
      const w = recencyWeight(i, n);
      const regime = t.regime || 'neutral';
      if (!t.factors) continue;
      const f   = typeof t.factors === 'string' ? JSON.parse(t.factors) : t.factors;
      const win = (t.pnl || 0) > 0;
      if (!matrix[regime]) matrix[regime] = {};
      for (const [key, active] of Object.entries(f)) {
        if (!active) continue;
        if (!matrix[regime][key]) matrix[regime][key] = { wins: 0, count: 0, wWins: 0, wTotal: 0 };
        matrix[regime][key].count++;
        matrix[regime][key].wTotal += w;
        if (win) { matrix[regime][key].wins++; matrix[regime][key].wWins += w; }
      }
    }
    for (const regime of Object.values(matrix)) {
      for (const factor of Object.values(regime)) {
        factor.winRate = (factor.wWins + 1) / (factor.wTotal + 2);
      }
    }
    return matrix;
  }

  _buildHoldBuckets(trades) {
    const buckets = { quick: [], normal: [], extended: [] }; // <6, 6-24, >24 bars
    for (const t of trades) {
      const bars = t.hold_bars || 0;
      const b = bars < 6 ? 'quick' : bars < 24 ? 'normal' : 'extended';
      buckets[b].push(t.pnl || 0);
    }
    const result = {};
    for (const [name, pnls] of Object.entries(buckets)) {
      if (!pnls.length) continue;
      const wins = pnls.filter(p => p > 0).length;
      result[name] = {
        count:   pnls.length,
        avgPnl:  +(pnls.reduce((a, b) => a + b, 0) / pnls.length).toFixed(2),
        winRate: +wilsonLower(wins, pnls.length).toFixed(2),
      };
    }
    return result;
  }

  _topAsset() {
    const a = this.profiles.byAsset;
    if (!a) return null;
    const best = Object.entries(a).sort((x, y) => y[1].winRate - x[1].winRate)[0];
    return best ? `${best[0]}(${(best[1].winRate * 100).toFixed(0)}%)` : null;
  }
}
