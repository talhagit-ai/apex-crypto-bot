// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V1 — Risk Management
//  Circuit breakers, dynamic scaling, correlation checks, kill switch
// ═══════════════════════════════════════════════════════════════

import {
  CAPITAL, MAX_POS, MAX_DEPLOY, MAX_SINGLE_PCT, MIN_ORDER_USD, MAX_RISK_PER_TRADE,
  CONF_RISK, FEE_RATE,
  DAILY_LOSS_LIMIT_1, DAILY_LOSS_LIMIT_2,
  WEEKLY_LOSS_LIMIT_1, WEEKLY_LOSS_LIMIT_2,
  KILL_SWITCH_PCT,
  LOSS_LIMIT, PAUSE_MINUTES,
  TOTAL_LOSS_LIMIT, TOTAL_PAUSE_MINUTES,
  PEAK_HOURS, OFF_PEAK_RISK_MULT,
  DYNAMIC_RISK, CORRELATION_RULES, ASSETS,
  GROWTH_MODE, GROWTH_CONF_RISK, GROWTH_MAX_RISK_PER_TRADE,
  GROWTH_CORRELATION_RULES,
  GROWTH_DAILY_LOSS_LIMIT_1, GROWTH_DAILY_LOSS_LIMIT_2,
  GROWTH_WEEKLY_LOSS_LIMIT_1, GROWTH_WEEKLY_LOSS_LIMIT_2,
  GROWTH_KILL_SWITCH_PCT,
  SESSION_FILTER_ENABLED, SESSION_ALLOWED_START, SESSION_ALLOWED_END,
  COOLDOWN_SL_MIN, COOLDOWN_TIME_MIN,
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
    lastExitTime: {},            // per asset: { BTCUSDT: { timestamp, reason } }
    allPausedUntil: 0,           // timestamp when all-pause ends
    recentTrades: [],            // last 5 trade results for dynamic scaling
    killed: false,               // kill switch triggered
    riskReduction: 1.0,          // current risk multiplier (1.0 = normal)
  };
}

