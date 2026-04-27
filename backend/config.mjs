// ═══════════════════════════════════════════════════════════════
//  APEX CRYPTO V2 — Configuration
//  Kraken Spot Trading | BTC/ETH/SOL/XRP/BNB/ADA
//  Based on APEX V12 stock bot (+€72.94/week proven edge)
//  Upgraded: Breakeven SL, 8-factor signal, rising ADX filter
// ═══════════════════════════════════════════════════════════════

import 'dotenv/config';

// ── Exchange ────────────────────────────────────────────────────
export const KRAKEN_API_KEY             = process.env.KRAKEN_API_KEY || '';
export const KRAKEN_API_SECRET          = process.env.KRAKEN_API_SECRET || '';
// Futures keys — falls back to spot keys if not set separately
export const KRAKEN_FUTURES_API_KEY     = process.env.KRAKEN_FUTURES_API_KEY     || process.env.KRAKEN_API_KEY    || '';
export const KRAKEN_FUTURES_API_SECRET  = process.env.KRAKEN_FUTURES_API_SECRET  || process.env.KRAKEN_API_SECRET || '';
// Enable short selling via Kraken Futures (requires futures API keys)
export const ENABLE_SHORTS = process.env.ENABLE_SHORTS === 'true';
// Paper-trade shorts: engine generates short signals and tracks internally,
// but no real futures orders are placed. V24: default AAN zodat bot ook trades in bear
// markets maakt (paper only, geen echt geld risico, genereert validation data).
export const DRY_RUN_SHORTS = process.env.DRY_RUN_SHORTS !== 'false';
// Legacy Bybit keys (kept for reference)
export const BYBIT_API_KEY    = process.env.BYBIT_API_KEY || '';
export const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET || '';
export const BYBIT_TESTNET    = process.env.BYBIT_TESTNET !== 'false';
export const BYBIT_BASE_URL   = process.env.BYBIT_BASE_URL || '';
export const MODE             = process.env.MODE || 'spot';

// ── Capital & Position ─────────────────────────────────────────
export const CAPITAL    = Number(process.env.CAPITAL) || 100;
export const MAX_POS    = 5;          // V31 AGGRESSIVE: 5 simultane posities (was 3) — meer kansen, één per asset blijft
export const MAX_DEPLOY = 0.85;       // V31: 15% cash reserve (was 30%) — meer kapitaal in spel voor compounding
export const MAX_SINGLE_PCT = 0.50;   // V31: tot 50% per positie — concentreer op proven edge (XRP) toegestaan
export const MIN_ORDER_USD  = 10;     // Kraken minimum notional per order (~$10)

// ── Signal Requirements ────────────────────────────────────────
export const MIN_CONF   = 3;          // V31 AGGRESSIVE: 3 conf-floor (was 4) — meer trades, lagere drempel; quality boost via V30 indicators
export const MIN_RR     = 1.3;        // V31 AGGRESSIVE: 1.3 (was 1.5) — sneller bevestigde setups, accept marginaal lagere edge per trade voor hogere trade-frequentie

// ── Exit Mechanics (V12 Edge + Double Partial) ─────────────────
export const PARTIAL1_R   = 1.5;      // V26: walk-forward robust winner — laat winners langer lopen voor partial. V25 (P1=0.75) was gefit op train, faalde op test.
export const PARTIAL1_PCT = 0.25;     // V20: kleinere partial, meer runner
export const PARTIAL2_R   = 2.0;      // V26: PARTIAL1_R + 0.5
export const PARTIAL2_PCT = 0.25;     // V20: behoudt 50% als runner
export const TRAIL_R      = 1.5;      // V40: walk-forward-anchored 4-asset universe wint TR=1.5 (was 1.25) — top-10 alle TR=1.5/1.25 op recent 30d test slice (+7.55% best config)
export const TRAIL_ATR    = 2.5;      // V40: walk-forward-anchored bevestigt 2.5 (was 1.5). Wijdere ATR-mult laat winners tijdens alt season langer rijden voor TP.
export const MAX_BARS     = 96;       // V17: 8h (was 72=6h) — met 5m-ATR TP heeft prijs meer tijd nodig

