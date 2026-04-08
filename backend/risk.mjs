// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V1 — Risk Management
//  Circuit breakers, dynamic scaling, correlation checks, kill switch
// ═══════════════════════════════════════════════════════════════

import {
  CAPITAL, MAX_POS, MAX_DEPLOY, MAX_RISK_PER_TRADE,
  CONF_RISK, FEE_RATE,
  DAILY_LOSS_LIMIT_1, DAILY_LOSS_LIMIT_2,
  WEEKLY_LOSS_LIMIT_1, WEEKLY_LOSS_LIMIT_2,
  KILL_SWITCH_PCT,
  LOSS_LIMIT, PAUSE_MINUTES,
  TOTAL_LOSS_LIMIT, TOTAL_PAUSE_MINUTES,
  PEAK_HOURS, OFF_PEAK_RISK_MULT,
  DYNAMIC_RISK, CORRELATION_RULES, ASSETS,
} from './config.mjs';
import { log } from './logger.mjs';

/**
 * Risk state — tracked across the engine lifecycle
 */
export function createRiskState(capital) {
  return {
    startCapital: capital,
    dailyLoss: 0,
    weeklyLoss: 0,
    dailyResetUTC: currentDayUTC(),
    weeklyResetUTC: currentWeekUTC(),
    dailyLossLog: [],            // rolling 24h: [{ pnl, timestamp }, ...]
    weeklyLossLog: [],           // rolling 7d: [{ pnl, timestamp }, ...]
    consecutiveLosses: {},       // per asset: { BTCUSDT: 2, ... }
    totalConsecutiveLosses: 0,
    pauseUntil: {},              // per asset: { BTCUSDT: timestamp, ... }
    allPausedUntil: 0,           // timestamp when all-pause ends
    recentTrades: [],            // last 5 trade results for dynamic scaling
    killed: false,               // kill switch triggered
    riskReduction: 1.0,          // current risk multiplier (1.0 = normal)
  };
}

function currentDayUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
}

function currentWeekUTC() {
  const d = new Date();
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day;
  return `${d.getUTCFullYear()}-W${Math.ceil((d.getUTCDate() + 6 - day) / 7)}`;
}

/**
 * Check and prune rolling loss windows (24h daily, 7d weekly)
 */
export function checkPeriodReset(state) {
  const now = Date.now();
  const DAY_MS  = 24 * 60 * 60 * 1000;
  const WEEK_MS = 7 * DAY_MS;

  // Rolling 24h daily loss
  if (!state.dailyLossLog) state.dailyLossLog = [];
  state.dailyLossLog = state.dailyLossLog.filter(e => now - e.timestamp < DAY_MS);
  const newDailyLoss = state.dailyLossLog.reduce((s, e) => s + e.pnl, 0);

  // Restore risk if daily loss window fully cleared (not if weekly still active)
  if (state.dailyLoss > 0 && newDailyLoss === 0 && state.weeklyLoss < state.startCapital * WEEKLY_LOSS_LIMIT_1) {
    state.riskReduction = 1.0;
    log.info('Daily loss window cleared — risk fully restored');
  }
  state.dailyLoss = newDailyLoss;

  // Rolling 7d weekly loss
  if (!state.weeklyLossLog) state.weeklyLossLog = [];
  state.weeklyLossLog = state.weeklyLossLog.filter(e => now - e.timestamp < WEEK_MS);
  state.weeklyLoss = state.weeklyLossLog.reduce((s, e) => s + e.pnl, 0);
}

/**
 * Record a completed trade result
 */
export function recordTradeResult(state, assetId, pnl, capital) {
  const isLoss = pnl < 0;

  if (isLoss) {
    const absLoss = Math.abs(pnl);
    // Add to rolling loss logs
    if (!state.dailyLossLog) state.dailyLossLog = [];
    if (!state.weeklyLossLog) state.weeklyLossLog = [];
    state.dailyLossLog.push({ pnl: absLoss, timestamp: Date.now() });
    state.weeklyLossLog.push({ pnl: absLoss, timestamp: Date.now() });
    state.dailyLoss += absLoss;
    state.weeklyLoss += absLoss;
    state.consecutiveLosses[assetId] = (state.consecutiveLosses[assetId] || 0) + 1;
    state.totalConsecutiveLosses++;

    // Per-asset pause after consecutive losses
    if (state.consecutiveLosses[assetId] >= LOSS_LIMIT) {
      state.pauseUntil[assetId] = Date.now() + PAUSE_MINUTES * 60 * 1000;
      state.consecutiveLosses[assetId] = 0;
      log.warn(`Asset ${assetId} paused for ${PAUSE_MINUTES} min after ${LOSS_LIMIT} consecutive losses`);
    }

    // All-asset pause after total consecutive losses
    if (state.totalConsecutiveLosses >= TOTAL_LOSS_LIMIT) {
      state.allPausedUntil = Date.now() + TOTAL_PAUSE_MINUTES * 60 * 1000;
      state.totalConsecutiveLosses = 0;
      log.warn(`ALL trading paused for ${TOTAL_PAUSE_MINUTES} min after ${TOTAL_LOSS_LIMIT} total consecutive losses`);
    }
  } else {
    state.consecutiveLosses[assetId] = 0;
    state.totalConsecutiveLosses = 0;
  }

  // Track recent trades for dynamic risk scaling
  state.recentTrades.push({ win: !isLoss, pnl, assetId, time: Date.now() });
  if (state.recentTrades.length > 5) state.recentTrades.shift();

  // Daily loss circuit breaker
  const dailyPct = state.dailyLoss / capital;
  if (dailyPct >= DAILY_LOSS_LIMIT_2) {
    state.riskReduction = 0;
    log.warn(`CIRCUIT BREAKER: Daily loss ${(dailyPct * 100).toFixed(1)}% >= ${DAILY_LOSS_LIMIT_2 * 100}% — STOPPED 24h`);
  } else if (dailyPct >= DAILY_LOSS_LIMIT_1) {
    state.riskReduction = 0.5;
    log.warn(`Daily loss ${(dailyPct * 100).toFixed(1)}% >= ${DAILY_LOSS_LIMIT_1 * 100}% — Risk reduced 50%`);
  }

  // Weekly loss circuit breaker
  const weeklyPct = state.weeklyLoss / capital;
  if (weeklyPct >= WEEKLY_LOSS_LIMIT_2) {
    state.riskReduction = 0;
    log.warn(`CIRCUIT BREAKER: Weekly loss ${(weeklyPct * 100).toFixed(1)}% — STOPPED for week`);
  } else if (weeklyPct >= WEEKLY_LOSS_LIMIT_1) {
    state.riskReduction = Math.min(state.riskReduction, 0.5);
    log.warn(`Weekly loss ${(weeklyPct * 100).toFixed(1)}% — Risk reduced 50%`);
  }

  // Kill switch
  if (capital <= state.startCapital * (1 - KILL_SWITCH_PCT)) {
    state.killed = true;
    log.error(`KILL SWITCH: Capital ${capital.toFixed(2)} below ${((1 - KILL_SWITCH_PCT) * 100).toFixed(0)}% of start — ALL TRADING STOPPED`);
  }
}

