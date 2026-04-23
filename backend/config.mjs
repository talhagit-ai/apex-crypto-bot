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
export const MAX_POS    = 3;          // V18: minder posities = focus op kwaliteit bij klein kapitaal (was 5)
export const MAX_DEPLOY = 0.70;       // V18: 30% cash reserve (was 0.92 — te weinig buffer bij $197)
export const MAX_SINGLE_PCT = 0.40;   // V17b: max 40% kapitaal per positie (voorkomt ADA/micro-ATR concentratie)
export const MIN_ORDER_USD  = 10;     // Kraken minimum notional per order (~$10) — orders daaronder worden geweigerd

// ── Signal Requirements ────────────────────────────────────────
export const MIN_CONF   = 4;          // V13: conf=4 is 67% kwaliteit (was 5 — te streng, miste goede setups)
export const MIN_RR     = 2.0;        // V23: hyperopt bewijst 2.0 > 1.8 consistent (top 10 allemaal 2.0)

// ── Exit Mechanics (V12 Edge + Double Partial) ─────────────────
export const PARTIAL1_R   = 0.75;     // V23: hyperopt 90d winner (+8.15% return, PF 1.14)
export const PARTIAL1_PCT = 0.25;     // V20: kleinere partial, meer runner
export const PARTIAL2_R   = 1.25;     // V23: hyperopt 90d winner
export const PARTIAL2_PCT = 0.25;     // V20: behoudt 50% als runner
export const TRAIL_R      = 1.0;      // V20/V23: trail start na +1R — bevestigd in hyperopt
export const TRAIL_ATR    = 2.0;      // V20/V23: ATR 2.0 — bevestigd in hyperopt
export const MAX_BARS     = 96;       // V17: 8h (was 72=6h) — met 5m-ATR TP heeft prijs meer tijd nodig

// ── Risk Management ────────────────────────────────────────────
export const DAILY_LOSS_LIMIT_1  = 0.060;  // V16: 6% → reduce risk 50% (was 4% — 2 trades triggerde al met €200)
export const DAILY_LOSS_LIMIT_2  = 0.100;  // V16: 10% → stop 24h (was 6% — te krap voor crypto)
export const WEEKLY_LOSS_LIMIT_1 = 0.080;  // V16: 8% → reduce size 50% (was 5%)
export const WEEKLY_LOSS_LIMIT_2 = 0.150;  // V16: 15% → stop entire week (was 8%)
export const KILL_SWITCH_PCT     = 0.20;   // V16: 20% drawdown → full stop (was 12%)
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
export const SLOPE_BARS = 5;          // EMA50 slope lookback (5h instead of 10h — faster regime detection)
export const ADX_MIN    = 15;         // V17b: zwakkere trends accepteren (was 19)

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

