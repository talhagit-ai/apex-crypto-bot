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
export const MIN_CONF   = 3;          // Min 3 of 6 factors confirmed
export const MIN_RR     = 1.8;        // Min risk/reward ratio

// ── Exit Mechanics (V12 Edge + Double Partial) ─────────────────
export const PARTIAL1_R   = 0.5;      // First partial at +0.5R
export const PARTIAL1_PCT = 0.25;     // Sell 25% of position (let 75% ride)
export const PARTIAL2_R   = 1.0;      // Second partial at +1.0R
export const PARTIAL2_PCT = 0.25;     // Sell 25% of remaining (18.75% original) — 56% runner
export const TRAIL_R      = 1.2;      // Start trailing at +1.2R (faster for crypto)
export const TRAIL_ATR    = 1.5;      // Trailing stop = ATR × 1.5 (slightly wider, more room)
export const MAX_BARS     = 40;       // Max hold time (bars) — extended for runners

// ── Risk Management ────────────────────────────────────────────
export const DAILY_LOSS_LIMIT_1  = 0.025;  // 2.5% → reduce risk 50% (3 positions × 1.6% = 4.8% max)
export const DAILY_LOSS_LIMIT_2  = 0.040;  // 4.0% → stop 24h
export const WEEKLY_LOSS_LIMIT_1 = 0.050;  // 5.0% → reduce size 50%
export const WEEKLY_LOSS_LIMIT_2 = 0.080;  // 8.0% → stop entire week
export const KILL_SWITCH_PCT     = 0.12;   // 12% drawdown → full stop
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
export const SLOPE_BARS = 3;          // EMA50 slope lookback
export const ADX_MIN    = 8;          // Min ADX for trending market (crypto trends show lower ADX due to noise)

// ── Timeframe ──────────────────────────────────────────────────
export const CANDLE_INTERVAL    = '5';    // 5-minute candles for entries
export const REGIME_INTERVAL    = '60';   // 1-hour candles for regime filter
export const HISTORY_BARS       = 150;    // Rolling buffer size
export const VWAP_WINDOW        = 120;    // 10h rolling VWAP (fits in 150-bar buffer)

