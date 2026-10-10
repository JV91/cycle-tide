# Cycle Tide

A weighted, explainable read on where Bitcoin sits relative to prior cycles.

**Not a price prediction.** It answers a narrower question: do current conditions
historically resemble accumulation zones or distribution zones? Every input is
shown, weighted, and sourced — and when the model can't see enough, it says so
instead of guessing.

## The score

Seven signals combine into a 0–100 composite. Higher = historically
accumulation-favourable.

| Signal | Weight | Category | Source |
|---|---|---|---|
| Drawdown from ATH | 20 | Price | self-computed |
| Fear & Greed Index | 16 | Sentiment | Alternative.me |
| 200-Week MA Multiple (4-year rank) | 15 | Price | self-computed |
| US Spot ETF Net Flow (30d) | 15 | Institutional | TFTC (CC BY 4.0) |
| Stablecoin Supply Ratio | 14 | Liquidity | DefiLlama |
| Net Unrealized Profit/Loss | 12 | On-chain | bitcoin-data.com |
| Monthly RSI (14) | 8 | Price | self-computed |

What the composite read at each cycle turning point (lows should be high,
tops low):

| 2018 bottom | 2020 low | 2021 tops | 2022 bottom | 2025 top | 2026 low |
|---|---|---|---|---|---|
| 95 | 91 | 19 / 26 | 95 | 17 | 86 |

Readings before 2022 use only the signals whose data reaches back that far
(58–73% of the weight).

**Four signals were removed on 2026-10-10** — MVRV Z-Score, Puell Multiple,
Pi Cycle Top and the perp funding rate. Scored at every turning point their
data covers, they no longer separated tops from bottoms: funding read 61–65 at
every turning point since 2022, Pi Cycle read 78 at both the 2021 and 2025
tops, Puell ranged only 81–100, and MVRV Z read 64 at the 2025 top while
duplicating NUPL (0.95 correlation). With them the model read 41 at the 2025
all-time high; without them, 24. The remaining weights are the old ones
rescaled to 100, not re-tuned — four lows and three tops is no basis for
fitting weights.

**The 200-week MA multiple is ranked, not scored on a fixed scale.** It used
to run from 1× (buy) to 4× (sell), a scale set by older cycles: the multiple
peaked at 3.79× in 2021 but only 2.33× in 2025, so it read 56 at the 2025
all-time high. It is now ranked against its own last four years, which read 10
at that top and reached the warning zone 138 days earlier with 14% of the rise
left. The cost: slightly less sharp at the 2021 tops, 82 rather than 100 at the
2026 low, and tested on only three tops. Drawdown from ATH was tested the same
way and left fixed — ranking it made returns after its "top" readings higher
than after its "bottom" readings.

Five of the seven overlap heavily (drawdown, NUPL, 200-week
MA, RSI), so read this as about five independent ideas, not seven.

### The four-year cycle clock (shown, not scored)

Under the score, a small timeline shows where the viewed date sits in the
halving cycle, against the days on which earlier cycles topped and bottomed.
It is calendar-only and **does not feed the score**.

Calibrated on three cycles and checked on the fourth, a days-since-halving
clock placed every held-out top at 12–21 and every held-out bottom at 72–100
on a 0–100 scale. It is still kept out of the score: four cycles is all the
evidence there is, it would sit at 100 for about 40% of every cycle, it cannot
react if the cycle breaks, and this cycle has already run early and shallower
(low on day 803 at −54%, against days 777–924 at −77% to −86%). The windows it
draws come from the other cycles, never the one being viewed.

Click any signal in the dashboard to see what it tracks, why it's predictive,
its threshold bands, and — importantly — its caveats.

## Monthly allocation

A card at the top answers one operational question: where does this month's
contribution go? A fixed slice to spot Bitcoin, and the treasury slice to
whichever of MSTR/ASST trades at the **bigger discount to the Bitcoin it
holds** — or to spot if neither is below 0.95x mNAV.

The rule targets the mechanism that has actually produced returns in these
names. Strive returned +115% in one recent window, but roughly 62% of that was
its mNAV re-rating from 0.59x to 1.01x — a gain collected by whoever bought at
the discount, not available to someone buying after it closed.

Backtested monthly over Strive's treasury era (Oct 2025 - Aug 2026), 2k/month:
pick-cheaper **+76%**, fixed 50/50 split **+42%**, always-MSTR **-2%**. It also
correctly refused Strive while it traded at 9-16x mNAV in late 2025. Caveat
stated in the UI: eleven months across one partial cycle is a thin sample, and
with hindsight always-ASST scored higher (+85%) — the rule rests on its
mechanism, not that backtest.

