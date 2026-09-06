# Cycle Tide

A weighted, explainable read on where Bitcoin sits relative to prior cycles.

**Not a price prediction.** It answers a narrower question: do current conditions
historically resemble accumulation zones or distribution zones? Every input is
shown, weighted, and sourced — and when the model can't see enough, it says so
instead of guessing.

## The score

Eleven signals combine into a 0–100 composite. Higher = historically
accumulation-favourable.

| Signal | Weight | Category | Source |
|---|---|---|---|
| Drawdown from ATH | 13 | Price | self-computed |
| MVRV Z-Score | 12 | On-chain | bitcoin-data.com |
| 200-Week MA Multiple | 10 | Price | self-computed |
| US Spot ETF Net Flow (30d) | 10 | Institutional | TFTC (CC BY 4.0) |
| Fear & Greed Index | 10 | Sentiment | Alternative.me |
| Stablecoin Supply Ratio | 9 | Liquidity | DefiLlama |
| Net Unrealized Profit/Loss | 8 | On-chain | bitcoin-data.com |
| Puell Multiple | 8 | On-chain | bitcoin-data.com |
| Pi Cycle Top | 8 | Price | self-computed |
| Perp Funding Rate | 7 | Leverage | Binance |
| Monthly RSI (14) | 5 | Price | self-computed |

Click any signal in the dashboard to see what it tracks, why it's predictive,
its threshold bands, and — importantly — its caveats.

## Treasury company tabs

Two additional tabs cover **Strategy (MSTR)** and **Strive (ASST)** — Bitcoin
treasury companies. They deliberately show **no 0–100 score**: eight of the
eleven signals are Bitcoin-network data (MVRV, NUPL, Puell, ETF flows, Pi
Cycle) that does not exist for an equity, and renormalising the rest would
produce a confident-looking number measuring something it cannot see.

Instead they show what is directly measurable: price and drawdown, BTC held
and cost basis, performance against BTC over matched windows, and **mNAV** —
market cap ÷ the value of the Bitcoin held. Below 1.0× means the market values
the company at less than its Bitcoin alone.

mNAV uses diluted share counts from SEC EDGAR, which are quarterly. These
companies issue stock frequently to buy Bitcoin, so the figure lags recent
issuance and is indicative rather than exact between filings.

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
- **ETF flow data starts Jan 2024** (the funds did not exist before), covering
  a single cycle. There is no prior-cycle precedent to validate it against.

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
node scripts/snapshot-onchain.mjs     # MVRV, NUPL, Puell
node scripts/snapshot-etf.mjs         # US spot ETF net flows
node scripts/snapshot-treasuries.mjs  # MSTR/ASST prices, holdings, share counts
```

`snapshot-etf.mjs` backfills the full history from TFTC and, if a
`SOSOVALUE_API_KEY` is present in an untracked `.env.local`, tops up the most
recent days from SoSoValue. The key is never committed and is not needed —
TFTC alone is sufficient.

## Data sources

All free, no API keys required:

- [bitcoin-data.com](https://bitcoin-data.com) — MVRV Z-Score, NUPL, Puell Multiple
- [DefiLlama](https://defillama.com) — stablecoin supply
- [Alternative.me](https://alternative.me/crypto/fear-and-greed-index/) — Fear & Greed Index
- [Binance](https://binance.com) — price history, live price stream, funding rates
- [TFTC](https://www.tftc.io/bitcoin-etf-flows) — US spot BTC ETF daily net flows
  (CC BY 4.0; TFTC compiles these from SoSoValue and Farside Investors)
- [CoinGecko](https://www.coingecko.com) — public-company BTC treasury holdings
- [SEC EDGAR](https://www.sec.gov/edgar) — diluted shares outstanding (XBRL)
- Yahoo Finance — MSTR/ASST daily prices (fetched server-side; the endpoint
  sends no CORS headers, so a browser cannot call it directly)

## Licence / disclaimer

Educational tool. Not financial advice. Do your own research.