// ── Session Filter (V16: alleen traden tijdens winstgevende sessie) ──
export const SESSION_FILTER_ENABLED = true;
export const SESSION_ALLOWED_START  = 8;   // 08:00 UTC (10:00 NL)
export const SESSION_ALLOWED_END    = 16;  // 16:00 UTC (18:00 NL)

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
export const ASSETS = [
  {
    id: 'BTCUSDT',
    symbol: 'BTCUSDT',          // Sim symbol
    krakenSymbol: 'BTC/USD',    // Kraken WebSocket symbol
    krakenPair:   'XBTUSD',     // Kraken REST pair
    category: MODE,
    vol: 0.008,
    drift: 0.00032,
    slM: 2.8,    // V20: wijder SL (buiten 5m ruis)
    tpM: 5.7,    // V23: R:R=2.04 (hyperopt winner)
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
    slM: 2.8,    // V20: wijder SL (buiten 5m ruis)
    tpM: 5.7,    // V23: R:R=2.04
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
    slM: 2.6,    // V20: wijder SL (mid cap)
    tpM: 5.3,    // V23: R:R=2.04
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
    slM: 2.6,    // V20: wijder SL (mid cap)
    tpM: 5.3,    // V23: R:R=2.04
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
    slM: 2.6,    // V20: wijder SL (mid cap)
    tpM: 5.3,    // V23: R:R=2.04
    minQty: 1,
    qtyStep: 0.1,
    pricePrecision: 4,
    color: '#0033ad',
    corrGroup: 'SPEC',
    regimeATR: 0.08,
  },
  // V18: DOT verwijderd (illiquide, hoge spread bij klein kapitaal)
  {
    id: 'LINKUSD',
    symbol: 'LINKUSD',
    krakenSymbol: 'LINK/USD',
    krakenPair:   'LINKUSD',
    category: MODE,
    vol: 0.020,
    drift: 0.00042,
    slM: 2.3,    // V20: wijder SL voor alts
    tpM: 4.7,    // V23: R:R=2.04
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
    slM: 2.3,    // V20: wijder SL voor alts
    tpM: 4.7,    // V23: R:R=2.04
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
    tpM: 4.7,    // V23: R:R=2.04
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

// ── Correlation Groups (V18: 8 assets) ────────────────────────
// BTC+ETH = HIGH correlation → max 1 tegelijk bij klein kapitaal
// Met MAX_POS=3: je wilt spreiding, niet 2 van dezelfde groep
export const CORRELATION_RULES = {
  HIGH:  { maxSimultaneous: 1 },  // V18: BTC OF ETH, niet beide (was 2 — te duur bij $197)
  MED:   { maxSimultaneous: 1 },  // SOL
  LOW:   { maxSimultaneous: 1 },  // XRP
  SPEC:  { maxSimultaneous: 1 },  // ADA
  ALT2:  { maxSimultaneous: 1 },  // LINK
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

// Kelly-based sizing (quarter-Kelly at 49%WR / 3:1 R:R)
export const GROWTH_CONF_RISK = {
  3: 0.020,   // V13: 2.0% (was 1.5%)
  4: 0.040,   // V13: 4.0% (was 3.0%) — primaire entry level
  5: 0.060,   // V13: 6.0% (was 5.0%)
  6: 0.075,   // V13: 7.5% (was 6.5%) — full Kelly bij perfecte setup
};
export const GROWTH_MAX_RISK_PER_TRADE = 0.075;  // V13: was 0.065

// Faster exits, more trades
export const GROWTH_TRAIL_R   = 1.0;    // V20: trail pas na +1R (was 0.5 — chokete winners)
export const GROWTH_MAX_BARS  = 120;    // V17: 10h op 5m candles (was 60=5h — te kort voor 5m ATR TP)
export const GROWTH_MIN_RR    = 2.0;    // V23: hyperopt winner — stricter pays off

// Wider circuit breakers
export const GROWTH_DAILY_LOSS_LIMIT_1  = 0.060;  // V16: was 0.040
export const GROWTH_DAILY_LOSS_LIMIT_2  = 0.100;  // V16: was 0.060
export const GROWTH_WEEKLY_LOSS_LIMIT_1 = 0.100;  // V16: was 0.080
export const GROWTH_WEEKLY_LOSS_LIMIT_2 = 0.180;  // V16: was 0.120
export const GROWTH_KILL_SWITCH_PCT     = 0.250;  // V16: was 0.150

// Relaxed correlation in growth mode (BTC+ETH samen toegestaan bij groter kapitaal)
export const GROWTH_CORRELATION_RULES = {
  ...CORRELATION_RULES,
  HIGH: { maxSimultaneous: 2 },  // BTC+ETH samen (alleen bij groter kapitaal)
};

// ── Volume Threshold ──────────────────────────────────────────
export const VR_THRESHOLD = 1.05;  // V17b: minder streng volume filter (was 1.10)

// ── Fee Structure (Bybit Spot) ─────────────────────────────────
export const FEE_RATE = Number(process.env.FEE_RATE) || 0.0016; // 0.16% Kraken taker fee