Amounts live in `ALLOC_PLAN` at the top of `js/allocation.js`.

## Treasury company tabs

Two additional tabs cover **Strategy (MSTR)** and **Strive (ASST)** — Bitcoin
treasury companies. They deliberately show **no 0–100 score**: most of the
signals are Bitcoin-market data (NUPL, ETF flows, Fear & Greed, stablecoin
supply) that does not exist for an equity, and renormalising the rest would
produce a confident-looking number measuring something it cannot see.

Instead they show what is directly measurable: price and drawdown, BTC held
and cost basis, performance against BTC over matched windows, and **mNAV** —
market cap ÷ the value of the Bitcoin held. Below 1.0× means the market values
the company at less than its Bitcoin alone.

Each treasury tab carries a **valuation read** — a 0-100 score with an
ACCUMULATE / HOLD / DISTRIBUTE call. Unlike the Bitcoin tab, a valuation call
is possible here because these companies have a fair-value anchor: the Bitcoin
on their balance sheet. It weighs mNAV (55), treasury position vs cost (25),
and whether the equity has actually beaten holding Bitcoin (20).

**It is not a view on Bitcoin.** A company can read cheap against its own
coins while Bitcoin itself sits at a cycle top; the two tabs answer different
questions. The thresholds are reasoned judgements about the economics, not
levels fitted to data — only current BTC holdings are available, so mNAV
cannot be percentile-ranked against each company's own history the way the
Bitcoin signals are. If mNAV is unavailable the read shows NO CALL rather
than scoring on the minor factors alone.

Each treasury tab also projects **Bitcoin backing per share** — deliberately
not a share-price forecast. A price projection would stack three guesses on
the Bitcoin band (future mNAV, dilution, holdings), and mNAV alone swings the
answer ~2.9x. Instead it separates the knowable from the unknowable:

- **Backing per share** = BTC held x BTC price / shares. Pure arithmetic.
- **After dilution** at a rate you set. MSTR has issued ~40%/yr; at that rate
  a near-3x rise in Bitcoin barely moves the backing per share.
- **Beta-implied**, a second independent estimate from how the stock has
  actually amplified Bitcoin moves (MSTR beta 1.27, corr 0.74; ASST 1.69,
  corr 0.55 over only ~250 days).

The two estimates disagree by design — beta contains past dilution and premium
swings, the arithmetic contains neither. The gap is the market's changing
willingness to pay a premium, not an error in either.

Every metric carries the same expandable explainer as the BTC signals — what
it tracks, why it matters, how to read it, **how it works with the other
metrics**, and its caveat. That interaction field is the important one here:
mNAV, BTC per share and cost basis only mean something in combination. A
premium lets a company issue shares accretively; at a discount the same
issuance destroys BTC per share and the flywheel stops turning.

Where a company tags its Bitcoin holdings in SEC XBRL
(`us-gaap:CryptoAssetNumberOfUnits`), a **historical mNAV range** is
reconstructed from official filings — holdings x BTC price at each quarter end
against the share count filed at the time. For MSTR that gives six observations
spanning 0.60x–1.33x, which is enough to check that the scoring thresholds
bracket what has actually occurred. It is deliberately shown as a range, not a
percentile: six points is far too few to rank against. Strive does not tag
holdings at all, so its card says so rather than showing nothing.

mNAV uses diluted share counts from SEC EDGAR, which are quarterly. These
companies issue stock frequently to buy Bitcoin, so the figure lags recent
issuance and is indicative rather than exact between filings.

## Honest limitations

- **Three complete cycles** is a very small sample to generalise from.
- **The ETF era (2024+) changed market structure.** Indicators calibrated on
  prior cycles may not behave the same way — four were removed for exactly
  this reason (see above).
- **Peak magnitudes decay every cycle** (+57,400% → +13,133% → +2,126% → +712%),
  so any forward price band is guesswork, not a forecast.
- **The forward projection is schedule-based**, drawn through the average
  halving→top→bottom offsets of past cycles. It is not a model output and
  knows nothing about current conditions.
- **On-chain history starts ~2022** on the free tier, and Binance price data
  starts Aug 2017 — so the 200W MA can't be computed before mid-2021.
- **ETF flow data starts Jan 2024** (the funds did not exist before), covering
  a single cycle. There is no prior-cycle precedent to validate it against.

When fewer than 70% of the model's weight is available, or any whole category
goes dark, the dashboard shows **NO CALL** rather than a confident-looking
number derived from whichever signals happened to load.

## Running locally

Any static file server works — there is no build step:

```bash
python3 -m http.server 8791
# then open http://localhost:8791
```

## Automation

