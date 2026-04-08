// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V6 — Self-Learning Engine
//  Analyzes trade history to build performance profiles.
//  Feeds into signal scoring and position sizing.
// ═══════════════════════════════════════════════════════════════

import { getTradeAnalytics } from './persistence.mjs';
import { log } from './logger.mjs';

export class LearningEngine {
  constructor() {
    this.profiles = {};
    this.lastRefresh = 0;
    this.REFRESH_MS = 5 * 60 * 1000; // recalculate every 5 minutes
    this.MIN_TRADES = 10;             // need N trades before learning kicks in
  }

  async refresh() {
    if (Date.now() - this.lastRefresh < this.REFRESH_MS) return;
    try {
      const trades = await getTradeAnalytics(500);
      if (trades.length < this.MIN_TRADES) {
        this.lastRefresh = Date.now();
        return;
      }

      this.profiles = {
        byAsset:   this._groupPerformance(trades, t => t.asset),
        byHour:    this._groupPerformance(trades, t => t.entry_hour_utc),
        byRegime:  this._groupPerformance(trades, t => t.regime),
        byVolReg:  this._groupPerformance(trades, t => t.vol_regime),
        byConf:    this._groupPerformance(trades, t => t.conf),
        byFactor:  this._factorCorrelation(trades),
        byExit:    this._groupPerformance(trades, t => t.exit_reason),
      };

      this.lastRefresh = Date.now();
      log.info('Learning engine refreshed', {
        trades: trades.length,
        assets: Object.keys(this.profiles.byAsset || {}).length,
      });
    } catch (e) {
      log.warn('Learning engine refresh failed', { err: e.message });
    }
  }

  /**
   * Returns a quality multiplier (0.5 to 1.5) based on historical performance.
   * Higher = conditions historically produce more wins.
   */
  scoreSignal(asset, hourUTC, regime, volRegime, conf, factors) {
    if (!this.profiles.byAsset) return 1.0; // no data yet

    let score = 1.0;

    // Asset performance
    const ap = this.profiles.byAsset?.[asset];
    if (ap && ap.count >= this.MIN_TRADES) {
      if (ap.winRate < 0.35) score *= 0.70;       // bad asset → penalize hard
      else if (ap.winRate < 0.45) score *= 0.85;
      else if (ap.winRate > 0.60) score *= 1.20;   // great asset → boost
    }

    // Hour performance
    const hp = this.profiles.byHour?.[hourUTC];
    if (hp && hp.count >= 5) {
      if (hp.avgPnl < 0) score *= 0.80;
      else if (hp.winRate > 0.55) score *= 1.10;
    }

    // Regime performance
    const rp = this.profiles.byRegime?.[regime];
    if (rp && rp.count >= 10) {
      if (rp.winRate < 0.35) score *= 0.75;
    }

    // Factor effectiveness: boost/penalize based on which factors predict wins
    const fc = this.profiles.byFactor;
    if (fc && factors) {
      for (const [key, active] of Object.entries(factors)) {
        if (!active || !fc[key]) continue;
        if (fc[key].winCorrelation > 0.65 && fc[key].count >= 10) score *= 1.08;
        if (fc[key].winCorrelation < 0.30 && fc[key].count >= 10) score *= 0.92;
      }
    }

    return Math.max(0.5, Math.min(1.5, score));
  }

  /**
   * Get best/worst performing assets for dashboard/Telegram
   */
  getInsights() {
    if (!this.profiles.byAsset) return null;
    const assets = Object.entries(this.profiles.byAsset)
      .filter(([, p]) => p.count >= 5)
      .map(([id, p]) => ({ id, ...p }))
      .sort((a, b) => b.avgPnl - a.avgPnl);

    const hours = Object.entries(this.profiles.byHour || {})
      .filter(([, p]) => p.count >= 3)
      .map(([h, p]) => ({ hour: +h, ...p }))
      .sort((a, b) => b.avgPnl - a.avgPnl);

    return {
      bestAssets: assets.slice(0, 3),
      worstAssets: assets.slice(-3).reverse(),
      bestHours: hours.slice(0, 3),
      worstHours: hours.slice(-3).reverse(),
      totalTrades: Object.values(this.profiles.byAsset).reduce((s, p) => s + p.count, 0),
    };
  }

  _groupPerformance(trades, keyFn) {
    const groups = {};
    for (const t of trades) {
      const key = keyFn(t);
      if (key === null || key === undefined) continue;
      if (!groups[key]) groups[key] = { wins: 0, losses: 0, totalPnl: 0, totalR: 0, count: 0 };
      groups[key].count++;
      groups[key].totalPnl += t.pnl || 0;
      groups[key].totalR += t.r_multiple || 0;
      if (t.pnl > 0) groups[key].wins++;
      else groups[key].losses++;
    }
    for (const g of Object.values(groups)) {
      g.winRate = g.wins / Math.max(g.count, 1);
      g.avgPnl = g.totalPnl / Math.max(g.count, 1);
      g.avgR = g.totalR / Math.max(g.count, 1);
    }
    return groups;
  }

  _factorCorrelation(trades) {
    const factors = {};
    for (const t of trades) {
      if (!t.factors) continue;
      const parsed = typeof t.factors === 'string' ? JSON.parse(t.factors) : t.factors;
      for (const [key, active] of Object.entries(parsed)) {
        if (!factors[key]) factors[key] = { trueWins: 0, trueCount: 0, count: 0 };
        factors[key].count++;
        if (active) {
          factors[key].trueCount++;
          if (t.pnl > 0) factors[key].trueWins++;
        }
      }
    }
    for (const f of Object.values(factors)) {
      f.winCorrelation = f.trueWins / Math.max(f.trueCount, 1);
    }
    return factors;
  }
}