function currentDayUTC() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
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

  // Daily loss circuit breaker (growth mode uses wider limits)
  const DLL1 = GROWTH_MODE ? GROWTH_DAILY_LOSS_LIMIT_1  : DAILY_LOSS_LIMIT_1;
  const DLL2 = GROWTH_MODE ? GROWTH_DAILY_LOSS_LIMIT_2  : DAILY_LOSS_LIMIT_2;
  const dailyPct = state.dailyLoss / capital;
  if (dailyPct >= DLL2) {
    state.riskReduction = 0;
    log.warn(`CIRCUIT BREAKER: Daily loss ${(dailyPct * 100).toFixed(1)}% >= ${DLL2 * 100}% — STOPPED 24h`);
  } else if (dailyPct >= DLL1) {
    state.riskReduction = 0.5;
    log.warn(`Daily loss ${(dailyPct * 100).toFixed(1)}% >= ${DLL1 * 100}% — Risk reduced 50%`);
  }

  // Weekly loss circuit breaker
  const WLL1 = GROWTH_MODE ? GROWTH_WEEKLY_LOSS_LIMIT_1 : WEEKLY_LOSS_LIMIT_1;
  const WLL2 = GROWTH_MODE ? GROWTH_WEEKLY_LOSS_LIMIT_2 : WEEKLY_LOSS_LIMIT_2;
  const weeklyPct = state.weeklyLoss / capital;
  if (weeklyPct >= WLL2) {
    state.riskReduction = 0;
    log.warn(`CIRCUIT BREAKER: Weekly loss ${(weeklyPct * 100).toFixed(1)}% — STOPPED for week`);
  } else if (weeklyPct >= WLL1) {
    state.riskReduction = Math.min(state.riskReduction, 0.5);
    log.warn(`Weekly loss ${(weeklyPct * 100).toFixed(1)}% — Risk reduced 50%`);
  }

  // Kill switch
  const KSP = GROWTH_MODE ? GROWTH_KILL_SWITCH_PCT : KILL_SWITCH_PCT;
  if (capital <= state.startCapital * (1 - KSP)) {
    state.killed = true;
    log.error(`KILL SWITCH: Capital ${capital.toFixed(2)} below ${((1 - KSP) * 100).toFixed(0)}% of start — ALL TRADING STOPPED`);
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

  // V16: Session filter — alleen traden tijdens winstgevende Europa sessie
  if (SESSION_FILTER_ENABLED) {
    const hourUTC = new Date(now).getUTCHours();
    if (hourUTC < SESSION_ALLOWED_START || hourUTC >= SESSION_ALLOWED_END) {
      return { allowed: false, reason: `Outside session (${SESSION_ALLOWED_START}-${SESSION_ALLOWED_END} UTC)` };
    }
  }

  // All-asset pause
  if (now < state.allPausedUntil) {
    return { allowed: false, reason: 'All trading paused after consecutive losses' };
  }

  // Per-asset pause
  if (now < (state.pauseUntil[assetId] || 0)) {
    return { allowed: false, reason: `${assetId} paused after consecutive losses` };
  }

  // Signal cooldown after SL/TIME exit (prevent immediate re-entry into chop)
  const lastExit = state.lastExitTime?.[assetId];
  if (lastExit) {
    // V17b: gebruik geconfigureerde cooldown-waarden (GROWTH_MODE override negeerde de kortere V17b waarden)
    const cooldownMs = lastExit.reason === 'SL'   ? COOLDOWN_SL_MIN   * 60 * 1000
                     : lastExit.reason === 'TIME'  ? COOLDOWN_TIME_MIN * 60 * 1000
                     : 0; // No cooldown after TP (trend was right)
    if (cooldownMs > 0 && now - lastExit.timestamp < cooldownMs) {
      return { allowed: false, reason: `${assetId} cooldown after ${lastExit.reason} exit` };
    }
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
    const corrRules = GROWTH_MODE ? GROWTH_CORRELATION_RULES : CORRELATION_RULES;
    const rule = corrRules[newGroup];
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

  // Base risk from confidence level (growth mode uses Kelly-optimal sizing)
  const riskTable = opts.growthMode ? GROWTH_CONF_RISK : CONF_RISK;
  let baseRisk = riskTable[Math.min(conf, 6)] || riskTable[4];

  // Cap at max risk per trade
  const maxRisk = opts.growthMode ? GROWTH_MAX_RISK_PER_TRADE : MAX_RISK_PER_TRADE;
  baseRisk = Math.min(baseRisk, maxRisk);

  // Growth mode: use real capital for compounding (profits increase position sizes)
  // Safe mode: cap at startCapital to prevent paper-profit-inflated sizing
  if (!opts.growthMode) {
    capital = Math.min(capital, state.startCapital);
  }

  // Dynamic risk scaling based on consecutive loss streak
  const streak = Math.min(state.totalConsecutiveLosses || 0, 4);
  const dynamicMult = DYNAMIC_RISK[streak] ?? 1.0;

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

  // Volatility-adjusted sizing: reduce in high vol, increase in low vol
  const atrPctile = signal.atrPercentile || 50;
  const volMult = atrPctile > 80 ? 0.70 : atrPctile > 60 ? 0.85 : atrPctile < 20 ? 1.15 : 1.0;

  // Regime-strength sizing: strong/strengthening trend → larger size, weak → smaller
  const rsMult = Math.max(0.6, Math.min(1.3,
    signal.regimeStrengthening ? (signal.regimeStrength || 1.0) * 1.15
    : (signal.regimeStrength || 1.0)
  ));

  // Combined risk amount
  const riskAmount = capital * baseRisk * dynamicMult * peakMult * cbMult * volMult * rsMult;

  // Account for round-trip fees (V11: floor verlaagd van 80% naar 60% — realistischer)
  const qty_raw  = riskAmount / slDist;
  const feeCost  = 2 * FEE_RATE * qty_raw * price;
  const feeAdjustedRisk = Math.max(riskAmount * 0.60, riskAmount - feeCost);

  // Position quantity
  let qty = Math.max(0, feeAdjustedRisk / slDist);

  // Max deploy cap (total capital in any single position)
  const maxNotional = Math.min(capital * MAX_DEPLOY, capital * MAX_SINGLE_PCT);
  const notional = qty * price;
  if (notional > maxNotional) {
    qty = maxNotional / price;
  }

  // Round to asset's qty step
  qty = Math.floor(qty / asset.qtyStep) * asset.qtyStep;

  // Min qty check
  if (qty < asset.minQty) return 0;

  // Minimum notional check — Kraken weigert orders onder ~$10 notional
  if (qty * price < MIN_ORDER_USD) return 0;

  return qty;
}