`.github/workflows/daily.yml` runs after the US close each day: refreshes all
three snapshots, recomputes the score headlessly, commits any changed data, and
emails **only when the score crosses a band edge** — a daily "still ACCUMULATE"
message would just train you to ignore it.

`scripts/check-alerts.mjs` loads the scoring logic from the app's own source
files rather than reimplementing it, so the emailed number cannot drift from
what the dashboard shows.

To enable email, add three repository secrets under Settings → Secrets and
variables → Actions:

| Secret | Value |
|---|---|
| `MAIL_USERNAME` | your Gmail address |
| `MAIL_PASSWORD` | a Google [App Password](https://myaccount.google.com/apppasswords), not your account password |
| `MAIL_TO` | where alerts should arrive |

Without them the refresh and commit still run; only the email step is skipped.

## Keeping data fresh

The on-chain provider's free tier allows **10 requests per hour per IP**, which a
few page loads exhausts. To keep the dashboard working regardless, on-chain
history ships as a snapshot in `data/onchain.json`; the live API is only a
top-up merged over it.

Refresh the snapshot periodically (daily is plenty — these metrics update once
a day):

```bash
node scripts/snapshot-onchain.mjs     # NUPL
node scripts/snapshot-etf.mjs         # US spot ETF net flows
node scripts/snapshot-treasuries.mjs  # MSTR/ASST prices, holdings, share counts
node scripts/snapshot-asst-8k.mjs     # Strive capital table from its weekly 8-K
node scripts/validate-data.mjs        # check every data file before committing
node scripts/check-alerts.mjs         # recompute score, detect band change
```

### Data files are the contract

The scripts and the dashboard never import each other. The only link between
them is a JSON file in `data/`, so a change to what a script writes is
invisible to the code that reads it until something breaks on the live site.
Each file, who writes it, and who depends on it:

| File | Written by | Read by |
|---|---|---|
| `data/treasuries.json` | `scripts/snapshot-treasuries.mjs` | `js/data.js` (`fetchTreasuries`) |
| `data/onchain.json` | `scripts/snapshot-onchain.mjs` | `js/data.js` (`loadOnchainSnapshot`) and `scripts/check-alerts.mjs` |
| `data/etf-flows.json` | `scripts/snapshot-etf.mjs` | `js/data.js` (`fetchEtfFlows`) and `scripts/check-alerts.mjs` |
| `data/asst-capital.json` | `scripts/snapshot-asst-8k.mjs` | `js/issuer.js` (`loadAsstCapital`) |
| `data/btc-history.json` | `scripts/build-btc-history.mjs` (once; static pre-2017 closes) | `js/data.js` (`fetchBtcHistory`) and `scripts/check-alerts.mjs` |
| `data/alert-state.json` | `scripts/check-alerts.mjs` | `scripts/check-alerts.mjs` (next run, for band changes) |

`scripts/validate-data.mjs` checks each file against what its readers need,
and against the last committed version so a refresh can never make data
older or thinner unnoticed. In the workflow it runs with `--restore`: a file
that fails goes back to its committed version and the run is marked failed.
`onchain.json` and `etf-flows.json` have two readers each, so a bad write there
would break the dashboard and the alert email together.

`alert-state.json` also records which source served each input on the last
run (`sources`) and which signals were missing (`missingSignals`), because the
workflow logs are not readable without admin access.

These run automatically via the daily workflow; the commands above are for
running them by hand.

`snapshot-etf.mjs` backfills the full history from TFTC and, if a
`SOSOVALUE_API_KEY` is present in an untracked `.env.local`, tops up the most
recent days from SoSoValue. The key is never committed and is not needed —
TFTC alone is sufficient.

## Data sources

All free, no API keys required:

- [bitcoin-data.com](https://bitcoin-data.com) — NUPL
- [DefiLlama](https://defillama.com) — stablecoin supply
- [Alternative.me](https://alternative.me/crypto/fear-and-greed-index/) — Fear & Greed Index
- [Binance](https://binance.com) — price history, live price stream
- [TFTC](https://www.tftc.io/bitcoin-etf-flows) — US spot BTC ETF daily net flows
  (CC BY 4.0; TFTC compiles these from SoSoValue and Farside Investors)
- [CoinGecko](https://www.coingecko.com) — public-company BTC treasury holdings
- [SEC EDGAR](https://www.sec.gov/edgar) — diluted shares outstanding (XBRL)
- Yahoo Finance — MSTR/ASST daily prices (fetched server-side; the endpoint
  sends no CORS headers, so a browser cannot call it directly)

## Licence / disclaimer

Educational tool. Not financial advice. Do your own research.
