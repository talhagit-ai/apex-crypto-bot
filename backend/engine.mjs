// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V1 — Trading Engine
//  Double partial profits, trailing stops, correlation-aware
//  Based on APEX V12 sim_v12_final.mjs:61-132 + crypto adaptations
// ═══════════════════════════════════════════════════════════════

import {
  CAPITAL, ASSETS, MAX_POS, MAX_BARS,
  PARTIAL1_R, PARTIAL1_PCT, PARTIAL2_R, PARTIAL2_PCT,
  TRAIL_R, TRAIL_ATR, MIN_CONF, MIN_RR,
  GROWTH_TRAIL_R, GROWTH_MAX_BARS, GROWTH_MIN_RR,
} from './config.mjs';
import { calcATR } from './indicators.mjs';
import { checkRegime, checkBearishRegime, generateSignal, generateShortSignal } from './signal.mjs';
import { createRiskState, checkPeriodReset, canOpenPosition, calculatePositionSize, recordTradeResult } from './risk.mjs';
import { log } from './logger.mjs';
import { saveTradeAnalytics } from './persistence.mjs';
import { blockLongDueToFunding, blockShortDueToFunding, shouldBoostShort } from './funding-client.mjs';

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
    this.regimes = {};
    this._regimeRaw = {};    // V12: raw regime per tick (voor hysteresis)
    this._regimeCount = {};  // V12: consecutive ticks in same regime
    this.opts = opts;            // { simMode: true } disables time-based features
    this.simTime = Date.now();   // Simulated clock (advanced 5min per tick in simMode)
    this.learningEngine = opts.learningEngine || null; // Self-learning engine

    // Overrideable params (set by optimizer or live param load)
    const p = opts.overrideParams || {};
    this.P1_R   = p.PARTIAL1_R   ?? PARTIAL1_R;
    this.P1_PCT = p.PARTIAL1_PCT ?? PARTIAL1_PCT;
    this.P2_R   = p.PARTIAL2_R   ?? PARTIAL2_R;
    this.P2_PCT = p.PARTIAL2_PCT ?? PARTIAL2_PCT;
    this.T_R    = p.TRAIL_R      ?? (opts.growthMode ? GROWTH_TRAIL_R  : TRAIL_R);
    this.T_ATR  = p.TRAIL_ATR    ?? TRAIL_ATR;
    this.MBARS  = p.MAX_BARS     ?? (opts.growthMode ? GROWTH_MAX_BARS : MAX_BARS);
    this.MCONF  = p.MIN_CONF     ?? MIN_CONF;
    this.MRR    = p.MIN_RR       ?? (opts.growthMode ? GROWTH_MIN_RR   : MIN_RR);
    // Per-asset slM/tpM overrides: { BTCUSDT: { slM, tpM }, ... }
    this.assetOverrides = p.assets || {};
    // V34: per-asset exit param overrides (PARTIAL1_R/P2_R/TRAIL_R/TRAIL_ATR/MIN_RR/MAX_BARS).
    // p.perAsset = { SOLUSDT: { PARTIAL1_R: 1.25, ... }, ... }
    this.perAssetParams = p.perAsset || {};
  }

  // V34 helpers: get per-asset exit param with fallback to global engine setting.
  _p1R(id)   { return this.perAssetParams[id]?.PARTIAL1_R ?? this.P1_R; }
  _p2R(id)   { return this.perAssetParams[id]?.PARTIAL2_R ?? this.P2_R; }
  _trR(id)   { return this.perAssetParams[id]?.TRAIL_R    ?? this.T_R; }
  _trATR(id) { return this.perAssetParams[id]?.TRAIL_ATR  ?? this.T_ATR; }
  _mRR(id)   { return this.perAssetParams[id]?.MIN_RR     ?? this.MRR; }
  _mBars(id) { return this.perAssetParams[id]?.MAX_BARS   ?? this.MBARS; }

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
        // Short: margin deducted from cash. Add back margin + unrealized P&L.
        // When price=entry: equity = (cash-margin) + margin + 0 = cash ✓
        unrealized += (pos.margin || 0) + pos.qty * (pos.entry - price);
      } else {
        unrealized += pos.qty * price;
      }
    }
    return Math.max(0, this.cash + unrealized); // V12: equity floor — voorkom negatieve equity
  }

  /**
   * Process a new bar tick for all assets
   * This is the main loop — called on every new candle
   *
   * @param {object} barData    - { BTCUSDT: { closes, highs, lows, volumes }, ... }
   * @param {object} regimeData - { BTCUSDT: { closes, highs, lows } } (1H data for regime)
   * @param {object} tf15Data   - { BTCUSDT: { closes, highs, lows } } (15m confirmation layer)
   */
  tick(barData, regimeData, tf15Data = null) {
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
      const p1R = this._p1R(id);
      if (!pos.partial1Taken && pnlR >= p1R) {
        const pqty = this._roundQty(id, pos.qty * this.P1_PCT);
        if (pqty > 0) {
          const pnl = isShort
            ? pqty * (pos.entry - cur)
            : pqty * (cur - pos.entry);
          if (pos.paperOnly) {
            // Paper short: no cash changes
          } else if (isShort) {
            const marginReturn = (pos.margin || 0) * (pqty / pos.qty);
            this.cash += marginReturn + pqty * (pos.entry - cur);
            pos.margin = (pos.margin || 0) - marginReturn;
          } else {
            this.cash += pqty * cur;
          }
          pos.qty -= pqty;
          pos.risk = pos.qty * Math.abs(pos.entry - pos.sl); // Update risk after partial
          pos.partial1Taken = true;
          this._logTrade(id, 'PARTIAL1', cur, pqty, pnl, p1R, `Partial @ ${p1R}R`);
          // V20: GEEN breakeven SL meer bij partial1 — geeft trade volledige ruimte
          // om TP te bereiken ipv premature SL-exit op 5m ruis
        }
      }

      // ── Pyramid Add-On (V19: alleen als statistieken dit rechtvaardigen) ──
      // Conditions: partial1 genomen, growth mode, long, winst tussen 0.5R-1.5R,
      // EN rolling win rate >= 55% over laatste 10 trades (anders: geen pyramid)
      if (this.opts.growthMode && pos.partial1Taken && !pos.pyramidAdded && !isShort && pnlR >= 0.5 && pnlR < 1.5) {
        const closed = this.trades.filter(t => ['SELL','COVER'].includes(t.side)).slice(-10);
        const winRate = closed.length >= 5
          ? closed.filter(t => (t.pnl || 0) > 0).length / closed.length
          : 1.0; // onvoldoende data: default toestaan
        const regime = this.regimes[id];
        const regimeOk = regime === 'bull' || regime === undefined;
        if (winRate >= 0.55 && regimeOk) {
          const addQty = this._roundQty(id, pos.qty * 0.35); // V19: 35% (was 50%, veiliger bij klein cap)
          const addCost = addQty * cur;
          if (addQty > 0 && addCost < this.cash * 0.25) { // V19: 25% cash cap (was 30%)
            this.cash -= addCost;
            pos.qty += addQty;
            pos.risk = pos.qty * Math.abs(pos.entry - pos.sl);
            pos.pyramidAdded = true;
            this._logTrade(id, 'PYRAMID', cur, addQty, null, null, `Add-on @ ${pnlR.toFixed(1)}R (winRate ${(winRate*100).toFixed(0)}%)`);
          }
        }
      }

      // ── Partial Profit #2 @ 1.0R ────────────────────────────
      const p2R = this._p2R(id);
      if (pos.partial1Taken && !pos.partial2Taken && pnlR >= p2R) {
        const pqty = this._roundQty(id, pos.qty * this.P2_PCT);
        if (pqty > 0) {
          const pnl = isShort
            ? pqty * (pos.entry - cur)
            : pqty * (cur - pos.entry);
          if (pos.paperOnly) {
            // Paper short: no cash changes
          } else if (isShort) {
            const marginReturn = (pos.margin || 0) * (pqty / pos.qty);
            this.cash += marginReturn + pqty * (pos.entry - cur);
            pos.margin = (pos.margin || 0) - marginReturn;
          } else {
            this.cash += pqty * cur;
          }
          pos.qty -= pqty;
          pos.risk = pos.qty * Math.abs(pos.entry - pos.sl); // Update risk after partial
          pos.partial2Taken = true;
          this._logTrade(id, 'PARTIAL2', cur, pqty, pnl, p2R, `Partial @ ${p2R}R`);

          // V20: Breakeven SL pas NA partial2 (+1.5R) — niet na partial1
          // Runner is dan ~50% risk-free want +1.0R al binnen
          if (isShort) { if (pos.entry < pos.sl) pos.sl = pos.entry; }
          else         { if (pos.entry > pos.sl) pos.sl = pos.entry; }
        }
      }

      // ── V21 Trade-duration SL shield (NFIX-inspired) ──
      // Eerste 3 bars (15 min): GEEN trailing. Voorkomt "entry shock" whipsaw.
      // Bars 3-12 (15-60 min): normale trail. Bars 12+: normale trail (V20 regel).
      const allowTrail = pos.age >= 3;

      // ── Trailing Stop (V20/V21: pas vanaf +1R, geen tightening tot +3R, niet in eerste 3 bars) ──
      const tR    = this._trR(id);
      const tATR  = this._trATR(id);
      const mBars = this._mBars(id);
      if (allowTrail && pnlR >= tR) {
        const regime = this.regimes[id];
        const vReg   = pos.volRegime || 'trending';
        const isStrongTrend = regime === 'bull' && pos.age < mBars * 0.5;
        // Wijde basis: geef winner ademruimte — liever full TP dan vroeg SL
        let trailMult = isStrongTrend ? tATR : tATR * 0.9;
        // V20: pas na +3R locken (echte home-runs) — daarvoor geen choking
        if (pnlR >= 3.0) trailMult *= 0.70;
        // Volatility regime adjustment
        if (vReg === 'ranging')     trailMult *= 1.30;  // WIJDER in chop
        if (vReg === 'clean_trend') trailMult *= 0.90;  // licht strakker in trend
        if (isShort) {
          const newSl = cur + ATR * trailMult;
          if (newSl < pos.sl) pos.sl = newSl;
        } else {
          const newSl = cur - ATR * trailMult;
          if (newSl > pos.sl) pos.sl = newSl;
        }
      }

      // V17: age decay SL-tightening verwijderd — trok SL naar entry bij zijwaartse drift,
      // veroorzaakte 89% TIME exits met tiny R (data: 23/27 exits had |R|<0.8)

      // ── Exit Conditions ─────────────────────────────────────
      let exitReason = null;
      if (isShort) {
        if (cur >= pos.sl)       exitReason = 'SL';
        else if (cur <= pos.tp)  exitReason = 'TP';
      } else {
        if (cur <= pos.sl)       exitReason = 'SL';
        else if (cur >= pos.tp)  exitReason = 'TP';
      }
      if (pos.age >= this._mBars(id)) exitReason = exitReason || 'TIME';

      if (exitReason && pos.qty > 0) {
        this._closePosition(id, cur, exitReason);
      } else if (pos.qty <= 0) {
        delete this.positions[id];
      }
    }

    // ── Look for new entries ──────────────────────────────────
    const openPositions = Object.entries(this.positions).map(([id, p]) => ({ assetId: id, ...p }));

    if (openPositions.length < MAX_POS) {
      // V18: BTC cross-asset regime filter: block alt longs als BTC > 3% daalt in 4h
      // V21: compute BTC 1h change ook, voor BTC cascade sizing
      let btcRegimeBlock = false;
      let btcChange1h = 0;
      const btcData = barData['BTCUSDT'];
      if (btcData?.closes?.length >= 48) {
        const btcNow  = btcData.closes[btcData.closes.length - 1];
        const btc4hAgo = btcData.closes[btcData.closes.length - 48];
        if ((btcNow - btc4hAgo) / btc4hAgo < -0.03) {
          btcRegimeBlock = true;
          log.info('BTC regime block: BTC down >3% in 4h — blocking alt longs');
        }
      }
      if (btcData?.closes?.length >= 12) {
        const btcNow   = btcData.closes[btcData.closes.length - 1];
        const btc1hAgo = btcData.closes[btcData.closes.length - 12];
        btcChange1h = (btcNow - btc1hAgo) / btc1hAgo;
      }

      // Generate signals and sort by confidence (best first)
      const candidates = [];
      for (const asset of ASSETS) {
        const b = barData[asset.id];
        if (!b || this.positions[asset.id]) continue;

        // Skip alt longs when BTC is dumping
        if (btcRegimeBlock && asset.id !== 'BTCUSDT') {
          log.info(`Skip ${asset.id}: BTC regime block active`);
          continue;
        }

        const rd = regimeData?.[asset.id] || b;
        const sigOpts = { MIN_CONF: this.MCONF, MIN_RR: this._mRR(asset.id), growthMode: this.opts.growthMode };
        const assetCfg = this.assetOverrides[asset.id]
          ? { ...asset, ...this.assetOverrides[asset.id] }
          : asset;

        // ── Try LONG ──────────────────────────────────────────
        const bullRegime = checkRegime(rd.closes, rd.highs, rd.lows, asset.regimeATR || 0.05);
        const d15 = tf15Data?.[asset.id] || null;
        const confirmedRegime = this.regimes[asset.id];
        if (bullRegime && confirmedRegime === 'bull') {
          // V32: Funding-rate filter — block long entries on overheated funding (live mode only)
          const fundingBlock = !this.opts.simMode && blockLongDueToFunding(asset.id);
          if (fundingBlock && fundingBlock.blocked) {
            log.info(`Skip LONG ${asset.id}: funding ${(fundingBlock.fundingRate*100).toFixed(3)}% too crowded`);
          } else {
            const sig = generateSignal(assetCfg, b.closes, b.highs, b.lows, b.volumes, true, sigOpts, rd, d15);
            if (sig) {
              if (this.learningEngine) {
                const learnMult = this.learningEngine.scoreSignal(
                  asset.id, new Date().getUTCHours(), 'bull', sig.volRegime, sig.conf, sig.factors
                );
                sig.qualityScore *= learnMult;
                sig.learnMult = +learnMult.toFixed(2);
              }
              sig.btcChange1h = btcChange1h;
              candidates.push({ asset: assetCfg, sig });
            }
          }
        }

        // ── Try SHORT ─────────────────────────────────────────
        const bearRegime = checkBearishRegime(rd.closes, rd.highs, rd.lows, asset.regimeATR || 0.05);
        if (bearRegime && confirmedRegime === 'bear' && this.opts.enableShorts) {
          // V32: Funding-rate filter — block short entries on inverse-overheated funding
          const fundingBlock = !this.opts.simMode && blockShortDueToFunding(asset.id);
          if (fundingBlock && fundingBlock.blocked) {
            log.info(`Skip SHORT ${asset.id}: funding ${(fundingBlock.fundingRate*100).toFixed(3)}% inverse-crowded`);
          } else {
            const sig = generateShortSignal(assetCfg, b.closes, b.highs, b.lows, b.volumes, true, sigOpts, rd, d15);
            if (sig) {
              if (this.learningEngine) {
                const learnMult = this.learningEngine.scoreSignal(
                  asset.id, new Date().getUTCHours(), 'bear', sig.volRegime, sig.conf, sig.factors
                );
                sig.qualityScore *= learnMult;
                sig.learnMult = +learnMult.toFixed(2);
              }
              // V32: boost short conviction when funding very high (squeeze risk)
              if (!this.opts.simMode && shouldBoostShort(asset.id)) {
                sig.qualityScore += 0.6;
                sig.fundingBoost = true;
              }
              sig.btcChange1h = btcChange1h;
              candidates.push({ asset: assetCfg, sig });
            }
          }
        }

        // V12: Regime hysteresis — regime mag pas wisselen na 3 opeenvolgende bars
        const rawRegime = bullRegime ? 'bull' : bearRegime ? 'bear' : 'neutral';
        const prevRaw = this._regimeRaw[asset.id];
        if (rawRegime === prevRaw) {
          this._regimeCount[asset.id] = (this._regimeCount[asset.id] || 0) + 1;
        } else {
          this._regimeCount[asset.id] = 1;
        }
        this._regimeRaw[asset.id] = rawRegime;
        if (this._regimeCount[asset.id] >= 2 || !this.regimes[asset.id]) { // V13: was 3
          this.regimes[asset.id] = rawRegime;
        }

        if (!bullRegime && !bearRegime) {
          log.info(`Skip ${asset.id}: geen trend (noch bull noch bear)`);
        }
      }

      // Sort: highest confidence first, then best R:R
      candidates.sort((a, b) => b.sig.conf - a.sig.conf || b.sig.rr - a.sig.rr);

      // Track available capital separately to prevent overleverage when
      // multiple positions are opened in the same tick
      let availableCash = this.cash;

      for (const { asset, sig } of candidates) {
        if (Object.keys(this.positions).length >= MAX_POS) break;

        // V16: live mode gebruikt Date.now() — this.simTime staat vast op starttijd (sessiefilter fix)
        const now = this.opts.simMode ? this.simTime : Date.now();
        const check = canOpenPosition(this.riskState, asset.id, openPositions, now);
        if (!check.allowed) {
          log.info(`Skip ${asset.id}: ${check.reason}`);
          continue;
        }

        const posOpts = this.opts.simMode ? { peakMult: 0.85 } : {};
        if (this.opts.growthMode) posOpts.growthMode = true;
        const qty = calculatePositionSize(sig, availableCash, this.riskState, posOpts);
        if (qty <= 0) continue;

        const cost = qty * sig.price;
        const isShort = sig.side === 'short';

        // For longs: full notional must fit in cash. For shorts: margin check below.
        if (!isShort && cost > availableCash * 0.88) continue;
        const slDist  = Math.abs(sig.price - sig.sl);

        // Long: deduct cost from cash. Short: futures margin (10% of notional)
        if (isShort) {
          const margin = cost * 0.10;
          if (margin > availableCash * 0.30) continue; // max 30% cash as margin
          this.cash -= margin;
          availableCash -= margin;
        } else {
          this.cash -= cost;
          availableCash -= cost;
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
          conf: sig.conf,
          qualityScore: sig.qualityScore,
          score100: sig.score100,
          factors: sig.factors,
          atrPercentile: sig.atrPercentile,
          volRegime: sig.volRegime,
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

    if (pos.paperOnly) {
      // Paper short: track PnL for stats but don't change cash (no real money involved)
      pnl = (pos.entry - price) * pos.qty;
      cashReturn = 0;
    } else if (isShort) {
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

    // Record exit for cooldown system
    this.riskState.lastExitTime = this.riskState.lastExitTime || {};
    this.riskState.lastExitTime[id] = { timestamp: Date.now(), reason };

    log.trade(`EXIT ${id}`, {
      reason,
      pnl: +pnl.toFixed(2),
      pnlR: +pnlR.toFixed(2),
      age: pos.age,
      equity: +this.equity({ [id]: price }).toFixed(2),
    });

    // Save enriched trade data for self-learning engine
    const entryHourUTC = new Date(Date.now() - pos.age * 5 * 60000).getUTCHours();
    const analyticsData = {
      asset: id, side: pos.side, entryPrice: pos.entry, exitPrice: price,
      pnl, rMultiple: pnlR, entryHourUTC,
      regime: this.regimes[id] || 'neutral', volRegime: pos.volRegime || null,
      conf: pos.conf || null, qualityScore: pos.qualityScore || null,
      factors: pos.factors || null, atrPercentile: pos.atrPercentile || null,
      holdBars: pos.age, exitReason: reason, paperOnly: !!pos.paperOnly,
    };
    saveTradeAnalytics(analyticsData).catch(() => {});

    // Real-time learning update — no need to wait for 5-min DB refresh
    if (this.learningEngine) {
      this.learningEngine.recordTrade({
        asset:          analyticsData.asset,
        side:           analyticsData.side,
        pnl:            analyticsData.pnl,
        r_multiple:     analyticsData.rMultiple,
        entry_hour_utc: analyticsData.entryHourUTC,
        regime:         analyticsData.regime,
        vol_regime:     analyticsData.volRegime,
        conf:           analyticsData.conf,
        factors:        analyticsData.factors,
        exit_reason:    analyticsData.exitReason,
        paper_only:     analyticsData.paperOnly ? 1 : 0,
        timestamp:      Date.now(),
      });
    }

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
    const closedTrades = this.trades.filter(t => ['SELL', 'COVER'].includes(t.side));
    const wins = closedTrades.filter(t => t.win);
    const winRate = wins.length / Math.max(closedTrades.length, 1) * 100;
    const grossWin = wins.reduce((s, t) => s + (t.pnl || 0), 0);
    const grossLoss = Math.abs(closedTrades.filter(t => !t.win).reduce((s, t) => s + (t.pnl || 0), 0));
    const profitFactor = grossWin / Math.max(grossLoss, 1e-9);

    return {
      equity: +eq.toFixed(2),
      cash: +this.cash.toFixed(2),
      startCapital: this.riskState.startCapital,
      pnl: +(eq - this.riskState.startCapital).toFixed(2),
      returnPct: +((eq - this.riskState.startCapital) / this.riskState.startCapital * 100).toFixed(2),
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
        dailyLoss: +(this.riskState.dailyLoss / this.riskState.startCapital * 100).toFixed(1),
        weeklyLoss: +(this.riskState.weeklyLoss / this.riskState.startCapital * 100).toFixed(1),
        riskReduction: this.riskState.riskReduction,
        killed: this.riskState.killed,
      },
      tickCount: this.tickCount,
      regimes: { ...this.regimes },
    };
  }
}
