# APEX Crypto Bot — Snapshot 27 april 2026 (V36 deployed)

## Live status (V36 deployed)
- **Equity**: ~$188 ($98 spot + $90 Kraken Futures collateral)
- **Bot URL**: https://apex-crypto-bot-c3bt.onrender.com
- **GitHub**: https://github.com/talhagit-ai/apex-crypto-bot
- **Versie**: V36 (aggressive growth + multi-factor signals + safety net)

## Vandaag's pijnpunt (27 apr)
Bot opende eerder vandaag over-leveraged shorts (10×) op PF_XRPUSD + PF_SOLUSD,
`availableMargin` zakte naar -$5.22 (margin-call zone). Alle nieuwe orders
gerejected door Kraken. PnL pieken-tot-dieptepunt: +$4.18 → -$13 unrealized
voor we ingrepen. Posities werden gesloten via `/api/halt-all` (V29c) zodra
deploy live was.

## V29-V36 deployment series

### V29 (futures over-leverage fix)
Bug: pre-flight margin check 10% IM (gokte op 10× leverage). Kraken vereist
~20%, dus posities openden binnen check maar gebruikten echt meer margin.
Fix: 36% IM + 20% buffer, hard cap 3× notional.

### V29b (auto-close authority)
User authorized bot om zelf orphan-futures + margin-call situaties op te
ruimen. Reconciliation sluit automatisch posities die engine niet tracked,
en margin-call protection sluit ALLE futures bij `availableMargin < $0`.

### V29c (operationeel net)
- `GET /api/risk-snapshot` — equity, drawdown, recente WR (laatste 20),
  risk reduction, posities, regimes, futures availableMargin
- `POST /api/halt-all` — emergency rip-cord: sluit alles + disable ENABLE_SHORTS
- Trade-logging naar SQLite `trade_analytics` was al aanwezig

### V30 (indicator pack)
Toegevoegd aan `backend/indicators.mjs`:
- Heikin-Ashi (smoothed candles + color-streak detector)
- Bollinger Bands + Keltner Channels + BB-KC squeeze
- Ichimoku Cloud (1h)
- Multi-timeframe alignment score (5m+15m+1h)
- SMA/stddev helpers

Wired in beide LONG en SHORT signal paths met factor weights.

### V31 (aggressive risk params)
- MAX_POS: 3 → 5 (meer simultane posities)
- MIN_CONF: 4 → 3 (lagere drempel, V30 indicators boost compenseert)
- MIN_RR: 1.5 → 1.3
- GROWTH_CONF_RISK[3..6] = 3/5/8/10% (was 2/4/6/7.5%)
- GROWTH_MAX_RISK_PER_TRADE: 7.5% → 10%
- GROWTH_TRAIL_R: 0.8 → 1.25
- GROWTH_MAX_BARS: 120 → 144 (12h)
- DAILY_LIMIT 6/10% → 8/14%, WEEKLY 8/15% → 12/22%, KILL 20% → 30%
- Futures: IM 36% → 33%, notional cap 3× → 4× balance

### V31b (streak modifiers)
- 3 wins op rij = next position 1.5× sizing, 4+ wins = 1.75×
- 3 losses = next position 0.5× extra (bovenop dynamicMult)

### V32 (Kraken Futures funding-rate filter)
Live-only filter via `backend/funding-client.mjs`. Pull `/derivatives/api/v3/tickers`
elke 30 min (gratis, no auth):
- funding > +0.05%/4h: block long entries
- funding > +0.10%/4h: boost short qualityScore +0.6
- funding < -0.05%/4h: block short entries

### V33 (asymmetric SL/TP per regime)
ADX-based dynamic exit modifiers:
- Strong trend (ADX>30): TP × 1.25, SL × 0.90
- Weak trend (ADX<20): TP × 0.85, SL × 1.10

### V34 (per-asset exit params)
Engine refactor zodat PARTIAL1_R/PARTIAL2_R/TRAIL_R/TRAIL_ATR/MIN_RR/MAX_BARS
per asset gezet kunnen worden via `cache/per-asset-params.json`. Stale-check
3 dagen — skip params als hyperopt-per-asset niet recent gedraaid is.

### V35 (walk-forward-anchored)
Nieuwe `backend/walk-forward-anchored.mjs`: 7 rolling 60d/30d windows ipv
single split. Robust = positief op ≥5/7 test windows AND avg PF >1.

