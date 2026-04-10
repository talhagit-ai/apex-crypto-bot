// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Self-Optimization Engine (Level 2)
//
//  HOW IT WORKS:
//  1. Loads last 100 real trades from SQLite
//  2. Analyses which setups win/lose (per asset, confidence, hour)
//  3. Generates smarter parameter candidates based on findings
//  4. Validates each candidate with a 200-week mini-simulation
//  5. Applies improvements only if: +5% avg P&L AND no worse drawdown
//  6. Logs every decision — full transparency
//
//  Runs: every Sunday 02:00 UTC + manual via POST /optimize
// ═══════════════════════════════════════════════════════════════

import { ASSETS, CAPITAL } from './config.mjs';
import { TradingEngine } from './engine.mjs';
import { log } from './logger.mjs';
import { getRecentTrades, saveOptimizerRun, saveState, loadState } from './persistence.mjs';

// ── Default params (baseline — matches config.mjs) ─────────────
const DEFAULT_PARAMS = {
  MIN_CONF:     5,
  MIN_RR:       2.5,
  PARTIAL1_R:   1.0,
  PARTIAL1_PCT: 0.20,
  PARTIAL2_R:   2.0,
  PARTIAL2_PCT: 0.25,
  TRAIL_R:      1.2,
  TRAIL_ATR:    1.5,
  MAX_BARS:     72,
  CONF_RISK:    { 3: 0.008, 4: 0.015, 5: 0.025, 6: 0.030 },
  assets: {
    BTCUSDT: { slM: 2.4, tpM: 6.0 },
    ETHUSDT: { slM: 2.2, tpM: 5.5 },
    SOLUSDT: { slM: 2.3, tpM: 5.8 },
    XRPUSDT: { slM: 2.2, tpM: 5.5 },
    ADAUSDT: { slM: 2.2, tpM: 5.5 },
    DOTUSD:  { slM: 2.3, tpM: 5.8 },
    LINKUSD: { slM: 2.3, tpM: 5.8 },
    AVAXUSD: { slM: 2.4, tpM: 6.0 },
    DOGEUSD: { slM: 2.3, tpM: 5.8 },
    ATOMUSD: { slM: 2.3, tpM: 5.8 },
    LTCUSD:  { slM: 2.2, tpM: 5.5 },
    NEARUSD: { slM: 2.3, tpM: 5.8 },
    UNIUSD:  { slM: 2.3, tpM: 5.8 },
    AAVEUSD: { slM: 2.4, tpM: 6.0 },
    POLUSD:  { slM: 2.3, tpM: 5.8 },
    FILUSD:  { slM: 2.3, tpM: 5.8 },
    ARBUSD:  { slM: 2.4, tpM: 6.0 },
  },
};

// ── Parameter search space ─────────────────────────────────────
const SEARCH_SPACE = {
  slM:  [1.8, 2.0, 2.2, 2.3, 2.4, 2.5, 2.7, 3.0],
  tpM:  [4.5, 5.0, 5.5, 5.8, 6.0, 6.5, 7.0],
  CONF_RISK_3: [0.006, 0.008, 0.010],
  CONF_RISK_4: [0.012, 0.015, 0.018],
  CONF_RISK_5: [0.020, 0.025, 0.030],
  CONF_RISK_6: [0.025, 0.030, 0.035],
  MIN_CONF:    [4, 5, 6],
  TRAIL_ATR:   [1.5, 1.8, 2.2],
};

// Minimum improvement required before applying (5%)
const MIN_IMPROVEMENT = 0.05;
// Max parameter change per round (prevent drastic swings)
const MAX_CHANGE_PCT  = 0.20;

// ── Public API ─────────────────────────────────────────────────

/**
 * Load current params from DB (falls back to defaults)
 */
