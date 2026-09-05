# Cycle Tide

A weighted, explainable read on where Bitcoin sits relative to prior cycles.

**Not a price prediction.** It answers a narrower question: do current conditions
historically resemble accumulation zones or distribution zones? Every input is
shown, weighted, and sourced — and when the model can't see enough, it says so
instead of guessing.

## The score

Ten signals combine into a 0–100 composite. Higher = historically
accumulation-favourable.

| Signal | Weight | Category | Source |
|---|---|---|---|
| Drawdown from ATH | 15 | Price | self-computed |
| MVRV Z-Score | 15 | On-chain | bitcoin-data.com |
| Net Unrealized Profit/Loss | 12 | On-chain | bitcoin-data.com |
| 200-Week MA Multiple | 10 | Price | self-computed |
| Stablecoin Supply Ratio | 10 | Liquidity | DefiLlama |
| Fear & Greed Index | 10 | Sentiment | Alternative.me |
| Puell Multiple | 8 | On-chain | bitcoin-data.com |
| Pi Cycle Top | 8 | Price | self-computed |
| Perp Funding Rate | 7 | Leverage | Binance |
| Monthly RSI (14) | 5 | Price | self-computed |

Click any signal in the dashboard to see what it tracks, why it's predictive,
its threshold bands, and — importantly — its caveats.

## Honest limitations

- **Three complete cycles** is a very small sample to generalise from.
- **The ETF era (2024+) changed market structure.** Indicators calibrated on
  prior cycles may not behave the same way; Pi Cycle in particular has not
  re-triggered since.
- **Peak magnitudes decay every cycle** (+57,400% → +13,133% → +2,126% → +712%),
  so any forward price band is guesswork, not a forecast.
- **The forward projection is schedule-based**, drawn through the average
  halving→top→bottom offsets of past cycles. It is not a model output and
  knows nothing about current conditions.
- **On-chain history starts ~2022** on the free tier, and Binance price data
  starts Aug 2017 — so the 200W MA can't be computed before mid-2021.

When fewer than 55% of the model's weight is available, or any whole category
goes dark, the dashboard shows **NO CALL** rather than a confident-looking
number derived from whichever signals happened to load.

## Running locally

Any static file server works — there is no build step:

```bash
python3 -m http.server 8791
# then open http://localhost:8791
```

## Keeping data fresh

The on-chain provider's free tier allows **10 requests per hour per IP**, which a
few page loads exhausts. To keep the dashboard working regardless, on-chain
history ships as a snapshot in `data/onchain.json`; the live API is only a
top-up merged over it.

Refresh the snapshot periodically (daily is plenty — these metrics update once
a day):

```bash
node scripts/snapshot-onchain.mjs
```

## Data sources

All free, no API keys required:

- [bitcoin-data.com](https://bitcoin-data.com) — MVRV Z-Score, NUPL, Puell Multiple
- [DefiLlama](https://defillama.com) — stablecoin supply
- [Alternative.me](https://alternative.me/crypto/fear-and-greed-index/) — Fear & Greed Index
- [Binance](https://binance.com) — price history, live price stream, funding rates

## Licence / disclaimer

Educational tool. Not financial advice. Do your own research.