// ── Risk Management ────────────────────────────────────────────
// V31 AGGRESSIVE: ruimere CB-niveaus voor hogere variance-tolerantie.
// Compensatie: hot/cold-streak modifier in risk.mjs en V29 margin-cap in server.mjs blijven streng.
export const DAILY_LOSS_LIMIT_1  = 0.080;  // V31: 8% → reduce risk 50% (was 6%)
export const DAILY_LOSS_LIMIT_2  = 0.140;  // V31: 14% → stop 24h (was 10%)
export const WEEKLY_LOSS_LIMIT_1 = 0.120;  // V31: 12% → reduce size 50% (was 8%)
export const WEEKLY_LOSS_LIMIT_2 = 0.220;  // V31: 22% → stop entire week (was 15%)
export const KILL_SWITCH_PCT     = 0.30;   // V31: 30% drawdown → full stop (was 20%)
export const LOSS_LIMIT          = 6;      // V17b: meer kansen per asset (was 4)
export const PAUSE_MINUTES       = 30;     // V17b: kortere pauze (was 60)
export const TOTAL_LOSS_LIMIT    = 6;      // V18: strenger bij klein kapitaal (was 10 — 10×$8=$80=40% drawdown)
export const TOTAL_PAUSE_MINUTES = 30;     // V17b: kortere pauze (was 90)
export const MAX_RISK_PER_TRADE  = 0.030;  // 3.0% max risk per single trade

// ── Confidence-Based Risk Sizing ───────────────────────────────
export const CONF_RISK = {
  3: 0.008,   // 0.8% risk at 3/6 (minimum confluence — small size)
  4: 0.015,   // 1.5% risk at 4/6 confidence
  5: 0.025,   // 2.5% risk at 5/6
  6: 0.030,   // 3.0% risk at 6/6 (full confidence — only on perfect setups)
};

// ── Signal Quality Weights ─────────────────────────────────────
export const FACTOR_WEIGHTS = {
  emaStack: 1.3, vwap: 1.0, rsi: 0.8, macd: 1.1, volume: 1.2, rsiAccel: 0.6,
};
export const FACTOR_WEIGHT_MAX = Object.values(FACTOR_WEIGHTS).reduce((a, b) => a + b, 0);

// ── Regime Filter ──────────────────────────────────────────────
export const SLOPE_BARS = 3;          // V27: 3h (was 5h) — snellere regime turn detection in alt season
export const ADX_MIN    = 12;         // V27: 12 (was 15) — accept zwakkere trends, vooral in DOGE/AVAX consolidations

// ── Timeframe ──────────────────────────────────────────────────
export const CANDLE_INTERVAL    = '5';    // 5-minute candles for entries
export const TF15_INTERVAL      = '15';   // 15-minute candles for confirmation layer
export const REGIME_INTERVAL    = '60';   // 1-hour candles for regime filter
export const HISTORY_BARS       = 150;    // Rolling buffer size
export const VWAP_WINDOW        = 72;     // 6h rolling VWAP (crypto institutional cycles)

// ── Peak Hours (UTC) ───────────────────────────────────────────
export const PEAK_HOURS = [
  [13, 17],   // 13:00-17:00 UTC (US overlap, highest volume)
  [0, 2],     // 00:00-02:00 UTC (Asian session open)
];
export const OFF_PEAK_RISK_MULT = 1.0;  // V17b: geen risicoverlaging buiten peak (was 0.85)

// ── Session Filter (V27: UIT — bot mist 16h/dag in 24/7 markt) ──
// V16 had window 8-16 UTC voor "winstgevende sessie" maar in alt season
// is Asian session (00-08 UTC) juist hoogvolume voor SOL/AVAX/DOGE.
// Met 24/7 trading + regime filter al actief, is sessie-restrictie pure verlies.
export const SESSION_FILTER_ENABLED = false;
export const SESSION_ALLOWED_START  = 0;
export const SESSION_ALLOWED_END    = 24;

// ── Cooldowns (V16: verkort van 30/15 min) ────────────────────
export const COOLDOWN_SL_MIN   = 3;   // V17b: sneller re-entry (was 10 min)
export const COOLDOWN_TIME_MIN = 1;   // V17b: sneller re-entry (was 5 min)

// ── Dynamic Risk Scaling (consecutive loss streak) ────────────
export const STREAK_MULT = {
  0: 1.00,    // No consecutive losses → normal
  1: 0.95,    // V17b: -5% (was -10%)
  2: 0.85,    // V17b: -15% (was -25%)
  3: 0.70,    // V17b: -30% (was -50%)
  4: 0.50,    // V17b: -50% (was -70%)
};
export const DYNAMIC_RISK = STREAK_MULT; // backward compat