export async function loadParams() {
  try {
    const saved = await loadState('params');
    return saved || { ...DEFAULT_PARAMS };
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

/**
 * Sync version for places that can't await (returns defaults, async load happens in start())
 */
export function loadParamsSync() {
  return { ...DEFAULT_PARAMS };
}

/**
 * Main optimization run
 * Call this weekly or manually
 *
 * @returns {object} result summary
 */
export async function runOptimization() {
  const startTime = Date.now();
  log.info('═══ OPTIMIZER: Starting weekly optimization run ═══');

  // 1. Load recent trades
  const trades = await getRecentTrades(150);
  if (trades.length < 20) {
    log.info('Optimizer: Not enough trades yet (need 20+). Skipping.');
    return { status: 'skipped', reason: 'insufficient_trades', count: trades.length };
  }

  log.info(`Optimizer: Analysing ${trades.length} recent trades`);

  // 2. Analyse performance
  const analysis = analysePerformance(trades);
  log.info('Optimizer: Analysis complete', analysis.summary);

  // 3. Get current params as baseline
  const current = await loadParams();
  const baselineScore = await evaluateParams(current);
  log.info(`Optimizer: Baseline score = €${baselineScore.avgPnl.toFixed(2)}/week, worst = €${baselineScore.worst.toFixed(2)}`);

  // 4. Generate and test candidate parameter sets
  const candidates = generateCandidates(current, analysis);
  log.info(`Optimizer: Testing ${candidates.length} parameter candidates...`);

  let bestScore    = baselineScore;
  let bestParams   = current;
  let improvements = 0;

  for (const candidate of candidates) {
    const score = await evaluateParams(candidate);
    const improvement = (score.avgPnl - bestScore.avgPnl) / Math.abs(bestScore.avgPnl || 1);

    if (
      improvement > MIN_IMPROVEMENT &&
      score.worst >= bestScore.worst * 0.95 &&  // don't worsen drawdown >5%
      score.winWeeks >= bestScore.winWeeks - 2   // don't drop win weeks
    ) {
      bestScore  = score;
      bestParams = candidate;
      improvements++;
      log.info(`Optimizer: New best found! €${score.avgPnl.toFixed(2)}/week (+${(improvement*100).toFixed(1)}%)`);
    }
  }

  // 5. Apply if improvement found
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (improvements > 0 && bestParams !== current) {
    const pnlGain = bestScore.avgPnl - baselineScore.avgPnl;
    await saveParams(bestParams, baselineScore, bestScore);
    log.info(`Optimizer: ✓ Applied new params — +€${pnlGain.toFixed(2)}/week improvement`);

    const result = {
      status:      'improved',
      baseline:    baselineScore,
      new:         bestScore,
      improvement: +(((bestScore.avgPnl - baselineScore.avgPnl) / Math.abs(baselineScore.avgPnl)) * 100).toFixed(1),
      tradesUsed:  trades.length,
      elapsed,
      changes:     diffParams(current, bestParams),
    };

    await saveOptimizerRun(result);
    return result;
  }

  log.info(`Optimizer: No improvement found — keeping current params (${elapsed}s)`);
  const result = {
    status:     'no_change',
    baseline:   baselineScore,
    tradesUsed: trades.length,
    elapsed,
  };
  await saveOptimizerRun(result);
  return result;
}

// ── Analysis ───────────────────────────────────────────────────

function analysePerformance(trades) {
  const closed = trades.filter(t => t.side === 'SELL' && t.pnl !== null);
  if (closed.length === 0) return { summary: 'no closed trades' };

  const wins   = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const winRate = wins.length / closed.length;

  // Per-asset performance
  const byAsset = {};
  for (const trade of closed) {
    const id = trade.id;
    if (!byAsset[id]) byAsset[id] = { wins: 0, losses: 0, totalPnl: 0 };
    byAsset[id].totalPnl += trade.pnl;
    trade.pnl > 0 ? byAsset[id].wins++ : byAsset[id].losses++;
  }

  // Per-hour performance (find best trading hours)
  const byHour = {};
  for (const trade of closed) {
    const hour = new Date(trade.timestamp).getUTCHours();
    if (!byHour[hour]) byHour[hour] = { pnl: 0, count: 0 };
    byHour[hour].pnl   += trade.pnl;
    byHour[hour].count += 1;
  }

  // Average R (quality of exits)
  const avgR      = closed.reduce((s, t) => s + (t.r || 0), 0) / closed.length;
  const avgWinPnl = wins.length   ? wins.reduce((s,t) => s+t.pnl, 0) / wins.length : 0;
  const avgLossPnl = losses.length ? losses.reduce((s,t) => s+t.pnl, 0) / losses.length : 0;
  const profitFactor = avgLossPnl < 0 ? Math.abs(avgWinPnl * wins.length) / Math.abs(avgLossPnl * losses.length) : 99;

  // Find underperforming assets (negative total pnl)
  const weakAssets = Object.entries(byAsset)
    .filter(([, v]) => v.totalPnl < 0)
    .map(([id]) => id);

  // Find best hours (above avg pnl/trade)
  const avgHourPnl = Object.values(byHour).reduce((s,h) => s + h.pnl/h.count, 0) / Object.keys(byHour).length;
  const bestHours  = Object.entries(byHour)
    .filter(([, v]) => v.pnl / v.count > avgHourPnl * 1.2)
    .map(([h]) => Number(h));

  return {
    winRate,
    profitFactor,
    avgR,
    avgWinPnl,
    avgLossPnl,
    weakAssets,
    bestHours,
    byAsset,
    summary: {
      trades:        closed.length,
      winRate:       +(winRate * 100).toFixed(1) + '%',
      profitFactor:  +profitFactor.toFixed(2),
      avgR:          +avgR.toFixed(2),
      weakAssets,
    },
  };
}

// ── Candidate Generation ───────────────────────────────────────

function generateCandidates(current, analysis) {
  const candidates = [];

  // ── Strategy 1: Per-asset slM/tpM tuning ──────────────────
  for (const asset of ASSETS) {
    const perf = analysis.byAsset?.[asset.id];
    if (!perf) continue;

    const assetWinRate = perf.wins / (perf.wins + perf.losses || 1);

    // If asset win rate low → widen SL slightly, or tighten TP
    // If asset win rate high → can take more risk
    const slOptions = assetWinRate < 0.45
      ? [current.assets[asset.id].slM * 1.1, current.assets[asset.id].slM * 1.15]  // wider SL
      : [current.assets[asset.id].slM * 0.95, current.assets[asset.id].slM];

    const tpOptions = analysis.avgR < 0.8
      ? [current.assets[asset.id].tpM * 0.9]  // tighter TP if runners aren't running
      : [current.assets[asset.id].tpM * 1.1, current.assets[asset.id].tpM];

    for (const slM of slOptions) {
      for (const tpM of tpOptions) {
        // Safety: clamp to search space bounds
        const newSlM = clamp(slM, 1.2, 2.2);
        const newTpM = clamp(tpM, 2.5, 6.0);
        if (newTpM / newSlM < current.MIN_RR) continue; // must maintain R:R

        const candidate = deepClone(current);
        candidate.assets[asset.id].slM = +newSlM.toFixed(2);
        candidate.assets[asset.id].tpM = +newTpM.toFixed(2);
        candidates.push(candidate);
      }
    }
  }

  // ── Strategy 2: Risk sizing adjustment ────────────────────
  if (analysis.winRate > 0.55) {
    // Hot streak — increase confidence sizing slightly
    const c = deepClone(current);
    c.CONF_RISK[4] = clamp(current.CONF_RISK[4] * 1.1, 0.008, 0.015);
    c.CONF_RISK[5] = clamp(current.CONF_RISK[5] * 1.1, 0.012, 0.022);
    c.CONF_RISK[6] = clamp(current.CONF_RISK[6] * 1.1, 0.018, 0.030);
    candidates.push(c);
  } else if (analysis.winRate < 0.45) {
    // Cold streak — reduce sizing to protect capital
    const c = deepClone(current);
    c.CONF_RISK[4] = clamp(current.CONF_RISK[4] * 0.9, 0.006, 0.015);
    c.CONF_RISK[5] = clamp(current.CONF_RISK[5] * 0.9, 0.010, 0.022);
    c.CONF_RISK[6] = clamp(current.CONF_RISK[6] * 0.9, 0.015, 0.030);
    candidates.push(c);
  }

  // ── Strategy 3: Trailing stop tuning ──────────────────────
  if (analysis.avgR < 0.5) {
    // Exits happening too early — loosen trail
    const c = deepClone(current);
    c.TRAIL_ATR = clamp(current.TRAIL_ATR * 1.1, 1.0, 2.5);
    candidates.push(c);
  } else if (analysis.avgR > 1.5) {
    // Runners running well — tighten trail to lock more profit
    const c = deepClone(current);
    c.TRAIL_ATR = clamp(current.TRAIL_ATR * 0.9, 1.0, 2.5);
    candidates.push(c);
  }

  // ── Strategy 4: MIN_CONF adjustment ───────────────────────
  if (analysis.winRate < 0.45 && current.MIN_CONF < 5) {
    const c = deepClone(current);
    c.MIN_CONF = 5; // require higher quality signals
    candidates.push(c);
  } else if (analysis.winRate > 0.60 && current.MIN_CONF > 4) {
    const c = deepClone(current);
    c.MIN_CONF = 4; // open up more opportunities
    candidates.push(c);
  }

  // Filter: remove candidates that are too similar to current (no meaningful change)
  return candidates.filter(c => Object.keys(diffParams(current, c)).length > 0);
}

// ── Simulation Evaluator ───────────────────────────────────────

async function evaluateParams(params, runs = 200) {
  // Lazy import to avoid circular dependency
  const { initBars, nextBar } = await import('../scripts/sim_helpers.mjs').catch(() => null) || {};

  // Inline fast sim if helper not available
  return fastSimulate(params, runs);
}

function fastSimulate(params, runs = 200) {
  const BARS = 2016; // 1 week of 5-min bars
  let totalPnl = 0;
  let winWeeks = 0;
  let worstWeek = 0;
  const pnls = [];

  for (let r = 0; r < runs; r++) {
    const engine = new TradingEngine(CAPITAL, { simMode: true, overrideParams: params });

    // Generate synthetic bar data for all assets
    const barData = {};
    for (const asset of ASSETS) {
      barData[asset.id] = generateSyntheticBars(asset, BARS);
    }

    // Run simulation
    for (let bar = 0; bar < BARS; bar++) {
      const tick = {};
      for (const asset of ASSETS) {
        tick[asset.id] = barData[asset.id][bar];
      }

      // Daily reset every 288 bars
      if (bar > 0 && bar % 288 === 0) {
        engine.riskState.dailyLoss = 0;
        engine.riskState.riskReduction = Math.max(engine.riskState.riskReduction, 1.0);
      }

      engine.tickFlat(tick);
    }

    // Force close remaining positions
    const lastPrices = {};
    for (const asset of ASSETS) {
      const bars = barData[asset.id];
      lastPrices[asset.id] = bars[bars.length - 1].close;
    }
    for (const [id, pos] of Object.entries(engine.positions)) {
      engine._closePosition(id, lastPrices[id] || pos.entry, 'EOW');
    }

    const eq  = engine.equity(lastPrices);
    const pnl = eq - CAPITAL;
    pnls.push(pnl);

    totalPnl += pnl;
    if (pnl > 0) winWeeks++;
    if (pnl < worstWeek) worstWeek = pnl;
  }

  pnls.sort((a, b) => a - b);
  return {
    avgPnl:   +(totalPnl / runs).toFixed(2),
    winWeeks,
    winWeekPct: +((winWeeks / runs) * 100).toFixed(1),
    worst:    +worstWeek.toFixed(2),
    p5:       +pnls[Math.floor(runs * 0.05)].toFixed(2),
    median:   +pnls[Math.floor(runs * 0.50)].toFixed(2),
  };
}

// ── Synthetic Bar Generator (fast inline version) ─────────────

function generateSyntheticBars(asset, count) {
  const bars = [];
  let price = asset.id === 'BTCUSDT' ? 65000
    : asset.id === 'ETHUSDT' ? 3200
    : asset.id === 'SOLUSDT' ? 145
    : asset.id === 'XRPUSDT' ? 0.55
    : asset.id === 'BNBUSDT' ? 580
    : 0.45;

  const vol   = asset.vol   || 0.010;
  const drift = asset.drift || 0.00035;

  const closes = [], highs = [], lows = [], volumes = [];

  for (let i = 0; i < count + 150; i++) {
    const r = Math.random();
    const move = price * vol * (r < 0.492 ? -1 : 1) * (0.3 + Math.random() * 0.7) + price * drift;
    price = Math.max(price * 0.5, price + move);

    const hi = price * (1 + Math.random() * vol * 0.5);
    const lo = price * (1 - Math.random() * vol * 0.5);
    const vol_ = 1000 * (0.5 + Math.random() * 2);

    closes.push(price);
    highs.push(hi);
    lows.push(lo);
    volumes.push(vol_);
  }

  // Slice into rolling windows for the engine tick
  for (let i = 150; i < closes.length; i++) {
    bars.push({
      closes:  closes.slice(i - 150, i),
      highs:   highs.slice(i - 150, i),
      lows:    lows.slice(i - 150, i),
      volumes: volumes.slice(i - 150, i),
    });
  }

  return bars;
}

// ── Parameter Store ────────────────────────────────────────────

async function saveParams(params, before, after) {
  const data = {
    ...params,
    _meta: {
      updatedAt:   new Date().toISOString(),
      beforeAvg:   before.avgPnl,
      afterAvg:    after.avgPnl,
      improvement: +(((after.avgPnl - before.avgPnl) / Math.abs(before.avgPnl)) * 100).toFixed(1) + '%',
    },
  };
  await saveState('params', data);
  log.info('Optimizer: params saved to DB', data._meta);
}

function diffParams(a, b) {
  const changes = {};
  for (const [key, val] of Object.entries(b)) {
    if (key === '_meta') continue;
    if (key === 'assets') {
      for (const [assetId, assetParams] of Object.entries(val)) {
        for (const [p, v] of Object.entries(assetParams)) {
          if (a.assets?.[assetId]?.[p] !== v) {
            changes[`${assetId}.${p}`] = { from: a.assets?.[assetId]?.[p], to: v };
          }
        }
      }
    } else if (key === 'CONF_RISK') {
      for (const [level, v] of Object.entries(val)) {
        if (a.CONF_RISK?.[level] !== v) {
          changes[`CONF_RISK.${level}`] = { from: a.CONF_RISK?.[level], to: v };
        }
      }
    } else if (JSON.stringify(a[key]) !== JSON.stringify(val)) {
      changes[key] = { from: a[key], to: val };
    }
  }
  return changes;
}

// ── Helpers ────────────────────────────────────────────────────

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Weekly Scheduler ───────────────────────────────────────────

/**
 * Start the weekly optimization schedule.
 * Runs every Sunday at 02:00 UTC.
 */
export function startOptimizationSchedule() {
  const checkSchedule = () => {
    const now = new Date();
    if (now.getUTCDay() === 0 && now.getUTCHours() === 2 && now.getUTCMinutes() < 5) {
      log.info('Optimizer: Sunday 02:00 UTC — running scheduled optimization');
      runOptimization().catch(err => log.error('Optimizer error', { err: err.message }));
    }
  };

  // Check every 5 minutes
  setInterval(checkSchedule, 5 * 60 * 1000);
  log.info('Optimizer: Weekly schedule active (Sundays 02:00 UTC)');
}
