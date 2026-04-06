// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V1 — Trading Engine
//  Double partial profits, trailing stops, correlation-aware
//  Based on APEX V12 sim_v12_final.mjs:61-132 + crypto adaptations
// ═══════════════════════════════════════════════════════════════

import {
  CAPITAL, ASSETS, MAX_POS, MAX_BARS,
  PARTIAL1_R, PARTIAL1_PCT, PARTIAL2_R, PARTIAL2_PCT,
  TRAIL_R, TRAIL_ATR, MIN_CONF, MIN_RR,
} from './config.mjs';
import { calcATR } from './indicators.mjs';
import { checkRegime, checkBearishRegime, generateSignal, generateShortSignal } from './signal.mjs';
import { createRiskState, checkPeriodReset, canOpenPosition, calculatePositionSize, recordTradeResult } from './risk.mjs';
import { log } from './logger.mjs';

/**
 * Trading Engine — manages positions, signals, and exits
 */
export class TradingEngine {
  constructor(capital = CAPITAL, opts = {}) {
    this.capital = capital;
    this.cash = capital;
    this.positions = {};         // { BTCUSDT: { qty, entry, sl, tp, ... } }
    this.trades = [];            // Trade history
    this.riskState = createRiskState(capital);
    this.tickCount = 0;
    this.opts = opts;            // { simMode: true } disables time-based features
    this.simTime = Date.now();   // Simulated clock (advanced 5min per tick in simMode)

    // Overrideable params (set by optimizer or live param load)
    const p = opts.overrideParams || {};
    this.P1_R   = p.PARTIAL1_R   ?? PARTIAL1_R;
    this.P1_PCT = p.PARTIAL1_PCT ?? PARTIAL1_PCT;
    this.P2_R   = p.PARTIAL2_R   ?? PARTIAL2_R;
    this.P2_PCT = p.PARTIAL2_PCT ?? PARTIAL2_PCT;
    this.T_R    = p.TRAIL_R      ?? TRAIL_R;
    this.T_ATR  = p.TRAIL_ATR    ?? TRAIL_ATR;
    this.MBARS  = p.MAX_BARS     ?? MAX_BARS;
    this.MCONF  = p.MIN_CONF     ?? MIN_CONF;
    this.MRR    = p.MIN_RR       ?? MIN_RR;
    // Per-asset slM/tpM overrides: { BTCUSDT: { slM, tpM }, ... }
    this.assetOverrides = p.assets || {};
  }

  /**
   * Simplified tick for optimizer simulation — no regime data (uses 5m as fallback)
   */
  tickFlat(barData) {
    return this.tick(barData, null);
  }

  /**
   * Get current equity (cash + unrealized positions)
   */
  equity(currentPrices) {
    let unrealized = 0;
    for (const [id, pos] of Object.entries(this.positions)) {
      const price = currentPrices[id] || pos.entry;
      if (pos.side === 'short') {
        // Short: we received cash at entry, owe qty*price back
        // Unrealized = qty*entry (already in cash) - qty*price (current liability)
        unrealized += pos.qty * (pos.entry - price);
      } else {
        unrealized += pos.qty * price;
      }
    }
    return this.cash + unrealized;
  }

