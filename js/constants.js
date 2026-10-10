// ── Cycle Tide — signal definitions & weights ───────────────────────────────
// Composite "Cycle Score" (0-100): weighted blend of price-technical, on-chain,
// dry-powder, institutional-flow and sentiment signals. Higher = more
// historically accumulation-favorable; lower = more distribution-favorable.
//
// Sources (all free / no-key unless noted):
//   bitcoin-data.com     — NUPL
//   stablecoins.llama.fi — total stablecoin supply (SSR dry-powder proxy)
//   api.alternative.me   — Crypto Fear & Greed Index
//   Binance (spot)       — daily klines (price)
//   tftc.io (snapshot)   — US spot BTC ETF daily net flows (CC BY 4.0)
//   Self-computed from klines — ATH drawdown, 200WMA multiple, monthly RSI
//
// SEVEN SIGNALS, DOWN FROM ELEVEN (2026-10-10). Four were removed after each
// was scored at every cycle turning point its data covers (high = right at a
// low, low = right at a top):
//
//                 2020 low  2021 tops  2022 bottom  2025 top  2026 low
//   funding          100     0 / 19        65          62        61
//   pi_cycle          94     0 / 78       100          78       100
//   puell              -        -         100          81        96
//   mvrv_z             -        -         100          64        96
//
//   funding   worked in 2020-21, then read 61-65 at every turning point since
//             2022, top or bottom; over the following year high and low
//             readings led to the same return (79% vs 81%).
//   pi_cycle  read 78 ("fine") at both the late-2021 and the 2025 top, and
//             sat at its maximum on 35% of all days.
//   puell     ranged only 81-100 across the last top and both lows.
//   mvrv_z    read 64 at the 2025 top (thresholds set for the larger peaks of
//             older cycles) and duplicated NUPL (0.95 correlation), which
//             caught the same top at 25.
//
// Together they contributed ~11 points of constant uplift: the 11-signal model
// read 41 (HOLD) at the 2025 all-time high, these seven read 24. Lows are
// unchanged (97 / 89 vs 94 / 89).
//
// One further change the same day: the 200-week MA multiple is now ranked
// against its own last four years instead of scored on a fixed 1x-4x scale
// (see computeMa200wRank in indicators.js). Composite at the 2025 top went
// 24 -> 17; today 53 -> 48.
//
// The remaining weights are the old ones rescaled to 100, not re-tuned: with
// four lows and three tops in the data there is no basis for fitting weights.
// The one rounding point went to Fear & Greed, right at all seven turning
// points. Five of the seven (drawdown, NUPL, 200WMA, RSI and the removed
// MVRV) overlap heavily, so treat this as about five independent ideas.