// ── Crypto Assets ──────────────────────────────────────────────
// V25: per-asset diag (90d cache) toonde 5 verlies-assets aan.
// Disabled: BTCUSDT, ETHUSDT, ADAUSDT, XRPUSDT, LINKUSD
// Reason:  per-asset PnL was negatief in alle 5 (cumulatief -$9.89 over 90d).
// Alleen AVAXUSD, SOLUSDT, DOGEUSD overgehouden — winners-only set
// scoort +5.81% / PF 0.95 / WR 50% in backtest (vs full set -3.94% / PF 0.44).
//
// Ongebruikte definities behouden in commentaar zodat we ze later zonder
// herontwerp kunnen reactiveren als het marktregime keert.
//
// /* DISABLED V25 — verlies-assets
//   { id: 'BTCUSDT', symbol: 'BTCUSDT', krakenSymbol: 'BTC/USD', krakenPair: 'XBTUSD',
//     category: MODE, vol: 0.008, drift: 0.00032, slM: 2.8, tpM: 5.2,
//     minQty: 0.00001, qtyStep: 0.00001, pricePrecision: 2,
//     color: '#f7931a', corrGroup: 'HIGH', regimeATR: 0.06 },
//   { id: 'ETHUSDT', symbol: 'ETHUSDT', krakenSymbol: 'ETH/USD', krakenPair: 'ETHUSD',
//     category: MODE, vol: 0.010, drift: 0.00040, slM: 2.8, tpM: 5.2,
//     minQty: 0.001, qtyStep: 0.001, pricePrecision: 2,
//     color: '#627eea', corrGroup: 'HIGH', regimeATR: 0.07 },
// */
export const ASSETS = [
  {
    id: 'SOLUSDT',
    symbol: 'SOLUSDT',
    krakenSymbol: 'SOL/USD',
    krakenPair:   'SOLUSD',
    category: MODE,
    vol: 0.015,
    drift: 0.00040,
    slM: 2.6,    // V20: wijder SL (mid cap)
    tpM: 4.8,    // V25: revert tpM (was 5.3)
    minQty: 0.01,
    qtyStep: 0.01,
    pricePrecision: 2,
    color: '#9945ff',
    corrGroup: 'MED',
    regimeATR: 0.08,
  },
  // V27: XRPUSDT teruggezet — market-scan toont bull regime, +5.25% 7d
  // (V25-disable was gebaseerd op 90d backtest; recent regime is anders)
  {
    id: 'XRPUSDT',
    symbol: 'XRPUSDT',
    krakenSymbol: 'XRP/USD',
    krakenPair:   'XRPUSD',
    category: MODE,
    vol: 0.012,
    drift: 0.00035,
    slM: 2.6,
    tpM: 4.8,
    minQty: 1,
    qtyStep: 1,
    pricePrecision: 5,
    color: '#23292f',
    corrGroup: 'LOW',
    regimeATR: 0.07,
  },
  // V25 DISABLED — ADAUSDT/LINKUSD nog steeds bearish in market-scan
  // /* { id: 'ADAUSDT', krakenSymbol: 'ADA/USD', krakenPair: 'ADAUSD', vol:0.014, slM:2.6, tpM:4.8, corrGroup:'SPEC' } */
  // /* { id: 'LINKUSD', krakenSymbol: 'LINK/USD', krakenPair: 'LINKUSD', vol:0.020, slM:2.3, tpM:4.2, corrGroup:'ALT2' } */
  {
    id: 'AVAXUSD',
    symbol: 'AVAXUSD',
    krakenSymbol: 'AVAX/USD',
    krakenPair:   'AVAXUSD',
    category: MODE,
    vol: 0.022,
    drift: 0.00045,
    slM: 2.3,    // V20: wijder SL voor alts
    tpM: 4.2,    // V25: revert tpM (was 4.7)
    minQty: 0.01,
    qtyStep: 0.01,
    pricePrecision: 2,
    color: '#e84142',
    corrGroup: 'ALT3',
    regimeATR: 0.09,
  },
  {
    id: 'DOGEUSD',
    symbol: 'DOGEUSD',
    krakenSymbol: 'DOGE/USD',
    krakenPair:   'XDGUSD',
    category: MODE,
    vol: 0.018,
    drift: 0.00035,
    slM: 2.3,    // V20: wijder SL voor alts
    tpM: 4.2,    // V25: revert tpM (was 4.7)
    minQty: 10,
    qtyStep: 1,
    pricePrecision: 5,
    color: '#c3a634',
    corrGroup: 'ALT4',
    regimeATR: 0.09,
  },
  // V18: ATOM, LTC, NEAR, UNI, AAVE, POL, FIL, ARB verwijderd
  // Reden: illiquide op Kraken, hoge spreads vreten fees bij $197 kapitaal
  // ── Top 8 liquid assets (focus op kwaliteit bij klein kapitaal) ──
];

