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
// Legacy Bybit keys (kept for reference)
export const BYBIT_API_KEY    = process.env.BYBIT_API_KEY || '';
export const BYBIT_API_SECRET = process.env.BYBIT_API_SECRET || '';
export const BYBIT_TESTNET    = process.env.BYBIT_TESTNET !== 'false';
export const BYBIT_BASE_URL   = process.env.BYBIT_BASE_URL || '';
export const MODE             = process.env.MODE || 'spot';

// ── Capital & Position ─────────────────────────────────────────
export const CAPITAL    = Number(process.env.CAPITAL) || 100;
export const MAX_POS    = 5;          // Max concurrent positions — verhoog mee als kapitaal groeit
export const MAX_DEPLOY = 0.80;       // Never deploy >80% of capital

// ── Signal Requirements ────────────────────────────────────────
export const MIN_CONF   = 4;          // Min 4 of 6 factors confirmed (hogere kwaliteit)
export const MIN_RR     = 2.0;        // Min risk/reward ratio

// ── Exit Mechanics (V12 Edge + Double Partial) ─────────────────
export const PARTIAL1_R   = 0.5;      // First partial at +0.5R
export const PARTIAL1_PCT = 0.25;     // Sell 25% of position (let 75% ride)
export const PARTIAL2_R   = 1.0;      // Second partial at +1.0R
export const PARTIAL2_PCT = 0.25;     // Sell 25% of remaining (18.75% original) — 56% runner
export const TRAIL_R      = 1.2;      // Start trailing at +1.2R (faster for crypto)
export const TRAIL_ATR    = 1.5;      // Trailing stop = ATR × 1.5 (slightly wider, more room)
export const MAX_BARS     = 80;       // Max hold time (bars) — 6.7h, let winners run with BE-SL

// ── Risk Management ────────────────────────────────────────────
export const DAILY_LOSS_LIMIT_1  = 0.025;  // 2.5% → reduce risk 50% (3 positions × 1.6% = 4.8% max)
export const DAILY_LOSS_LIMIT_2  = 0.040;  // 4.0% → stop 24h
export const WEEKLY_LOSS_LIMIT_1 = 0.050;  // 5.0% → reduce size 50%
export const WEEKLY_LOSS_LIMIT_2 = 0.080;  // 8.0% → stop entire week
export const KILL_SWITCH_PCT     = 0.09;   // 9% drawdown → full stop (snel beschermen)
export const LOSS_LIMIT          = 4;      // Consecutive losses → pause asset
export const PAUSE_MINUTES       = 60;     // Pause duration after consecutive losses
export const TOTAL_LOSS_LIMIT    = 6;      // 6 losses across all → pause all
export const TOTAL_PAUSE_MINUTES = 90;     // Pause all duration
export const MAX_RISK_PER_TRADE  = 0.025;  // 2.5% max risk per single trade

// ── Confidence-Based Risk Sizing ───────────────────────────────
export const CONF_RISK = {
  3: 0.006,   // 0.6% risk at 3/6 (minimum confluence — small size)
  4: 0.010,   // 1.0% risk at 4/6 confidence
  5: 0.016,   // 1.6% risk at 5/6
  6: 0.024,   // 2.4% risk at 6/6 (full confidence — only on perfect setups)
};

// ── Regime Filter ──────────────────────────────────────────────
export const SLOPE_BARS = 10;         // EMA50 slope lookback (10h consistent trend required)
export const ADX_MIN    = 20;         // Min ADX — only strong trends, no chop

// ── Timeframe ──────────────────────────────────────────────────
export const CANDLE_INTERVAL    = '5';    // 5-minute candles for entries
export const REGIME_INTERVAL    = '60';   // 1-hour candles for regime filter
export const HISTORY_BARS       = 150;    // Rolling buffer size
export const VWAP_WINDOW        = 72;     // 6h rolling VWAP (crypto institutional cycles)

// ── Peak Hours (UTC) ───────────────────────────────────────────
export const PEAK_HOURS = [
  [13, 17],   // 13:00-17:00 UTC (US overlap, highest volume)
  [0, 2],     // 00:00-02:00 UTC (Asian session open)
];
export const OFF_PEAK_RISK_MULT = 0.85; // 85% risk during off-peak (crypto is 24/7)

// ── Dynamic Risk Scaling ───────────────────────────────────────
export const DYNAMIC_RISK = {
  5: 1.15,    // 4-5 wins out of last 5 → +15%
  4: 1.15,
  3: 1.00,    // 3 wins → normal
  2: 0.85,    // 2 wins → -15%
  1: 0.70,    // 1 win → -30%
  0: 0.50,    // 0 wins → -50% (capital preservation)
};