const SIGNAL_DEFS = [
    {
        key: 'ath_drawdown',
        label: 'Drawdown from ATH',
        category: 'price',
        weight: 20,
        // Historical bottoms clustered around -75% to -85% from ATH; 0% = new ATH.
        // Score 100 at -80% drawdown, tapering to 0 at a new ATH.
        score(v) {
            if (v === null) return null;
            const pct = v * 100; // v is negative fraction, e.g. -0.45
            return clamp(mapRange(pct, 0, -85, 0, 100), 0, 100);
        },
        fmt: v => v === null ? '—' : `${(v * 100).toFixed(1)}% below ATH`,
        info: {
            tracks: 'How far the current price sits below the highest price Bitcoin has ever reached (measured on intraday highs).',
            why: 'Every cycle bottom so far has landed in a remarkably narrow band: −87% (2015), −84% (2018), −77% (2022). Deep drawdowns have historically been where risk/reward was best, and new highs where it was worst.',
            scale: [
                ['−75% to −85%', 'historical bottom zone', 'good'],
                ['−40% to −60%', 'mid-cycle correction', 'warn'],
                ['0% to −20%', 'at or near highs — distribution risk', 'bad'],
            ],
            caveat: 'ETF-era demand may dampen volatility, so a −80% drawdown is not guaranteed to repeat this cycle.',
            source: 'Self-computed from Binance daily candles.',
        },
    },
    {
        key: 'nupl',
        label: 'Net Unrealized Profit/Loss',
        category: 'onchain',
        weight: 12,
        // <0 Capitulation (100) ... >0.75 Euphoria (0)
        score(v) {
            if (v === null) return null;
            return clamp(mapRange(v, 0.75, 0, 0, 100), 0, 100);
        },
        fmt: v => v === null ? '—' : `NUPL = ${v.toFixed(2)}`,
        info: {
            tracks: 'The share of total network wealth currently sitting in unrealised profit rather than loss.',
            why: 'It maps the market\'s emotional state onto a number. When almost everyone is deep in profit, the marginal holder has every reason to take it — that is what a top looks like. When most of the network is underwater, sellers are exhausted.',
            scale: [
                ['below 0', 'capitulation — more loss than profit', 'good'],
                ['0 to 0.25', 'hope / fear', 'good'],
                ['0.25 to 0.50', 'optimism / anxiety', 'warn'],
                ['0.50 to 0.75', 'belief / denial', 'warn'],
                ['above 0.75', 'euphoria — every major top', 'bad'],
            ],
            caveat: 'Closely related to MVRV (both derive from realised cap), so the two move together and partly double-count.',
            source: 'bitcoin-data.com (free tier, 10 requests/hour).',
        },
    },
    {
        key: 'ma200w_mult',
        label: '200-Week MA Multiple (4-year rank)',
        category: 'price',
        weight: 15,
        // v is the share (0-1) of the last four years in which price sat LOWER
        // against its 200-week average than it does now. 1 = the most stretched
        // reading in four years (0); 0 = the least (100). See computeMa200wRank
        // for why this replaced the fixed 1x-4x scale.
        score(v) {
            if (v === null) return null;
            return clamp(mapRange(v, 1, 0, 0, 100), 0, 100);
        },
        fmt: (v, multiple) => v === null ? '—'
            : (typeof multiple === 'number' ? multiple.toFixed(2) + 'x — ' : '')
              + `higher than ${Math.round(v * 100)}% of the last 4 years`,
        info: {
            tracks: 'Current price divided by the 200-week (1,400-day) moving average, then ranked against that same figure over the last four years. It asks how stretched price is above its long-run trend compared with recent history.',
            why: 'The 200-week MA has acted as a durable floor for Bitcoin’s entire history: price has touched or briefly pierced it near every major bottom (2015, Mar 2020, Nov 2022, mid-2026). How far price climbs above it marks how extended a bull run has become.',
            scale: [
                ['lower than most of the last 4 years', 'near the long-run floor — accumulation', 'good'],
                ['around the middle', 'neither stretched nor cheap', 'warn'],
                ['higher than 80%+ of the last 4 years', 'extended — distribution watch', 'bad'],
            ],
            caveat: 'This used to be scored on a fixed scale where 4x meant "sell". Peaks have shrunk every cycle (3.79x in 2021, 2.33x in 2025), so that scale read a comfortable 56 at the 2025 all-time high. Ranking fixes that but has its own costs: it was slightly less sharp at the 2021 tops (12 and 21 against 0 and 7), read 82 rather than 100 at the 2026 low, and could only be tested on three tops in two cycles. A long flat market would also make a small rise look extreme.',
            source: 'Self-computed from daily closes: Binance from Aug 2017, Bitstamp before that (data/btc-history.json) so the four-year window reaches back to 2019.',
        },
    },
    {
        key: 'ssr',
        label: 'Stablecoin Supply Ratio (percentile)',
        category: 'liquidity',
        weight: 14,
        // v is a 0-1 percentile rank of SSR within trailing 2yr window.
        // Low percentile (low SSR) = lots of dry powder relative to BTC cap = accumulation-favorable.
        score(v) {
            if (v === null) return null;
            return clamp(mapRange(v, 1, 0, 0, 100), 0, 100);
        },
        fmt: v => v === null ? '—' : `${Math.round(v * 100)}th pct`,
        info: {
            tracks: 'Bitcoin\'s market cap divided by total stablecoin supply, expressed as a percentile against the trailing two years. Effectively: how much sidelined buying power exists relative to Bitcoin\'s own size.',
            why: 'Stablecoins are dry powder waiting to be deployed. When the pool is large relative to Bitcoin\'s market cap (a low percentile), there is more potential demand per dollar of Bitcoin. Stablecoin supply expanded sharply ahead of both the 2021 and 2024 rallies.',
            scale: [
                ['0–25th pct', 'lots of dry powder relative to BTC', 'good'],
                ['25–75th pct', 'typical', 'warn'],
                ['75–100th pct', 'thin buying power vs BTC size', 'bad'],
            ],
            caveat: 'Stablecoins are increasingly used for yield and payments outside crypto trading, so not all of this supply is genuinely waiting to buy Bitcoin.',
            source: 'DefiLlama stablecoin supply + self-computed market cap.',
        },
    },
    {
        key: 'etf_flow',
        label: 'US Spot ETF Net Flow (30d)',
        category: 'institutional',
        weight: 15,
        // v is a 0-1 percentile rank of the trailing 30-day net flow within
        // an ~18-month window. Heavy outflows (low percentile) have marked
        // capitulation; heavy inflows (high percentile) accompany tops.
        // Contrarian, like Fear & Greed: low percentile scores HIGH.
        score(v) {
            if (v === null) return null;
            return clamp(mapRange(v, 1, 0, 0, 100), 0, 100);
        },
        fmt: v => v === null ? '—' : `${Math.round(v * 100)}th pct of trailing 18m`,
        info: {
            tracks: 'Net capital flowing into or out of the US spot Bitcoin ETFs, summed over the trailing 30 days and ranked against roughly the last 18 months. Daily flow alone swings between −$1.1bn and +$1.4bn, so the rolling sum is what carries signal.',
            why: 'Since January 2024 the ETFs have been the dominant marginal buyer of Bitcoin, and unlike on-chain metrics this measures institutional capital directly. Read contrarian: sustained heavy outflows have marked capitulation lows (the July 2026 low registered the 1st percentile, −$6.8bn over 30 days), while peak inflows accompanied the March 2024 and October 2025 highs.',
            scale: [
                ['0–25th pct', 'heavy outflows — capitulation', 'good'],
                ['25–60th pct', 'muted or mixed demand', 'warn'],
                ['60–85th pct', 'strong institutional bid', 'warn'],
                ['85–100th pct', 'euphoric inflows — top-adjacent', 'bad'],
            ],
            caveat: 'Only ~2.5 years of history exists (the ETFs launched Jan 2024), so this covers a single cycle — there is no prior-cycle precedent to validate it against. Data is a committed snapshot, refreshed by scripts/snapshot-etf.mjs.',
            source: 'TFTC (tftc.io), CC BY 4.0 — compiled from SoSoValue and Farside Investors.',
        },
    },
    {
        key: 'fear_greed',
        label: 'Crypto Fear & Greed Index',
        category: 'sentiment',
        weight: 16,
        // 0 Extreme Fear (100) ... 100 Extreme Greed (0) — inverted, contrarian.
        score(v) {
            if (v === null) return null;
            return clamp(mapRange(v, 80, 20, 0, 100), 0, 100);
        },
        fmt: v => v === null ? '—' : Math.round(v),
        info: {
            tracks: 'A 0–100 composite of volatility, momentum, volume, social sentiment, dominance and search trends, published daily.',
            why: 'Read contrarian: this signal scores HIGH when the index is LOW. Extreme fear has marked local-to-major bottoms (2018, Mar 2020, Nov 2022); extreme greed has accompanied tops. Crowd sentiment is most useful precisely when it is most one-sided.',
            scale: [
                ['0–24 extreme fear', 'contrarian buy zone', 'good'],
                ['25–44 fear', 'leaning favourable', 'good'],
                ['45–55 neutral', 'no edge', 'warn'],
                ['56–75 greed', 'caution', 'bad'],
                ['76–100 extreme greed', 'contrarian sell zone', 'bad'],
            ],
            caveat: 'Sentiment can stay extreme for months during a strong trend, so it is poor at timing on its own — it flags conditions, not turning points.',
            source: 'Alternative.me Fear & Greed API.',
        },
    },
    {
        key: 'rsi_monthly',
        label: 'Monthly RSI (14)',
        category: 'price',
        weight: 8,
        // <30 capitulation (100) ... >85 euphoria (0)
        score(v) {
            if (v === null) return null;
            return clamp(mapRange(v, 85, 30, 0, 100), 0, 100);
        },
        fmt: v => v === null ? '—' : v.toFixed(1),
        info: {
            tracks: 'Standard 14-period Relative Strength Index computed on MONTHLY closes rather than daily — a momentum oscillator viewed at cycle timescale.',
            why: 'Running RSI monthly filters out the daily noise that makes the indicator nearly useless for long-horizon decisions. At this timescale its extremes have lined up with cycle turning points: the low 30s at capitulation bottoms, the high 80s at blow-off tops.',
            scale: [
                ['below 30', 'capitulation (2015, 2018, 2022)', 'good'],
                ['40 to 60', 'mid-cycle, no strong signal', 'warn'],
                ['above 85', 'euphoric top zone (Dec 2017, 2021)', 'bad'],
            ],
            caveat: 'A monthly candle only closes twelve times a year, so this updates slowly and the current month is always incomplete. Lowest weight in the model for that reason.',
            source: 'Self-computed from Binance daily candles, resampled to monthly.',
        },
    },
];