// ── Peak Hours (UTC) ───────────────────────────────────────────
export const PEAK_HOURS = [
  [13, 17],   // 13:00-17:00 UTC (US overlap, highest volume)
  [0, 2],     // 00:00-02:00 UTC (Asian session open)
];
export const OFF_PEAK_RISK_MULT = 0.60; // 60% risk during off-peak hours

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
    krakenSymbol: 'BTC/EUR',    // Kraken WebSocket symbol
    krakenPair:   'XBTEUR',     // Kraken REST pair
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
    krakenSymbol: 'ETH/EUR',
    krakenPair:   'ETHEUR',
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
    krakenSymbol: 'SOL/EUR',
    krakenPair:   'SOLEUR',
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
    krakenSymbol: 'XRP/EUR',
    krakenPair:   'XRPEUR',
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
    krakenSymbol: 'ADA/EUR',
    krakenPair:   'ADAEUR',
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
    krakenSymbol: 'DOT/EUR',
    krakenPair:   'DOTEUR',
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
    krakenSymbol: 'LINK/EUR',
    krakenPair:   'LINKEUR',
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
    krakenSymbol: 'AVAX/EUR',
    krakenPair:   'AVAXEUR',
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
    id: 'ATOMUSD',
    symbol: 'ATOMUSD',
    krakenSymbol: 'ATOM/EUR',
    krakenPair:   'ATOMEUR',
    category: MODE,
    vol: 0.016,
    drift: 0.00038,
    slM: 1.5,
    tpM: 3.8,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#6f4e37',
    corrGroup: 'ALT4',
    regimeATR: 0.09,
  },
  {
    id: 'UNIUSD',
    symbol: 'UNIUSD',
    krakenSymbol: 'UNI/EUR',
    krakenPair:   'UNIEUR',
    category: MODE,
    vol: 0.022,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#ff007a',
    corrGroup: 'ALT5',
    regimeATR: 0.10,
  },
  {
    id: 'LTCUSD',
    symbol: 'LTCUSD',
    krakenSymbol: 'LTC/EUR',
    krakenPair:   'LTCEUR',
    category: MODE,
    vol: 0.012,
    drift: 0.00030,
    slM: 1.5,
    tpM: 3.8,
    minQty: 0.01,
    qtyStep: 0.01,
    pricePrecision: 2,
    color: '#bfbbbb',
    corrGroup: 'ALT6',
    regimeATR: 0.08,
  },
  {
    id: 'POLUSD',
    symbol: 'POLUSD',
    krakenSymbol: 'POL/EUR',
    krakenPair:   'POLEUR',
    category: MODE,
    vol: 0.020,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 1,
    qtyStep: 1,
    pricePrecision: 4,
    color: '#8247e5',
    corrGroup: 'ALT7',
    regimeATR: 0.10,
  },
  {
    id: 'DOGEUSD',
    symbol: 'DOGEUSD',
    krakenSymbol: 'DOGE/EUR',
    krakenPair:   'XDGEUR',
    category: MODE,
    vol: 0.025,
    drift: 0.00035,
    slM: 1.6,
    tpM: 4.0,
    minQty: 10,
    qtyStep: 1,
    pricePrecision: 5,
    color: '#c3a634',
    corrGroup: 'ALT8',
    regimeATR: 0.12,
  },
  {
    id: 'ALGOUSD',
    symbol: 'ALGOUSD',
    krakenSymbol: 'ALGO/EUR',
    krakenPair:   'ALGOEUR',
    category: MODE,
    vol: 0.018,
    drift: 0.00035,
    slM: 1.5,
    tpM: 3.8,
    minQty: 1,
    qtyStep: 1,
    pricePrecision: 4,
    color: '#00b4d8',
    corrGroup: 'ALT9',
    regimeATR: 0.10,
  },
  {
    id: 'NEARUSD',
    symbol: 'NEARUSD',
    krakenSymbol: 'NEAR/EUR',
    krakenPair:   'NEAREUR',
    category: MODE,
    vol: 0.022,
    drift: 0.00042,
    slM: 1.6,
    tpM: 4.2,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#00ec97',
    corrGroup: 'ALT10',
    regimeATR: 0.10,
  },
  {
    id: 'FILUSD',
    symbol: 'FILUSD',
    krakenSymbol: 'FIL/EUR',
    krakenPair:   'FILEUR',
    category: MODE,
    vol: 0.022,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#0090ff',
    corrGroup: 'ALT11',
    regimeATR: 0.10,
  },
  {
    id: 'AAVEUSD',
    symbol: 'AAVEUSD',
    krakenSymbol: 'AAVE/EUR',
    krakenPair:   'AAVEEUR',
    category: MODE,
    vol: 0.022,
    drift: 0.00042,
    slM: 1.6,
    tpM: 4.2,
    minQty: 0.01,
    qtyStep: 0.01,
    pricePrecision: 2,
    color: '#b6509e',
    corrGroup: 'ALT12',
    regimeATR: 0.10,
  },
  {
    id: 'GRTUSD',
    symbol: 'GRTUSD',
    krakenSymbol: 'GRT/EUR',
    krakenPair:   'GRTEUR',
    category: MODE,
    vol: 0.025,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 1,
    qtyStep: 1,
    pricePrecision: 4,
    color: '#6747ed',
    corrGroup: 'ALT13',
    regimeATR: 0.11,
  },
  {
    id: 'SNXUSD',
    symbol: 'SNXUSD',
    krakenSymbol: 'SNX/EUR',
    krakenPair:   'SNXEUR',
    category: MODE,
    vol: 0.025,
    drift: 0.00042,
    slM: 1.6,
    tpM: 4.0,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#00d1ff',
    corrGroup: 'ALT14',
    regimeATR: 0.11,
  },
  {
    id: 'CRVUSD',
    symbol: 'CRVUSD',
    krakenSymbol: 'CRV/EUR',
    krakenPair:   'CRVEUR',
    category: MODE,
    vol: 0.025,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 1,
    qtyStep: 1,
    pricePrecision: 4,
    color: '#ff0000',
    corrGroup: 'ALT15',
    regimeATR: 0.11,
  },
  {
    id: 'COMPUSD',
    symbol: 'COMPUSD',
    krakenSymbol: 'COMP/EUR',
    krakenPair:   'COMPEUR',
    category: MODE,
    vol: 0.022,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 0.01,
    qtyStep: 0.01,
    pricePrecision: 2,
    color: '#00d395',
    corrGroup: 'ALT16',
    regimeATR: 0.11,
  },
  {
    id: 'ENJUSD',
    symbol: 'ENJUSD',
    krakenSymbol: 'ENJ/EUR',
    krakenPair:   'ENJEUR',
    category: MODE,
    vol: 0.025,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 1,
    qtyStep: 1,
    pricePrecision: 4,
    color: '#624dbf',
    corrGroup: 'ALT17',
    regimeATR: 0.11,
  },
  {
    id: 'FLOWUSD',
    symbol: 'FLOWUSD',
    krakenSymbol: 'FLOW/EUR',
    krakenPair:   'FLOWEUR',
    category: MODE,
    vol: 0.022,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#00ef8b',
    corrGroup: 'ALT18',
    regimeATR: 0.10,
  },
  {
    id: 'KSMUSD',
    symbol: 'KSMUSD',
    krakenSymbol: 'KSM/EUR',
    krakenPair:   'KSMEUR',
    category: MODE,
    vol: 0.022,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 0.01,
    qtyStep: 0.01,
    pricePrecision: 2,
    color: '#000000',
    corrGroup: 'ALT19',
    regimeATR: 0.10,
  },
  {
    id: 'SANDUSD',
    symbol: 'SANDUSD',
    krakenSymbol: 'SAND/EUR',
    krakenPair:   'SANDEUR',
    category: MODE,
    vol: 0.028,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 1,
    qtyStep: 1,
    pricePrecision: 4,
    color: '#04adef',
    corrGroup: 'ALT20',
    regimeATR: 0.12,
  },
  {
    id: 'MANAUSD',
    symbol: 'MANAUSD',
    krakenSymbol: 'MANA/EUR',
    krakenPair:   'MANAEUR',
    category: MODE,
    vol: 0.028,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 1,
    qtyStep: 1,
    pricePrecision: 4,
    color: '#ff2d55',
    corrGroup: 'ALT21',
    regimeATR: 0.12,
  },
  {
    id: 'AXSUSD',
    symbol: 'AXSUSD',
    krakenSymbol: 'AXS/EUR',
    krakenPair:   'AXSEUR',
    category: MODE,
    vol: 0.028,
    drift: 0.00042,
    slM: 1.7,
    tpM: 4.2,
    minQty: 0.1,
    qtyStep: 0.1,
    pricePrecision: 3,
    color: '#00b4d8',
    corrGroup: 'ALT22',
    regimeATR: 0.12,
  },
  {
    id: '1INCHUSD',
    symbol: '1INCHUSD',
    krakenSymbol: '1INCH/EUR',
    krakenPair:   '1INCHEUR',
    category: MODE,
    vol: 0.025,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 1,
    qtyStep: 1,
    pricePrecision: 4,
    color: '#d82122',
    corrGroup: 'ALT23',
    regimeATR: 0.11,
  },
  {
    id: 'OCEANUSD',
    symbol: 'OCEANUSD',
    krakenSymbol: 'OCEAN/EUR',
    krakenPair:   'OCEANEUR',
    category: MODE,
    vol: 0.025,
    drift: 0.00040,
    slM: 1.6,
    tpM: 4.0,
    minQty: 1,
    qtyStep: 1,
    pricePrecision: 4,
    color: '#ff4081',
    corrGroup: 'ALT24',
    regimeATR: 0.11,
  },
];