// ── Crypto Assets ──────────────────────────────────────────────
export const ASSETS = [
  {
    id: 'BTCUSDT',
    symbol: 'BTCUSDT',          // Sim symbol
    krakenSymbol: 'BTC/USD',    // Kraken WebSocket symbol
    krakenPair:   'XBTUSD',     // Kraken REST pair
    category: MODE,
    vol: 0.008,
    drift: 0.00032,
    slM: 1.8,
    tpM: 4.8,
    minQty: 0.00001,
    qtyStep: 0.00001,
    pricePrecision: 2,
    color: '#f7931a',
    corrGroup: 'HIGH',
    regimeATR: 0.06,
  },
  {
    id: 'ETHUSDT',
    symbol: 'ETHUSDT',
    krakenSymbol: 'ETH/USD',
    krakenPair:   'ETHUSD',
    category: MODE,
    vol: 0.010,
    drift: 0.00040,
    slM: 1.5,
    tpM: 4.2,
    minQty: 0.001,
    qtyStep: 0.001,
    pricePrecision: 2,
    color: '#627eea',
    corrGroup: 'HIGH',
    regimeATR: 0.07,
  },
  {
    id: 'SOLUSDT',
    symbol: 'SOLUSDT',
    krakenSymbol: 'SOL/USD',
    krakenPair:   'SOLUSD',
    category: MODE,
    vol: 0.015,
    drift: 0.00040,
    slM: 1.7,
    tpM: 4.5,
    minQty: 0.01,
    qtyStep: 0.01,
    pricePrecision: 2,
    color: '#9945ff',
    corrGroup: 'MED',
    regimeATR: 0.08,
  },
  {
    id: 'XRPUSDT',
    symbol: 'XRPUSDT',
    krakenSymbol: 'XRP/USD',
    krakenPair:   'XRPUSD',
    category: MODE,
    vol: 0.012,
    drift: 0.00035,
    slM: 1.5,
    tpM: 4.0,
    minQty: 1,
    qtyStep: 0.1,
    pricePrecision: 4,
    color: '#00aae4',
    corrGroup: 'LOW',
    regimeATR: 0.08,
  },
  {
    id: 'ADAUSDT',
    symbol: 'ADAUSDT',
    krakenSymbol: 'ADA/USD',
    krakenPair:   'ADAUSD',
    category: MODE,
    vol: 0.014,
    drift: 0.00038,
    slM: 1.5,
    tpM: 3.4,
    minQty: 1,
    qtyStep: 0.1,
    pricePrecision: 4,
    color: '#0033ad',
    corrGroup: 'SPEC',
    regimeATR: 0.08,
  },
  {
    id: 'DOTUSD',
    symbol: 'DOTUSD',
    krakenSymbol: 'DOT/USD',
    krakenPair:   'DOTUSD',
    category: MODE,
    vol: 0.018,
    drift: 0.00038,
    slM: 1.6,
    tpM: 4.0,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#e6007a',
    corrGroup: 'ALT1',
    regimeATR: 0.09,
  },
  {
    id: 'LINKUSD',
    symbol: 'LINKUSD',
    krakenSymbol: 'LINK/USD',
    krakenPair:   'LINKUSD',
    category: MODE,
    vol: 0.020,
    drift: 0.00042,
    slM: 1.6,
    tpM: 4.2,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#2a5ada',
    corrGroup: 'ALT2',
    regimeATR: 0.09,
  },
  {
    id: 'AVAXUSD',
    symbol: 'AVAXUSD',
    krakenSymbol: 'AVAX/USD',
    krakenPair:   'AVAXUSD',
    category: MODE,
    vol: 0.022,
    drift: 0.00045,
    slM: 1.7,
    tpM: 4.5,
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
    slM: 1.5,
    tpM: 4.0,
    minQty: 10,
    qtyStep: 1,
    pricePrecision: 5,
    color: '#c3a634',
    corrGroup: 'ALT4',
    regimeATR: 0.09,
  },
  {
    id: 'ATOMUSD',
    symbol: 'ATOMUSD',
    krakenSymbol: 'ATOM/USD',
    krakenPair:   'ATOMUSD',
    category: MODE,
    vol: 0.018,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.2,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#2e3148',
    corrGroup: 'ALT5',
    regimeATR: 0.09,
  },
  {
    id: 'LTCUSD',
    symbol: 'LTCUSD',
    krakenSymbol: 'LTC/USD',
    krakenPair:   'XLTCUSD',
    category: MODE,
    vol: 0.012,
    drift: 0.00035,
    slM: 1.5,
    tpM: 4.0,
    minQty: 0.01,
    qtyStep: 0.01,
    pricePrecision: 2,
    color: '#bfbbbb',
    corrGroup: 'ALT6',
    regimeATR: 0.08,
  },
  {
    id: 'NEARUSD',
    symbol: 'NEARUSD',
    krakenSymbol: 'NEAR/USD',
    krakenPair:   'NEARUSD',
    category: MODE,
    vol: 0.020,
    drift: 0.00042,
    slM: 1.6,
    tpM: 4.2,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#00ec97',
    corrGroup: 'ALT7',
    regimeATR: 0.09,
  },
  // ── Top 12 liquid assets ────────────────────────────────────
];

// ── Correlation Groups ─────────────────────────────────────────
// BTC+ETH = HIGH correlation (0.85) → never hold both
// SOL = MED correlation with BTC (0.75)
// XRP = LOW correlation with BTC (0.60)
// ADA = SPEC correlation (~0.60)
// DOT/LINK/AVAX/DOGE/ATOM/LTC/NEAR = ALT groups (independent slots)
export const CORRELATION_RULES = {
  HIGH:  { maxSimultaneous: 1 },  // BTC or ETH
  MED:   { maxSimultaneous: 1 },  // SOL
  LOW:   { maxSimultaneous: 1 },  // XRP
  SPEC:  { maxSimultaneous: 1 },  // ADA
  ALT1:  { maxSimultaneous: 1 },  // DOT
  ALT2:  { maxSimultaneous: 1 },  // LINK
  ALT3:  { maxSimultaneous: 1 },  // AVAX
  ALT4:  { maxSimultaneous: 1 },  // DOGE
  ALT5:  { maxSimultaneous: 1 },  // ATOM
  ALT6:  { maxSimultaneous: 1 },  // LTC
  ALT7:  { maxSimultaneous: 1 },  // NEAR
};

// ── Server ─────────────────────────────────────────────────────
export const SERVER_PORT    = Number(process.env.PORT) || 3001;
export const WS_PORT        = 3001;  // Same server, upgraded connection
export const FRONTEND_PORT  = 5173;

// ── Fee Structure (Bybit Spot) ─────────────────────────────────
export const FEE_RATE = Number(process.env.FEE_RATE) || 0.0016; // 0.16% Kraken taker fee
