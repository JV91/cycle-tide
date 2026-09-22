// ── Cycle Tide — forward cycle projection ───────────────────────────────────
// IMPORTANT: this is a SCHEDULE-BASED PROJECTION, not a model output.
//
// It does not predict price and it is not derived from the live signals. It
// answers a narrower question: "if the next cycle rhymes with the last three
// in TIMING, roughly when would the accumulation and distribution windows
// fall?" Everything here is anchored to the halving schedule plus the
// historical average offsets from halving → top → bottom.
//
// Past cycles (days from halving to cycle top, and top to cycle bottom):
//   2012 halving → 2013-11 top: 366d  → 2015-01 bottom: 411d
//   2016 halving → 2017-12 top: 526d  → 2018-12 bottom: 363d
//   2020 halving → 2021-11 top: 548d  → 2022-11 bottom: 376d
//   2024 halving → 2025-10 top: 535d  → 2026-07-01 bottom: 268d
//
// The spread on "days to top" is wide (366–548) and has been drifting later
// each cycle, so the projection carries an explicit uncertainty band rather
// than pretending to a single date.
//
// THE 2026 BOTTOM IS NOW TREATED AS IN. Until 2026-09 this file still
// projected a bottom that had already happened, so the chart drew a decline
// into a low the market had left 83 days earlier. The low was $57,800 on
// 2026-07-01 (Binance BTCUSDT daily low). Evidence it holds:
//
//   • +49.7% off it as of 2026-09-22, never revisited
//   • price back above the 200DMA ($70.7k)
//   • the same recovery profile the 2018-12 and 2022-11 bottoms showed
//
// But it does NOT look like prior bottoms in shape, and that is worth stating
// rather than smoothing over:
//
//   top→bottom   268d   vs 363–411d historically   (much faster)
//   depth        -54%    vs -77% to -86%             (much shallower)
//
// So either the cycle compressed — plausible with ETFs and treasury companies
// absorbing supply — or this was an interim low in a longer bear that has not
// finished. The projection takes the first reading because price action
// supports it, and says so in the UI instead of hiding the assumption.

const CYCLE_HISTORY = [
    { halving: '2012-11-28', top: '2013-11-29', bottom: '2015-01-14' },
    { halving: '2016-07-09', top: '2017-12-17', bottom: '2018-12-15' },
    { halving: '2020-05-11', top: '2021-11-10', bottom: '2022-11-21' },
    { halving: '2024-04-19', top: '2025-10-06', bottom: '2026-07-01' },
];

// The confirmed low of the 2024-halving cycle, and the all-time high that
// preceded it. Both are observed values, not estimates.
const CYCLE_LOW  = { date: '2026-07-01', usd: 57800 };
const CYCLE_HIGH = { date: '2025-10-06', usd: 126200 };

// The 2026 bottom is excluded from the top->bottom average used to project
// FUTURE bottoms: at 268 days it is a 3.5-sigma outlier against the other
// three (363/376/411), and averaging it in would drag the 2029 projection
// forward by about seven weeks on a single anomalous observation.
const BOTTOM_LAG_SAMPLE = ['2015-01-14', '2018-12-15', '2022-11-21'];

const NEXT_HALVING = new Date('2028-04-18').getTime();
const DAY = 86400000;

function cycleOffsets() {
    const toTop = [], topToBottom = [];
    for (const c of CYCLE_HISTORY) {
        const h = new Date(c.halving).getTime();
        const t = new Date(c.top).getTime();
        toTop.push(Math.round((t - h) / DAY));
        // See BOTTOM_LAG_SAMPLE: the 2026 bottom is real but its 268-day lag
        // is an outlier, so it does not shape projections of future bottoms.
        if (c.bottom && BOTTOM_LAG_SAMPLE.includes(c.bottom)) {
            topToBottom.push(Math.round((new Date(c.bottom).getTime() - t) / DAY));
        }
    }
    return { toTop, topToBottom };
}

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function stdev(a) {
    const m = mean(a);
    return Math.sqrt(mean(a.map(v => (v - m) ** 2)));
}

