# APEX Crypto Bot — Volledige Snapshot 25 april 2026

## Live Status (huidige sessie)
- **Equity**: $188.07
- **StartCapital**: $188.63 (start V23 deploy)
- **PnL sessie**: -$0.56 (-0.30%)
- **Trades**: 2 (1W/1L = 50% wr, PF 0.14)
- **Posities**: 0
- **Bot URL**: https://apex-crypto-bot-c3bt.onrender.com
- **GitHub**: https://github.com/talhagit-ai/apex-crypto-bot

## Deployment
- **Versie**: V24 (paper shorts default)
- **Hosting**: Render.com (auto-deploy bij git push)
- **Exchange**: Kraken Spot (echt geld) + Kraken Futures (paper shorts)
- **Capital**: ~$188 USD

## Config samenvatting (V23 + V24)
- 8 assets: BTC, ETH, SOL, XRP, ADA, LINK, AVAX, DOGE
- MAX_POS=3, MAX_DEPLOY=0.70, MAX_SINGLE_PCT=0.40
- MIN_RR=2.0, GROWTH_MIN_RR=2.0
- PARTIAL1_R=0.75, PARTIAL2_R=1.25
- TRAIL_R=1.0, TRAIL_ATR=2.0
- DRY_RUN_SHORTS default AAN (paper validation)

## Data assets
- 8 cache files in ./cache/ (~15MB totaal)
- 181,693 × 5m bars over 87-90 dagen
- 10.25 miljoen Kraken trades verwerkt

## Tools
- backend/backtest.mjs — replay engine tegen historische data
- backend/hyperopt.mjs — grid search 144 configs
- backend/hyperopt-ext.mjs — extended versie met cache
- backend/hyperopt-v2.mjs — fine-grain partial PCT search
- backend/data-downloader.mjs — Kraken trades → 5m bars

## Bekende issues / TODO
- **HYPEROPT-V2 ramp**: alle 162 configs negatief (-5.92% best). Reden:
  V23 bumped asset tpM zodat alle signals R:R 2.04+ haalden. MIN_RR=2.0 werd
  daardoor nutteloos als quality filter. Nodig: revert asset tpM naar V20
  (BTC tpM 5.7→5.2, mid 5.3→4.8, alts 4.7→4.2) terwijl MIN_RR=2.0 blijft.
  Dan filtert MIN_RR alleen breakout-bonus signals door.

## Commits historie (laatste 10)
6352a54 V24: Paper shorts default AAN — bot trade ook in bear markets
5a95280 V23: Data-driven upgrade op basis van 90d Kraken historie
a894789 V22: Hyperopt-gebaseerde PARTIAL tuning (+17% PF)
e6612d0 V21: NFIX-geïnspireerde kwaliteitsfilters (Freqtrade research)
2037441 V20: winners laten lopen — stop de breakeven-guillotine
8612286 V19 Geldmachine: Telegram retry + strategische upgrades
972db81 V19: Hard R:R 1.8 + Kelly sizing + startCapital bugfix
eb5a0e5 fix: startCapital correct na buffer init + cash overshoot bij qty-gecapte SELL
9dc59cf fix: reconcile qty sync + SELL/partial qty capping tegen Insufficient funds
9acb29a fix: spotCash || → ?? om false-positive fallback bij 0 cash te voorkomen

## Hyperopt resultaten (TOP 5 alle runs)

### Hyperopt v1 (90d, 144 configs) — winnaar V23
| Rank | Return | Trades | Win% | PF | Config |
|------|--------|--------|------|-----|--------|
| 1 | 8.15% | 109 | 51.4% | 1.14 | P1=0.75 TR=1 ATR=2 RR=2 |
| 2 | 7.88% | 108 | 52.8% | 1.13 | P1=1.25 TR=1 ATR=2 RR=2 |
| 3 | 7.72% | 111 | 54.1% | 1.14 | P1=0.75 TR=1 ATR=1.5 RR=2 |
| 4 | 7.66% | 108 | 47.2% | 1.09 | P1=0.75 TR=1.5 ATR=1.5 RR=2 |
| 5 | 6.99% | 106 | 49.1% | 1.08 | P1=1 TR=1 ATR=2.5 RR=2 |

### Hyperopt v2 (162 configs, alles negatief — bug bewijs)
| Rank | Return | Trades | Win% | PF | Sharpe | Config |
|------|--------|--------|------|-----|--------|--------|
| 1 | -5.92% | 55 | 30.9% | 0.24 | -3.8 | P1=0.75 P1%=0.25 P2%=0.33 ATR=1.5 |
| 2 | -5.95% | 55 | 30.9% | 0.23 | -3.8 | P1=0.75 P1%=0.33 P2%=0.25 ATR=1.5 |
| 3 | -5.96% | 55 | 30.9% | 0.21 | -4.02 | P1=0.75 P1%=0.33 P2%=0.33 ATR=1.5 |
| 4 | -5.97% | 55 | 30.9% | 0.25 | -3.7 | P1=0.75 P1%=0.33 P2%=0.2 ATR=1.5 |
| 5 | -6.05% | 63 | 27% | 0.22 | -4.06 | P1=0.5 P1%=0.33 P2%=0.25 ATR=2 |