  /**
   * Process a new bar tick for all assets
   * This is the main loop — called on every new candle
   *
   * @param {object} barData - { BTCUSDT: { closes, highs, lows, volumes }, ... }
   * @param {object} regimeData - { BTCUSDT: { closes, highs, lows } } (1H data for regime)
   */
  tick(barData, regimeData) {
    this.tickCount++;
    if (this.opts.simMode) this.simTime += 5 * 60 * 1000; // advance 5 min per tick
    checkPeriodReset(this.riskState);

    const currentPrices = {};
    for (const asset of ASSETS) {
      const b = barData[asset.id];
      if (b && b.closes.length > 0) {
        currentPrices[asset.id] = b.closes[b.closes.length - 1];
      }
    }

    // ── Check circuit breaker: force close all if daily limit hit ──
    if (this.riskState.riskReduction === 0 && Object.keys(this.positions).length > 0) {
      log.warn('Circuit breaker active — force closing all positions');
      for (const id of Object.keys(this.positions)) {
        this._closePosition(id, currentPrices[id] || this.positions[id].entry, 'CIRCUIT_BREAKER');
      }
      return;
    }

    // ── Manage existing positions ──────────────────────────────
    for (const [id, pos] of Object.entries({ ...this.positions })) {
      const b = barData[id];
      if (!b) continue;
      const cur = currentPrices[id];
      const ATR = calcATR(b.highs, b.lows, b.closes, 14);

      pos.age = (pos.age || 0) + 1;
      const isShort = pos.side === 'short';

      // Peak tracking: long = highest price, short = lowest price
      if (!isShort && cur > pos.peak) pos.peak = cur;
      if (isShort  && cur < pos.peak) pos.peak = cur;

      // P&L in R: long = (cur-entry)/riskPerUnit, short = (entry-cur)/riskPerUnit
      const pnlR = isShort
        ? (pos.entry - cur) * pos.qty / Math.max(pos.risk, 1e-9)
        : (cur - pos.entry) * pos.qty / Math.max(pos.risk, 1e-9);

      // ── Partial Profit #1 @ 0.5R ────────────────────────────
      if (!pos.partial1Taken && pnlR >= this.P1_R) {
        const pqty = this._roundQty(id, pos.qty * this.P1_PCT);
        if (pqty > 0) {
          const pnl = isShort
            ? pqty * (pos.entry - cur)
            : pqty * (cur - pos.entry);
          this.cash += isShort ? pqty * (2 * pos.entry - cur) : pqty * cur;
          pos.qty -= pqty;
          pos.partial1Taken = true;
          this._logTrade(id, 'PARTIAL1', cur, pqty, pnl, this.P1_R, `Partial @ ${this.P1_R}R`);

          // Half-breakeven SL after first partial
          if (isShort) {
            const halfBE = pos.originalSl - (pos.originalSl - pos.entry) * 0.5;
            if (halfBE < pos.sl) { pos.sl = halfBE; pos.breakeven = true; }
          } else {
            const halfBE = pos.originalSl + (pos.entry - pos.originalSl) * 0.5;
            if (halfBE > pos.sl) { pos.sl = halfBE; pos.breakeven = true; }
          }
        }
      }

      // ── Partial Profit #2 @ 1.0R ────────────────────────────
      if (pos.partial1Taken && !pos.partial2Taken && pnlR >= this.P2_R) {
        const pqty = this._roundQty(id, pos.qty * this.P2_PCT);
        if (pqty > 0) {
          const pnl = isShort
            ? pqty * (pos.entry - cur)
            : pqty * (cur - pos.entry);
          this.cash += isShort ? pqty * (2 * pos.entry - cur) : pqty * cur;
          pos.qty -= pqty;
          pos.partial2Taken = true;
          this._logTrade(id, 'PARTIAL2', cur, pqty, pnl, this.P2_R, `Partial @ ${this.P2_R}R`);

          // Full breakeven SL — runner is risk-free
          if (isShort) { if (pos.entry < pos.sl) pos.sl = pos.entry; }
          else         { if (pos.entry > pos.sl) pos.sl = pos.entry; }
        }
      }

      // ── Trailing Stop ───────────────────────────────────────
      if (pnlR >= this.T_R) {
        if (isShort) {
          const newSl = cur + ATR * this.T_ATR;
          if (newSl < pos.sl) pos.sl = newSl;
        } else {
          const newSl = cur - ATR * this.T_ATR;
          if (newSl > pos.sl) pos.sl = newSl;
        }
      }

      // ── Exit Conditions ─────────────────────────────────────
      let exitReason = null;
      if (isShort) {
        if (cur >= pos.sl)       exitReason = 'SL';
        else if (cur <= pos.tp)  exitReason = 'TP';
      } else {
        if (cur <= pos.sl)       exitReason = 'SL';
        else if (cur >= pos.tp)  exitReason = 'TP';
      }
      if (pos.age >= this.MBARS) exitReason = exitReason || 'TIME';

      if (exitReason && pos.qty > 0) {
        this._closePosition(id, cur, exitReason);
      } else if (pos.qty <= 0) {
        delete this.positions[id];
      }
    }

    // ── Look for new entries ──────────────────────────────────
    const openPositions = Object.entries(this.positions).map(([id, p]) => ({ assetId: id, ...p }));

    if (openPositions.length < MAX_POS) {
      // Generate signals and sort by confidence (best first)
      const candidates = [];
      for (const asset of ASSETS) {
        const b = barData[asset.id];
        if (!b || this.positions[asset.id]) continue;

        const rd = regimeData?.[asset.id] || b;
        const sigOpts = { MIN_CONF: this.MCONF, MIN_RR: this.MRR };
        const assetCfg = this.assetOverrides[asset.id]
          ? { ...asset, ...this.assetOverrides[asset.id] }
          : asset;

        // ── Try LONG ──────────────────────────────────────────
        const bullRegime = checkRegime(rd.closes, rd.highs, rd.lows, asset.regimeATR || 0.05);
        if (bullRegime) {
          const sig = generateSignal(assetCfg, b.closes, b.highs, b.lows, b.volumes, true, sigOpts);
          if (sig) candidates.push({ asset: assetCfg, sig });
          else log.info(`Skip ${asset.id} LONG: signal rejected`);
        }

        // ── Try SHORT ─────────────────────────────────────────
        const bearRegime = checkBearishRegime(rd.closes, rd.highs, rd.lows, asset.regimeATR || 0.05);
        if (bearRegime) {
          const sig = generateShortSignal(assetCfg, b.closes, b.highs, b.lows, b.volumes, true, sigOpts);
          if (sig) candidates.push({ asset: assetCfg, sig });
          else log.info(`Skip ${asset.id} SHORT: signal rejected`);
        }

        if (!bullRegime && !bearRegime) {
          log.info(`Skip ${asset.id}: geen trend (noch bull noch bear)`);
        }
      }

      // Sort: highest confidence first, then best R:R
      candidates.sort((a, b) => b.sig.conf - a.sig.conf || b.sig.rr - a.sig.rr);

      for (const { asset, sig } of candidates) {
        if (Object.keys(this.positions).length >= MAX_POS) break;

        const check = canOpenPosition(this.riskState, asset.id, openPositions, this.simTime);
        if (!check.allowed) {
          log.info(`Skip ${asset.id}: ${check.reason}`);
          continue;
        }

        const posOpts = this.opts.simMode ? { peakMult: 0.85 } : {};
        const qty = calculatePositionSize(sig, this.cash, this.riskState, posOpts);
        if (qty <= 0) continue;

        const cost = qty * sig.price;
        if (cost > this.cash * 0.88) continue;

        const isShort = sig.side === 'short';
        const slDist  = Math.abs(sig.price - sig.sl);

        // Long: deduct cost from cash. Short: futures margin (10% of notional)
        if (isShort) {
          const margin = cost * 0.10;
          if (margin > this.cash * 0.30) continue; // max 30% cash as margin
          this.cash -= margin;
        } else {
          this.cash -= cost;
        }

        this.positions[asset.id] = {
          side: sig.side || 'long',
          qty,
          entry: sig.price,
          sl: sig.sl,
          tp: sig.tp,
          atr: sig.atr,
          risk: qty * slDist,
          originalSl: sig.sl,
          peak: sig.price,
          age: 0,
          partial1Taken: false,
          partial2Taken: false,
          breakeven: false,
          margin: isShort ? cost * 0.10 : 0,
        };

        openPositions.push({ assetId: asset.id });

        const confLabel = sig.conf >= 6 ? '★★' : sig.conf >= 5 ? '★ ' : '  ';
        const sideLabel = isShort ? 'SHORT' : 'LONG';
        this._logTrade(asset.id, isShort ? 'SHORT' : 'BUY', sig.price, qty, null, null,
          `${confLabel}${sig.conf}/6 · R:R ${sig.rr} · ${sideLabel}`);

        log.signal(`ENTRY ${sideLabel} ${asset.id}`, {
          conf: sig.conf,
          rr: sig.rr,
          price: sig.price,
          sl: sig.sl,
          tp: sig.tp,
          qty,
        });
      }
    }
  }