// Projected key dates. The current cycle's top AND bottom are both observed
// now, so the only projections left are the 2028 halving and what follows it.
function projectCycleDates() {
    const { toTop, topToBottom } = cycleOffsets();

    const btMean = mean(topToBottom), btSd = Math.max(stdev(topToBottom), 20);
    const ttMean = mean(toTop), ttSd = Math.max(stdev(toTop), 30);

    const nextTopTs = NEXT_HALVING + ttMean * DAY;
    const nextBottomTs = nextTopTs + btMean * DAY;

    // The recovery high between a confirmed bottom and the next halving has no
    // clean historical analogue to project from — in 2019 it ran +340% off the
    // bottom then gave most of it back, in 2023-24 it ran straight into the
    // halving. So we mark the halving itself and let the next top carry the
    // uncertainty, rather than inventing an interim peak.
    return {
        cycleLow:      { ts: Date.parse(CYCLE_LOW.date + 'T00:00:00Z'), usd: CYCLE_LOW.usd, observed: true },
        cycleHigh:     { ts: Date.parse(CYCLE_HIGH.date + 'T00:00:00Z'), usd: CYCLE_HIGH.usd, observed: true },
        nextHalving:   { ts: NEXT_HALVING },
        nextTop:       { ts: nextTopTs, loTs: nextTopTs - ttSd * DAY, hiTs: nextTopTs + ttSd * DAY },
        nextBottom:    { ts: nextBottomTs },
        stats: { toTop, topToBottom, ttMean, ttSd, btMean, btSd },
    };
}

// A projected *score* path (not price): the cycle score has historically run
// high near bottoms and low near tops, so we shape a curve through the
// projected turning points. Scores are clamped to plausible historical
// extremes rather than 0/100 — the composite rarely pins at either end.
function projectScoreSeries(lastRealTs, lastRealScore) {
    const d = projectCycleDates();
    const SCORE_AT_BOTTOM = 88;
    const SCORE_AT_TOP     = 18;
    const SCORE_AT_HALVING = 62;

    // The cycle bottom is behind us, so the path runs from here toward the
    // 2028 halving and the top after it — no projected decline into a low the
    // market already made.
    const anchors = [
        { ts: lastRealTs,          score: lastRealScore },
        { ts: d.nextHalving.ts,    score: SCORE_AT_HALVING, label: 'Halving 2028' },
        { ts: d.nextTop.ts,        score: SCORE_AT_TOP,    label: 'Projected cycle top' },
        { ts: d.nextBottom.ts,     score: SCORE_AT_BOTTOM, label: 'Projected next bottom' },
    ].filter(a => a.ts >= lastRealTs);

    // Smooth weekly interpolation (cosine easing) between anchors.
    const pts = [];
    for (let i = 0; i < anchors.length - 1; i++) {
        const a = anchors[i], b = anchors[i + 1];
        const span = b.ts - a.ts;
        if (span <= 0) continue;
        for (let t = a.ts; t < b.ts; t += 7 * DAY) {
            const p = (t - a.ts) / span;
            const eased = (1 - Math.cos(p * Math.PI)) / 2;
            pts.push({ ts: t, value: a.score + (b.score - a.score) * eased });
        }
    }
    const lastAnchor = anchors[anchors.length - 1];
    if (lastAnchor) pts.push({ ts: lastAnchor.ts, value: lastAnchor.score });

    return { points: pts, dates: d, anchors: anchors.slice(1) };
}

// ── Price projection ────────────────────────────────────────────────────────
// READ THIS BEFORE TRUSTING THE LINE.
//
// Cycle *timing* has rhymed well enough to project. Cycle *magnitude* has
// not: each cycle's gain has been a fraction of the last.
//
//   2012→2013 top:  +57,400%
//   2016→2017 top:  +13,133%   (~23% of prior cycle's multiple)
//   2020→2021 top:   +2,126%   (~16%)
//   2024→2025 top:     +712%   (~33%)
//
// Extrapolating that decay is guesswork with a sample of three. So this
// returns a wide BAND, not a point estimate, and the defaults match the
// assumptions already used in the sibling BTC Strategy project so the two
// tools don't quietly disagree.
//
// These are ASSUMPTIONS YOU SET, not model outputs. Change them freely.
//
// The current-cycle bottom is no longer an assumption: it is $57,800, observed
// on 2026-07-01. Only the forward top is still a guess.
const PRICE_ASSUMPTIONS = {
    bottomUSD:   CYCLE_LOW.usd,   // OBSERVED, not projected
    bottomLoUSD: CYCLE_LOW.usd,
    bottomHiUSD: CYCLE_LOW.usd,
    nextTopUSD:   250000,  // projected 2029 cycle top (mid)
    nextTopLoUSD: 150000,  // magnitude decay is the dominant uncertainty here
    nextTopHiUSD: 400000,
};