const CATEGORY_LABELS = {
    onchain:       'On-Chain Valuation',
    liquidity:     'Dry Powder / Liquidity',
    institutional: 'Institutional Flows',
    sentiment:     'Sentiment',
    price:         'Price Technicals',
};

const TOTAL_WEIGHT = SIGNAL_DEFS.reduce((s, d) => s + d.weight, 0);

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Maps v from [inLo..inHi] to [outLo..outHi], linear, extrapolated then caller clamps.
function mapRange(v, inLo, inHi, outLo, outHi) {
    if (inHi === inLo) return outLo;
    const t = (v - inLo) / (inHi - inLo);
    return outLo + t * (outHi - outLo);
}

// ── Cycle reference data (halvings — for phase labeling) ───────────────────
const HALVINGS = [
    { ts: new Date('2012-11-28').getTime(), label: 'Halving 2012' },
    { ts: new Date('2016-07-09').getTime(), label: 'Halving 2016' },
    { ts: new Date('2020-05-11').getTime(), label: 'Halving 2020' },
    { ts: new Date('2024-04-19').getTime(), label: 'Halving 2024' },
    { ts: new Date('2028-04-18').getTime(), label: 'Halving 2028 (est.)' },
];

// Historical backtest reference events (approximate score reconstructions
// using publicly known historical indicator readings at each event).
const BACKTEST_EVENTS = [
    // Each event carries the DAY it happened. The table used to score every
    // event on the 15th of its month, which put the 2025 top nine days after
    // the top (and after the 10 October crash): it showed 39 where the date
    // browser, on the real date, showed 17. No scores are stored here — every
    // row is computed live from the same code as the dashboard.
    { date: '2015-01-14', label: '2015-01 bottom (~$152, -84% from $1,163 ATH)' },
    { date: '2017-12-17', label: '2017-12 top (~$19,800, new ATH)' },
    { date: '2018-12-15', label: '2018-12 bottom (~$3,150, -84% from $19,800 ATH)' },
    { date: '2020-03-13', label: '2020-03 COVID crash (~$4,900)' },
    { date: '2021-04-14', label: '2021-04 first top (~$64,800)' },
    { date: '2021-11-10', label: '2021-11 top (~$69,000, new ATH, mania)' },
    { date: '2022-11-21', label: '2022-11 bottom (~$15,600, -77%, FTX collapse)' },
    { date: '2023-10-15', label: '2023-10 liquidity reversal (~$27,000)' },
    { date: '2025-10-06', label: '2025-10 top (~$126,200, new ATH)' },
    { date: '2026-07-01', label: '2026-07 low (~$57,800, -54%)' },
];
