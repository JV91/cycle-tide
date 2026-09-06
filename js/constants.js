// ── Cycle Tide — signal definitions & weights ───────────────────────────────
// Composite "Cycle Score" (0-100): weighted blend of on-chain, leverage,
// dry-powder, sentiment and price-technical signals. Higher = more
// historically accumulation-favorable; lower = more distribution-favorable.
//
// Sources (all free / no-key unless noted):
//   bitcoin-data.com   — MVRV Z-Score, NUPL, Puell Multiple
//   stablecoins.llama.fi — total stablecoin supply (SSR dry-powder proxy)
//   api.alternative.me  — Crypto Fear & Greed Index
//   fapi.binance.com    — funding rate, open interest, daily klines (price)
//   tftc.io (snapshot)  — US spot BTC ETF daily net flows (CC BY 4.0)
//   Self-computed from klines — ATH drawdown, 200WMA multiple, Pi Cycle, monthly RSI

const SIGNAL_DEFS = [
    {
        key: 'ath_drawdown',
        label: 'Drawdown from ATH',
        category: 'price',
        weight: 13,
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
        key: 'mvrv_z',
        label: 'MVRV Z-Score',
        category: 'onchain',
        weight: 12,
        // <0 = historical capitulation (score 100). >7 = historical top (score 0).
        score(v) {
            if (v === null) return null;
            return clamp(mapRange(v, 7, 0, 0, 100), 0, 100);
        },
        fmt: v => v === null ? '—' : `z = ${v.toFixed(2)}`,
        info: {
            tracks: 'Market cap versus realised cap — the aggregate price at which every coin last moved — normalised by volatility. In plain terms: how far the market has stretched above what holders actually paid.',
            why: 'Tops form when unrealised profit is extreme and holders are heavily incentivised to sell; bottoms form when the average holder is underwater. It is the single most reliable cycle-position indicator in this model, which is why it carries the joint-highest weight.',
            scale: [
                ['below 0', 'market cap under cost basis — capitulation', 'good'],
                ['0 to 2', 'accumulation / early bull', 'good'],
                ['2 to 5', 'mid-to-late bull', 'warn'],
                ['above 7', 'extreme top zone (2013, 2017, Apr 2021)', 'bad'],
            ],
            caveat: 'Peak Z-scores have declined each cycle (2021 topped at ~6.4, below 2017), so a fixed ">7 = top" rule may be too strict now.',
            source: 'bitcoin-data.com (free tier, 10 requests/hour).',
        },
    },
    {
        key: 'nupl',
        label: 'Net Unrealized Profit/Loss',
        category: 'onchain',
        weight: 8,
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
        key: 'puell',
        label: 'Puell Multiple',
        category: 'onchain',
        weight: 8,
        // <0.5 miner capitulation (100) ... >4 euphoric top (0)
        score(v) {
            if (v === null) return null;
            return clamp(mapRange(v, 4, 0.5, 0, 100), 0, 100);
        },
        fmt: v => v === null ? '—' : v.toFixed(2) + 'x',
        info: {
            tracks: 'Daily miner revenue in USD versus its own 365-day average — how well miners are being paid relative to their recent norm.',
            why: 'Miners are structural, price-insensitive sellers who must cover energy costs. When revenue spikes far above trend they distribute heavily into strength; when it collapses, weaker miners capitulate and sell inventory, which has repeatedly coincided with cycle lows.',
            scale: [
                ['below 0.5', 'miner capitulation — every major bottom', 'good'],
                ['0.5 to 3.0', 'normal operating range', 'warn'],
                ['above 4', 'miners paid far above trend — top zone', 'bad'],
            ],
            caveat: 'Halvings mechanically halve revenue overnight, which distorts the ratio for months afterwards.',
            source: 'bitcoin-data.com (free tier, 10 requests/hour).',
        },
    },
    {
        key: 'pi_cycle',
        label: 'Pi Cycle Top (111DMA / 2×350DMA)',
        category: 'price',
        weight: 8,
        // Ratio >= 1.0 = the crossover has fired (historical top zone, score 0).
        // ~0.45 and below = early-cycle / post-capitulation (score 100).
        // Self-computed from price, so unlike the on-chain block it can never
        // go dark on an API outage.
        score(v) {
            if (v === null) return null;
            return clamp(mapRange(v, 1.0, 0.45, 0, 100), 0, 100);
        },
        fmt: v => {
            if (v === null) return '—';
            const pct = (v * 100).toFixed(1);
            return v >= 1
                ? `${pct}% — crossover FIRED (top signal)`
                : `${pct}% of the way to crossover`;
        },
        info: {
            tracks: 'How close the 111-day moving average is to crossing above twice the 350-day moving average. Shown as a percentage of the way there, so it reads as a continuous gauge rather than an on/off trigger.',
            why: 'When that crossover fires it has marked cycle tops within a handful of days — 2013 (both peaks), 2017, and April 2021. The ratio 350/111 is approximately π, which is where the name comes from and is almost certainly coincidence.',
            scale: [
                ['below 50%', 'early cycle / post-capitulation', 'good'],
                ['50% to 85%', 'mid-to-late bull, worth watching', 'warn'],
                ['85% to 100%', 'approaching the crossover', 'bad'],
                ['100% or above', 'crossover fired — historical top', 'bad'],
            ],
            caveat: 'It did NOT fire at the Nov 2021 lower high or the Oct 2025 top, and its reliability under ETF-era market structure is untested. Kept at modest weight for that reason.',
            source: 'Self-computed from Binance daily candles — needs no external API, so it keeps working when the on-chain sources are rate-limited.',
        },
    },
    {
        key: 'ma200w_mult',
        label: '200-Week MA Multiple',
        category: 'price',
        weight: 10,
        // <1.0x = deep-bottom zone (100) ... >4x = historically stretched (0)
        score(v) {
            if (v === null) return null;
            return clamp(mapRange(v, 4, 1, 0, 100), 0, 100);
        },
        fmt: v => v === null ? '—' : v.toFixed(2) + 'x',
        info: {
            tracks: 'Current price divided by the 200-week (1,400-day) moving average — how far price has extended above its long-run trend floor.',
            why: 'The 200-week MA has acted as a durable floor for Bitcoin\'s entire history. Price has touched or briefly pierced it near every major bottom (2015, Mar 2020, Nov 2022) and has never spent long below it.',
            scale: [
                ['below 1.0x', 'at or under the floor — rare, deep bottom', 'good'],
                ['1.0x to 2.0x', 'accumulation to mid-bull', 'good'],
                ['2.0x to 3.0x', 'extended', 'warn'],
                ['above 4x', 'historically stretched', 'bad'],
            ],
            caveat: 'The ceiling has compressed each cycle as Bitcoin matures, so old multiples like 5x are unlikely to recur. Also needs 1,400 days of data, so it cannot be computed before mid-2021 from this price source.',
            source: 'Self-computed from Binance daily candles.',
        },
    },
    {
        key: 'ssr',
        label: 'Stablecoin Supply Ratio (percentile)',
        category: 'liquidity',
        weight: 9,
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
        weight: 10,
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
        key: 'funding',
        label: 'Perp Funding Rate (8h, BTCUSDT)',
        category: 'leverage',
        weight: 7,
        // Deeply negative (crowded shorts) = accumulation-favorable (100).
        // Elevated positive (overheated longs) = distribution risk (0).
        score(v) {
            if (v === null) return null;
            const pct = v * 100; // convert fraction to %
            return clamp(mapRange(pct, 0.08, -0.04, 0, 100), 0, 100);
        },
        fmt: v => v === null ? '—' : `${(v * 100).toFixed(4)}%/8h`,
        info: {
            tracks: 'The fee paid every 8 hours between long and short holders of perpetual futures to keep the contract pinned to spot price. Positive means longs are paying shorts.',
            why: 'It is a direct read on crowded positioning. Sustained high positive funding means the market is heavily leveraged long — fuel for a liquidation cascade. Deeply negative funding means shorts are crowded, which has repeatedly preceded squeeze rallies off local lows.',
            scale: [
                ['below −0.03%', 'crowded shorts — squeeze risk upward', 'good'],
                ['around 0.01%', 'neutral baseline', 'warn'],
                ['above 0.05–0.10%', 'overheated longs — correction risk', 'bad'],
            ],
            caveat: 'This is a short-horizon signal (days, not months), so it says little about cycle position on its own. Weighted accordingly.',
            source: 'Binance perpetual futures API.',
        },
    },
    {
        key: 'fear_greed',
        label: 'Crypto Fear & Greed Index',
        category: 'sentiment',
        weight: 10,
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
        weight: 5,
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
    leverage:      'Derivatives & Leverage',
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
    { date: '2015-01', label: '2015-01 bottom (~$152, -84% from $1,163 ATH)',   score: 96, phase: 'Phase 1 — Accumulation' },
    { date: '2017-12', label: '2017-12 top (~$19,800, new ATH)',                score: 8,  phase: 'Neutral / Transition' },
    { date: '2018-12', label: '2018-12 bottom (~$3,150, -84% from $19,800 ATH)',score: 93, phase: 'Phase 1 — Accumulation' },
    { date: '2020-03', label: '2020-03 COVID crash (~$4,900)',                  score: 78, phase: 'Phase 1 — Accumulation' },
    { date: '2021-11', label: '2021-11 top (~$69,000, new ATH, mania)',         score: 6,  phase: 'Neutral / Transition' },
    { date: '2022-11', label: '2022-11 bottom (~$15,600, -77%, FTX collapse)',  score: 91, phase: 'Phase 1 — Accumulation' },
    { date: '2023-10', label: '2023-10 liquidity reversal (~$27,000)',          score: 71, phase: 'Phase 1 — Accumulation' },
    { date: '2025-10', label: '2025-10 top (~$126,198, new ATH)',               score: 12, phase: 'Neutral / Transition' },
];