  /**
   * Close a position and record the trade
   */
  _closePosition(id, price, reason) {
    const pos = this.positions[id];
    if (!pos || pos.qty <= 0) return;

    const isShort = pos.side === 'short';
    let pnl, cashReturn;

    if (isShort) {
      pnl = (pos.entry - price) * pos.qty;          // profit when price falls
      cashReturn = (pos.margin || 0) + pnl;          // return margin + profit/loss
    } else {
      pnl = (price - pos.entry) * pos.qty;
      cashReturn = pos.qty * price;
    }
    this.cash += cashReturn;

    const pnlR = pnl / Math.max(pos.risk, 1e-9);

    this._logTrade(id, isShort ? 'COVER' : 'SELL', price, pos.qty, pnl, pnlR, reason);

    recordTradeResult(this.riskState, id, pnl, this.equity({ [id]: price }));

    log.trade(`EXIT ${id}`, {
      reason,
      pnl: +pnl.toFixed(2),
      pnlR: +pnlR.toFixed(2),
      age: pos.age,
      equity: +this.equity({ [id]: price }).toFixed(2),
    });

    delete this.positions[id];
  }

  /**
   * Round quantity to asset's step size
   */
  _roundQty(assetId, qty) {
    const asset = ASSETS.find(a => a.id === assetId);
    if (!asset) return qty;
    return Math.floor(qty / asset.qtyStep) * asset.qtyStep;
  }