function priceAssumptions() {
    // Allow live override from the UI inputs, falling back to defaults.
    const num = id => {
        const el = document.getElementById(id);
        const v = el ? parseFloat(el.value) : NaN;
        return isNaN(v) ? null : v;
    };
    const bottomUSD  = num('assumeBottom') ?? PRICE_ASSUMPTIONS.bottomUSD;
    const nextTopUSD = num('assumeTop')    ?? PRICE_ASSUMPTIONS.nextTopUSD;

    // Bands scale with the mid so the ratio of uncertainty is preserved when
    // the user overrides an assumption (otherwise the mid can end up sitting
    // on or outside its own band).
    const bScale = bottomUSD  / PRICE_ASSUMPTIONS.bottomUSD;
    const tScale = nextTopUSD / PRICE_ASSUMPTIONS.nextTopUSD;

    return {
        bottomUSD,
        bottomLoUSD:   PRICE_ASSUMPTIONS.bottomLoUSD  * bScale,
        bottomHiUSD:   PRICE_ASSUMPTIONS.bottomHiUSD  * bScale,
        nextTopUSD,
        nextTopLoUSD:  PRICE_ASSUMPTIONS.nextTopLoUSD * tScale,
        nextTopHiUSD:  PRICE_ASSUMPTIONS.nextTopHiUSD * tScale,
    };
}

// Geometric (log-space) interpolation — price moves multiplicatively, so a
// straight line in log space is the honest shape between two price anchors.
function logLerp(a, b, t) {
    return Math.exp(Math.log(a) + t * (Math.log(b) - Math.log(a)));
}

function projectPriceSeries(lastRealTs, lastRealPrice) {
    const d = projectCycleDates();
    const A = priceAssumptions();

    // Bands are already scaled to the (possibly overridden) mids.
    const bLo = A.bottomLoUSD,  bHi = A.bottomHiUSD;
    const tLo = A.nextTopLoUSD, tHi = A.nextTopHiUSD;

    // Halving-year price is modelled as a fraction of the following top,
    // matching the shape used in the BTC Strategy project (~0.42x).
    const halvingMid = A.nextTopUSD * 0.42;

    // No bottom anchor: it is behind us. The path runs from today's price to
    // the 2028 halving, so the line no longer dives into a low already made.
    const anchors = [
        { ts: lastRealTs,         mid: lastRealPrice, lo: lastRealPrice, hi: lastRealPrice },
        { ts: d.nextHalving.ts,   mid: halvingMid,    lo: halvingMid * 0.7, hi: halvingMid * 1.4 },
        { ts: d.nextTop.ts,       mid: A.nextTopUSD,  lo: tLo,           hi: tHi },
        // Post-top decline: past bears drew down 77–87% from the top.
        { ts: d.nextBottom.ts,    mid: A.nextTopUSD * 0.22,
                                  lo:  tLo * 0.13,    hi: tHi * 0.30 },
    ].filter(a => a.ts >= lastRealTs);

    const pts = [];
    for (let i = 0; i < anchors.length - 1; i++) {
        const a = anchors[i], b = anchors[i + 1];
        const span = b.ts - a.ts;
        if (span <= 0) continue;
        for (let t = a.ts; t < b.ts; t += 7 * DAY) {
            const p = (t - a.ts) / span;
            const eased = (1 - Math.cos(p * Math.PI)) / 2;
            pts.push({
                ts: t,
                mid: logLerp(a.mid, b.mid, eased),
                lo:  logLerp(a.lo,  b.lo,  eased),
                hi:  logLerp(a.hi,  b.hi,  eased),
            });
        }
    }
    const la = anchors[anchors.length - 1];
    if (la) pts.push({ ts: la.ts, mid: la.mid, lo: la.lo, hi: la.hi });

    return { points: pts, dates: d, assumptions: A, anchors: anchors.slice(1) };
}