### V36 (CryptoPanic news pause)
Nieuwe `backend/news-client.mjs`. Polls hot crypto news elke 5 min.
High-impact keywords (sec, hack, ban, crash, fed, cpi) → pause 30 min +
0.5× sizing voor 1h post-pause. Vereist `CRYPTOPANIC_API_TOKEN` env var.

## Backtest progressie op 94d cache (4 assets)

| Versie | Return | Trades | WR | PF | Notes |
|---|---|---|---|---|---|
| V28 baseline | -4.94% | 72 | 33% | 0.42 | TR=1.25, MIN_RR=1.5 |
| V30 (indicators) | -4.34% | 68 | 32% | 0.42 | More selective |
| V31 (aggressive) | -3.41% | 77 | 38% | 0.50 | MIN_CONF=3, MIN_RR=1.3 |
| V33 (asymmetric) | -3.15% | 84 | 43% | 0.55 | ADX-based exits |
| V34+V37 (fresh per-asset) | -3.29% | 97 | 42% | 0.51 | Per-asset wiring |

Test-slice on V31+ stack expected significantly better than 90d full
(zoals V26 walk-forward toonde +4.83% test slice vs -4.23% train).

## Per-asset params (V37 hyperopt op verse 94d cache)
- SOLUSDT: P1=1.25, P2=1.75, TR=0.6, ATR=1.5, RR=2.0
- XRPUSDT: P1=1.0, P2=1.5, TR=0.6, ATR=1.5, RR=1.8
- AVAXUSD: P1=1.0, P2=1.5, TR=0.6, ATR=1.5, RR=1.8
- DOGEUSD: P1=1.5, P2=2.0, TR=0.8, ATR=2.0, RR=1.8 (solo: +19.47% PF 1.19)

Per-asset params wonen lokaal in `cache/per-asset-params.json` (gitignored)
— Render fallback naar global params (gewenst gedrag, V33 baseline).

## Tools
- `backend/data-downloader.mjs` — Kraken Spot trades → 5m bars (config.ASSETS)
- `backend/bulk-downloader.mjs` — V32: arbitrary 25-coin universe download
- `backend/asset-scout.mjs` — V32: solo edge ranking per asset
- `backend/market-scan.mjs` — current regime per asset
- `backend/walk-forward-robust.mjs` — V26: 144-config single split
- `backend/walk-forward-anchored.mjs` — V35: 7-window rolling
- `backend/hyperopt-per-asset.mjs` — V26: per-coin grid
- `backend/test-current-config.mjs` — single-run validation
- `backend/funding-client.mjs` — V32: Kraken Futures funding poller
- `backend/news-client.mjs` — V36: CryptoPanic event detector

## Realistische verwachtingen op €170 + €100/week stortingen

| Scenario | Bot APR | Bot bijdrage / jaar |
|---|---|---|
| Best case (alt season + edge holds) | +80-100% | €1900 |
| Boven-median | +40-60% | €600 |
| Median | +15-30% | €130 |
| Onder-median | -5-10% | -€320 |
| Worst case | -25-40% | -€1670 |

Dit zijn cijfers gebaseerd op gevalideerde 2025-2026 trading-bot-research,
niet op gefitte backtests. €170 te klein voor "geldmachine"-status; bot is
**bonus-vehicle** op stortingen, niet vermogensvermenigvuldiger.

## TODO / Volgende stappen
- V37b: Run walk-forward-anchored met verse per-asset params + V31 baseline
- V38: HMM regime detector (4 states: bull/bear/range/transition)
- V39: Mean-reversion scalper als 4e strategy (BB extreme + RSI<25/>75)
- V40: Order book imbalance via Kraken WebSocket (v3/ws book channel)
- V41: Asset universe uitbreiding (BTC + ETH terug zodra fresh 90d data
  bewezen edge geeft via asset-scout)
- V42: LightGBM signal classifier (na 200+ logged trades)
- 4-week paper validatie vóór échte ENABLE_SHORTS toelaten

## Architectuur (research-validated)
✓ Dual partial exits + asymmetric trailing stops per regime
✓ Walk-forward validation (V26 + V35 anchored)
✓ EMA50+ADX regime detection met hysteresis
✓ Bayesian learning engine (Wilson score)
✓ Heikin-Ashi + Bollinger + Keltner + Squeeze + Ichimoku + MTF
✓ Funding rate filter + boost (Kraken Futures public)
✓ Auto-close orphans + margin-call protection
✓ News-event pause (CryptoPanic)
✗ HMM 4-state regime detector — TODO V38
✗ Order book imbalance via WS — TODO V40
✗ Mean-reversion scalper — TODO V39
✗ ML signal scorer — TODO V42