  /**
   * Log a trade to the trade history
   */
  _logTrade(id, side, price, qty, pnl, r, reason) {
    this.trades.push({
      id,
      side,
      price: +price.toFixed(6),
      qty,
      pnl: pnl !== null ? +pnl.toFixed(2) : null,
      r: r !== null ? +Number(r).toFixed(2) : null,
      win: pnl !== null ? pnl > 0 : null,
      reason,
      timestamp: Date.now(),
      t: new Date().toLocaleTimeString('nl-NL'),
    });

    // Keep last 500 trades in memory
    if (this.trades.length > 500) this.trades.shift();
  }

  /**
   * Get current state snapshot (for frontend)
   */
  getState(currentPrices) {
    const eq = this.equity(currentPrices);
    const closedTrades = this.trades.filter(t => t.side !== 'BUY' && t.side !== 'PARTIAL1' && t.side !== 'PARTIAL2');
    const wins = closedTrades.filter(t => t.win);
    const winRate = wins.length / Math.max(closedTrades.length, 1) * 100;
    const grossWin = wins.reduce((s, t) => s + (t.pnl || 0), 0);
    const grossLoss = Math.abs(closedTrades.filter(t => !t.win).reduce((s, t) => s + (t.pnl || 0), 0));
    const profitFactor = grossWin / Math.max(grossLoss, 1e-9);

    return {
      equity: +eq.toFixed(2),
      cash: +this.cash.toFixed(2),
      startCapital: this.capital,
      pnl: +(eq - this.capital).toFixed(2),
      returnPct: +((eq - this.capital) / this.capital * 100).toFixed(2),
      assets: ASSETS.map(a => ({ id: a.id, color: a.color })),
      positions: { ...this.positions },
      trades: this.trades.slice(-100),
      stats: {
        winRate: +winRate.toFixed(1),
        profitFactor: +profitFactor.toFixed(2),
        totalTrades: closedTrades.length,
        wins: wins.length,
        losses: closedTrades.length - wins.length,
      },
      risk: {
        dailyLoss: +(this.riskState.dailyLoss / this.capital * 100).toFixed(1),
        weeklyLoss: +(this.riskState.weeklyLoss / this.capital * 100).toFixed(1),
        riskReduction: this.riskState.riskReduction,
        killed: this.riskState.killed,
      },
      tickCount: this.tickCount,
    };
  }
}