// ── Correlation Groups ─────────────────────────────────────────
// BTC+ETH = HIGH correlation (0.85) → never hold both
// SOL = MED correlation with BTC (0.75)
// XRP = LOW correlation with BTC (0.60)
// ADA = SPEC correlation (~0.60)
// DOT/LINK/AVAX/ATOM/UNI/LTC/MATIC = ALT groups (independent slots)
export const CORRELATION_RULES = {
  HIGH:  { maxSimultaneous: 1 },  // BTC or ETH (never both)
  MED:   { maxSimultaneous: 1 },  // SOL
  LOW:   { maxSimultaneous: 1 },  // XRP
  SPEC:  { maxSimultaneous: 1 },  // ADA
  ALT1:  { maxSimultaneous: 1 },  // DOT
  ALT2:  { maxSimultaneous: 1 },  // LINK
  ALT3:  { maxSimultaneous: 1 },  // AVAX
  ALT4:  { maxSimultaneous: 1 },  // ATOM
  ALT5:  { maxSimultaneous: 1 },  // UNI
  ALT6:  { maxSimultaneous: 1 },  // LTC
  ALT7:  { maxSimultaneous: 1 },  // MATIC
  ALT8:  { maxSimultaneous: 1 },  // DOGE
  ALT9:  { maxSimultaneous: 1 },  // ALGO
  ALT10: { maxSimultaneous: 1 },  // NEAR
  ALT11: { maxSimultaneous: 1 },  // FIL
  ALT12: { maxSimultaneous: 1 },  // AAVE
  ALT13: { maxSimultaneous: 1 },  // GRT
  ALT14: { maxSimultaneous: 1 },  // SNX
  ALT15: { maxSimultaneous: 1 },  // CRV
  ALT16: { maxSimultaneous: 1 },  // COMP
  ALT17: { maxSimultaneous: 1 },  // ENJ
  ALT18: { maxSimultaneous: 1 },  // FLOW
  ALT19: { maxSimultaneous: 1 },  // KSM
  ALT20: { maxSimultaneous: 1 },  // SAND
  ALT21: { maxSimultaneous: 1 },  // MANA
  ALT22: { maxSimultaneous: 1 },  // AXS
  ALT23: { maxSimultaneous: 1 },  // 1INCH
  ALT24: { maxSimultaneous: 1 },  // OCEAN
};

// ── Server ─────────────────────────────────────────────────────
export const SERVER_PORT    = Number(process.env.PORT) || 3001;
export const WS_PORT        = 3001;  // Same server, upgraded connection
export const FRONTEND_PORT  = 5173;

// ── Fee Structure (Bybit Spot) ─────────────────────────────────
export const FEE_RATE = Number(process.env.FEE_RATE) || 0.0016; // 0.16% Kraken taker fee