/**
 * Can we open a new position?
 */
export function canOpenPosition(state, assetId, currentPositions, now = Date.now()) {
  // Kill switch
  if (state.killed) return { allowed: false, reason: 'Kill switch active' };

  // Risk reduction = 0 means circuit breaker stopped trading
  if (state.riskReduction === 0) return { allowed: false, reason: 'Circuit breaker active' };

  // All-asset pause
  if (now < state.allPausedUntil) {
    return { allowed: false, reason: 'All trading paused after consecutive losses' };
  }

  // Per-asset pause
  if (now < (state.pauseUntil[assetId] || 0)) {
    return { allowed: false, reason: `${assetId} paused after consecutive losses` };
  }

  // Max positions
  if (currentPositions.length >= MAX_POS) {
    return { allowed: false, reason: `Max ${MAX_POS} positions reached` };
  }

  // Already holding this asset
  if (currentPositions.some(p => p.assetId === assetId)) {
    return { allowed: false, reason: `Already holding ${assetId}` };
  }

  // Correlation check: don't hold two HIGH-corr assets simultaneously
  const asset = ASSETS.find(a => a.id === assetId);
  if (asset) {
    const newGroup = asset.corrGroup;
    const rule = CORRELATION_RULES[newGroup];
    if (rule) {
      const sameGroupCount = currentPositions.filter(p => {
        const a = ASSETS.find(x => x.id === p.assetId);
        return a && a.corrGroup === newGroup;
      }).length;
      if (sameGroupCount >= rule.maxSimultaneous) {
        return { allowed: false, reason: `Correlation limit: already holding ${newGroup} group asset` };
      }
    }
  }

  return { allowed: true, reason: 'OK' };
}

/**
 * Calculate position size with all risk adjustments
 */
export function calculatePositionSize(signal, capital, state, opts = {}) {
  const { conf, price, sl, atr } = signal;
  const asset = ASSETS.find(a => a.id === signal.asset);
  if (!asset) return 0;

  const slDist = Math.abs(price - sl);
  if (slDist <= 0) return 0;

  // Base risk from confidence level
  let baseRisk = CONF_RISK[Math.min(conf, 6)] || CONF_RISK[4];

  // Cap at max risk per trade
  baseRisk = Math.min(baseRisk, MAX_RISK_PER_TRADE);

  // IMPORTANT: size based on real starting capital, not inflated internal cash.
  // Internal cash can grow from paper wins while real account has not changed.
  capital = Math.min(capital, state.startCapital);

  // Dynamic risk scaling based on recent wins/losses
  const winCount = state.recentTrades.filter(t => t.win).length;
  const dynamicMult = DYNAMIC_RISK[winCount] ?? 1.0;

  // Peak hours multiplier
  let peakMult;
  if (opts.peakMult !== undefined) {
    peakMult = opts.peakMult;
  } else {
    const hourUTC = new Date().getUTCHours();
    peakMult = OFF_PEAK_RISK_MULT;
    for (const [start, end] of PEAK_HOURS) {
      if (hourUTC >= start && hourUTC < end) {
        peakMult = 1.0;
        break;
      }
    }
  }

  // Circuit breaker reduction
  const cbMult = state.riskReduction;

  // Combined risk amount
  const riskAmount = capital * baseRisk * dynamicMult * peakMult * cbMult;

  // Account for round-trip fees
  const feeAdjustedRisk = riskAmount - (2 * FEE_RATE * (riskAmount / slDist) * price);

  // Position quantity
  let qty = Math.max(0, feeAdjustedRisk / slDist);

  // Max deploy cap
  const maxNotional = capital * MAX_DEPLOY;
  const notional = qty * price;
  if (notional > maxNotional) {
    qty = maxNotional / price;
  }

  // Round to asset's qty step
  qty = Math.floor(qty / asset.qtyStep) * asset.qtyStep;

  // Min qty check
  if (qty < asset.minQty) return 0;

  return qty;
}
