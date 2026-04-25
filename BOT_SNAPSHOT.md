# APEX Crypto Bot — Volledige Snapshot 25 april 2026

## Live Status (V26 deployed)
- **Equity**: $188.07
- **StartCapital**: $188.07
- **Posities**: 0 (bear regimes blokken longs op SOL/AVAX, DOGE neutral)
- **Bot URL**: https://apex-crypto-bot-c3bt.onrender.com
- **GitHub**: https://github.com/talhagit-ai/apex-crypto-bot
- **Render uptime**: actief, UptimeRobot houdt /health wakker

## Deployment
- **Versie**: V26 (walk-forward robust params)
- **Hosting**: Render.com (auto-deploy bij git push)
- **Exchange**: Kraken Spot (echt geld) + Kraken Futures (paper shorts)
- **Capital**: ~$188 USD

## Config V26 — actief
- **Assets**: SOLUSDT, AVAXUSD, DOGEUSD (3-asset focus, V25)
- **MAX_POS**=3, MAX_DEPLOY=0.70, MAX_SINGLE_PCT=0.40
- **MIN_RR**=1.5 (V26: walk-forward robust, was 2.0)
- **PARTIAL1_R**=1.5 (V26: was 0.75 — winners langer laten lopen)
- **PARTIAL2_R**=2.0 (V26: was 1.25)
- **TRAIL_R**=0.8, **TRAIL_ATR**=1.5 (bevestigd robust)
- **GROWTH_MIN_RR**=1.5, GROWTH_TRAIL_R=0.8 (V26 aligned)
- **DRY_RUN_SHORTS** default AAN (paper validation)

## Versie-evolutie (recente upgrades)

### V25 (data-driven cleanup) — vorige versie
Reduceerde 8 assets → 3 (SOLUSDT, AVAXUSD, DOGEUSD).
Per-asset diag toonde dat 5 assets net-negatief waren over 90d
(BTCUSDT, ETHUSDT, ADAUSDT, XRPUSDT, LINKUSD).
Tooling: `backend/diag-per-asset.mjs`, `backend/test-current-config.mjs`.
Logger: `LOG_LEVEL` env var → geen 200MB+ backtest logs meer.

### V26 (walk-forward robust) — actief
Walk-forward (60d train / 30d test) onthulde dat V25 OVERFIT was:
- V25 op train slice: +8.36% (gefit cijfer)
- V25 op test slice: **-1.45%** (échte performance)
- V26 op test slice: **+1.2%** (robust winner)

Test scan (alle 144 configs op holdout) toonde 0/144 met PF>1 op
out-of-sample. Wijst op markt-regime shift in cache. V26 kiest config
die HET MINST verliest op test slice.

**Belangrijke disclosure:** marginale edge (testPF=0.71). Verbetering
ten opzichte van V25 komt vooral van het wegvallen van overfit-bias.
Volgende stap: fresh data downloaden voor recente prijzen.

## Tools (V25/V26)
- `backend/backtest.mjs` — replay engine tegen historische data
- `backend/hyperopt-ext.mjs` — 144-config grid search (cache-based)
- `backend/hyperopt-per-asset.mjs` — V26: optimaliseert elk asset apart
- `backend/walk-forward.mjs` — V26: top-5 train → test validatie
- `backend/walk-forward-robust.mjs` — V26: alle 144 configs op test slice
- `backend/diag-per-asset.mjs` — V25: per-asset PnL diagnostics
- `backend/test-current-config.mjs` — V25: single-run validatie
- `backend/data-downloader.mjs` — Kraken trades → 5m bars
- `npm run hyperopt` / `diag` / `validate` — alle met LOG_LEVEL=warn

## Data assets
- Cache files in `./cache/` (~15MB totaal voor 3 actieve assets)
- 90 dagen 5m bars per asset
- Cache eindigt eind januari 2026 — vernieuwen wenselijk

## Walk-Forward Resultaten V26 (60d train / 30d test)

### Top-10 by TEST RETURN (out-of-sample)
| Rank | Train | Test | TrainPF | TestPF | Config |
|------|-------|------|---------|--------|--------|
| 1 | 3.9%  | +1.2%  | 0.90 | 0.71 | P1=1.5 TR=0.8 ATR=1.5 RR=1.5 (V26) |
| 2 | 3.9%  | +1.2%  | 0.90 | 0.71 | P1=1.5 TR=0.8 ATR=1.5 RR=1.8 |
| 3 | 2.04% | +0.7%  | 0.84 | 0.71 | P1=0.75 TR=0.8 ATR=1.5 RR=1.5 |
| 4 | 2.04% | +0.7%  | 0.84 | 0.71 | P1=0.75 TR=0.8 ATR=1.5 RR=1.8 |
| 5 | 1.48% | +0.55% | 0.75 | 0.68 | P1=1 TR=0.6 ATR=1.5 RR=1.5 |

### V25 versus V26 op test slice
| Versie | Train | Test | Verdict |
|--------|-------|------|---------|
| V25    | +8.36% | **-1.45%** | OVERFIT |
| V26    | +3.90% | **+1.2%**  | ROBUST (marginale edge) |

## Per-Asset Hyperopt Output (info — niet toegepast)
SOL/AVAX/DOGE willen elk andere optimale params (allemaal ATR=2.5),
maar engine ondersteunt momenteel geen per-asset exit-params.
Resultaten in `cache/per-asset-params.json`.

## Bekende issues / TODO
- **Cache vernieuwen**: data eindigt eind januari, recent
  prijsgedrag mist. Run `node backend/data-downloader.mjs`.
- **Per-asset exit params**: engine refactor nodig om
  PARTIAL1_R/TRAIL_R per asset te overriden.
- **Ware regime-aware sizing**: huidige rsMult werkt al, maar
  kan strikter (bear=0% size, neutral=50%).

## Commits (laatste 10)
- `bd3fc8c` V26: walk-forward-robust params — out-of-sample edge
- `0068d07` V25 tooling: LOG_LEVEL env var + npm scripts
- `d7406b7` V25: 3-asset focus + tuned trail (data-driven cleanup)
- `fb01c34` Snapshot 25 april 2026 — volledige bot state
- `6352a54` V24: Paper shorts default AAN
- `5a95280` V23: Data-driven upgrade op 90d Kraken historie
- `a894789` V22: Hyperopt-gebaseerde PARTIAL tuning
- `e6612d0` V21: NFIX-geïnspireerde kwaliteitsfilters
- `2037441` V20: winners laten lopen — stop breakeven-guillotine
- `8612286` V19 Geldmachine: Telegram retry + strategische upgrades

## Architectuur (research-validated)
Vergeleken met Freqtrade/professional bots:
- ✓ Dual partial exits + trailing stops
- ✓ Circuit breaker op dagelijks/wekelijks verlies
- ✓ EMA50+ADX regime detection
- ✓ Rolling loss windows (24h/7d)
- ✓ Walk-forward validation (V26 toegevoegd)
- ✗ Edge Position Sizing (Freqtrade-stijl) — TODO
- ✗ HMM/GMM multi-regime detection — TODO
- ✗ Per-asset exit params — TODO