// ── Correlation Groups (V25: 3 actieve assets) ────────────────
// Active: SOLUSDT (MED), AVAXUSD (ALT3), DOGEUSD (ALT4)
// Disabled groups (HIGH/LOW/SPEC/ALT2) blijven gedefinieerd zodat
// reactivering van assets geen rules-breakage geeft.
export const CORRELATION_RULES = {
  HIGH:  { maxSimultaneous: 1 },  // disabled (BTC/ETH)
  MED:   { maxSimultaneous: 1 },  // SOL
  LOW:   { maxSimultaneous: 1 },  // disabled (XRP)
  SPEC:  { maxSimultaneous: 1 },  // disabled (ADA)
  ALT2:  { maxSimultaneous: 1 },  // disabled (LINK)
  ALT3:  { maxSimultaneous: 1 },  // AVAX
  ALT4:  { maxSimultaneous: 1 },  // DOGE
};

// ── Server ─────────────────────────────────────────────────────
export const SERVER_PORT    = Number(process.env.PORT) || 3001;
export const WS_PORT        = 3001;  // Same server, upgraded connection
export const FRONTEND_PORT  = 5173;

// ── Growth Mode ────────────────────────────────────────────────
// GROWTH_MODE=true activates aggressive sizing, compounding, and wider limits
export const GROWTH_MODE = process.env.GROWTH_MODE === 'true';

// V31 AGGRESSIVE: Kelly-based sizing — half-Kelly bij 49%WR / 1.5:1 R:R
export const GROWTH_CONF_RISK = {
  3: 0.030,   // V31: 3.0% (was 2.0%)
  4: 0.050,   // V31: 5.0% (was 4.0%)
  5: 0.080,   // V31: 8.0% (was 6.0%)
  6: 0.100,   // V31: 10% (was 7.5%) — full conviction op 6/6 setup
};
export const GROWTH_MAX_RISK_PER_TRADE = 0.10;  // V31: 10% max single trade (was 7.5%)

// Faster exits, more trades
export const GROWTH_TRAIL_R   = 1.5;    // V40: align met V40 TRAIL_R (was 1.25)
export const GROWTH_MAX_BARS  = 144;    // V31: 12h op 5m (was 10h) — geef trends meer ruimte
export const GROWTH_MIN_RR    = 1.3;    // V31: 1.3 (was 1.5)

// V31 AGGRESSIVE: ruimere CBs in growth mode
export const GROWTH_DAILY_LOSS_LIMIT_1  = 0.080;  // V31: was 0.060
export const GROWTH_DAILY_LOSS_LIMIT_2  = 0.140;  // V31: was 0.100
export const GROWTH_WEEKLY_LOSS_LIMIT_1 = 0.120;  // V31: was 0.100
export const GROWTH_WEEKLY_LOSS_LIMIT_2 = 0.220;  // V31: was 0.180
export const GROWTH_KILL_SWITCH_PCT     = 0.30;   // V31: was 0.25

// Relaxed correlation in growth mode (BTC+ETH samen toegestaan bij groter kapitaal)
export const GROWTH_CORRELATION_RULES = {
  ...CORRELATION_RULES,
  HIGH: { maxSimultaneous: 2 },  // BTC+ETH samen (alleen bij groter kapitaal)
};

// ── Volume Threshold ──────────────────────────────────────────
export const VR_THRESHOLD = 1.05;  // V17b: minder streng volume filter (was 1.10)

// ── Fee Structure (Bybit Spot) ─────────────────────────────────
export const FEE_RATE = Number(process.env.FEE_RATE) || 0.0016; // 0.16% Kraken taker fee
