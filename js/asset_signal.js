// ── Cycle Tide — treasury-company signal ────────────────────────────────────
//
// A deliberately different construction from the BTC cycle score, for a
// reason worth stating: the BTC model percentile-ranks each signal against
// its own history, because Bitcoin has no fair value to measure against.
// A treasury company DOES have one — the Bitcoin it owns — so mNAV can be
// scored against the fixed 1.0x anchor without needing any history.
//
// The honest limitation: CoinGecko gives only CURRENT BTC holdings, not a
// series, so historical mNAV cannot be reconstructed here. That means these
// thresholds are reasoned judgement calls about the economics, NOT levels
// fitted to data. They are stated as such in the UI rather than dressed up
// as a backtested model.

const ASSET_SIGNAL_FACTORS = [
    {
        key: 'mnav',
        infoKey: 'factorMnav',
        label: 'Valuation vs Bitcoin held',
        weight: 55,
        // The dominant factor. Below 1.0x you acquire BTC exposure below the
        // value of the coins; above ~1.5x you are paying a large premium that
        // has to be justified by future accretion.
        score(ctx) {
            const m = ctx.mnav;
            if (m === null || m === undefined) return null;
            if (m >= 2.0) return 0;
            // Anchors: 0.3x -> 100, 0.7x -> 88, 1.0x -> 70, 1.5x -> 25, 2.0x -> 0.
            // The curve deliberately keeps climbing below 0.7x instead of
            // saturating: a 0.20x mNAV and a 0.69x mNAV are very different
            // propositions and previously scored identically.
            if (m <= 0.3) return 100;
            if (m <= 0.7) return 88 + (0.7 - m) / 0.4 * 12;
            if (m <= 1.0) return 70 + (1.0 - m) / 0.3 * 18;
            if (m <= 1.5) return 25 + (1.5 - m) / 0.5 * 45;
            return (2.0 - m) / 0.5 * 25;
        },
        detail: ctx => ctx.mnav === null ? 'unavailable'
            : `${ctx.mnav.toFixed(2)}x — ` + (ctx.mnav < 1
                ? `${((1 - ctx.mnav) * 100).toFixed(0)}% discount to its Bitcoin`
                : `${((ctx.mnav - 1) * 100).toFixed(0)}% premium to its Bitcoin`),
    },
    {
        key: 'treasuryHealth',
        infoKey: 'factorTreasury',
        consequence: true,
        label: 'Treasury position vs cost',
        weight: 25,
        // Unrealised P/L on the stack. Deeply underwater means financing
        // pressure — forced issuance at bad prices, covenant stress, in
        // extremis selling coins. Deep profit means room to absorb a drawdown.
        score(ctx) {
            const p = ctx.unrealisedPct;
            if (p === null || p === undefined) return null;
            // -40% -> 0, 0% -> 50, +100% -> 100
            if (p <= -0.4) return 0;
            if (p >= 1.0) return 100;
            if (p <= 0) return (p + 0.4) / 0.4 * 50;
            return 50 + (p / 1.0) * 50;
        },
        detail: ctx => ctx.unrealisedPct === null ? 'unavailable'
            : `${ctx.unrealisedPct >= 0 ? '+' : ''}${(ctx.unrealisedPct * 100).toFixed(1)}% on cost`
              + (ctx.unrealisedPct < 0 ? ' — underwater' : ''),
    },
    {
        key: 'relPerf',
        infoKey: 'factorRelPerf',
        consequence: true,
        label: 'Delivered vs simply holding BTC',
        weight: 20,
        // Over the longest window available. If the equity has persistently
        // lagged Bitcoin, the extra risks are not being paid for — which is a
        // reason for caution regardless of how cheap the wrapper looks.
        score(ctx) {
            const d = ctx.relPerf;
            if (d === null || d === undefined) return null;
            // -50% -> 0, 0 -> 50, +50% -> 100
            return clamp(50 + (d / 0.5) * 50, 0, 100);
        },
        detail: ctx => ctx.relPerf === null ? 'unavailable'
            : `${ctx.relPerf >= 0 ? '+' : ''}${(ctx.relPerf * 100).toFixed(1)}% vs BTC (${ctx.relPerfWindow})`,
    },
];

const ASSET_SIGNAL_TOTAL = ASSET_SIGNAL_FACTORS.reduce((s, f) => s + f.weight, 0);

// Band edges. ACCUMULATE sits at 65 rather than 70: because mNAV caps at 55 of
// 100 points and the other two factors are usually weak precisely when a
// discount exists, a 70 cutoff demanded roughly a 50% discount before the
// model would call anything cheap. A 30-40% discount to hard assets reading
// merely "fairly priced" was too conservative to be useful.
function assetSignalBands(score) {
    if (score === null) return { label: 'No call', signal: 'hold' };
    if (score >= 65) return { label: 'Cheap vs its Bitcoin', signal: 'accumulate' };
    if (score >= 45) return { label: 'Fairly priced',        signal: 'hold' };
    if (score >= 25) return { label: 'Rich vs its Bitcoin',  signal: 'distribute' };
    return { label: 'Expensive vs its Bitcoin', signal: 'distribute' };
}

// Requires the dominant factor: an "ACCUMULATE" driven only by the two minor
// factors, with mNAV missing, would be an unsupported call.
const ASSET_MIN_WEIGHT = 0.75;

function computeAssetSignal(ctx) {
    // A price crash makes all three factors fire negative at once — but
    // "treasury underwater" and "underperformed BTC" are largely CONSEQUENCES
    // of the price falling, which is the same event the discount already
    // reflects. Left unadjusted the model punishes one event three times, so a
    // company trading at a fifth of its Bitcoin could still read HOLD.
    //
    // Damping engages from 1.0x — ANY discount means the market has already
    // marked the equity down for these problems, so counting them again is
    // double-counting. The earlier 0.7x threshold was arbitrary and left a
    // 38% discount reading HOLD: at 0.62x it was only 20% engaged. It now
    // ramps from 1.0x to 0.4x, by which point the discount speaks alone.
    const m = ctx.mnav;
    const damp = (m !== null && m !== undefined && m < 1.0)
        ? clamp((1.0 - m) / 0.6, 0, 1)
        : 0;

    let sum = 0, avail = 0;
    const factors = ASSET_SIGNAL_FACTORS.map(f => {
        let sc = f.score(ctx);
        if (sc !== null && f.consequence && damp > 0) {
            sc = sc + (50 - sc) * damp;
        }
        if (sc !== null) { sum += sc * f.weight; avail += f.weight; }
        return { ...f, score: sc, detailText: f.detail(ctx), damped: f.consequence && damp > 0 };
    });

    const confidence = avail / ASSET_SIGNAL_TOTAL;
    const composite = avail > 0 ? sum / avail : null;
    const mnavAvailable = factors.find(f => f.key === 'mnav')?.score !== null;
    const reliable = composite !== null && confidence >= ASSET_MIN_WEIGHT && mnavAvailable;

    // Hard gate: "cheap vs its Bitcoin" must mean an actual discount. Without
    // this a company at or above 1.0x could reach the ACCUMULATE band on the
    // strength of the minor factors alone — which would be calling something
    // cheap while you pay more than the coins are worth.
    const atDiscount = m !== null && m !== undefined && m < 0.95;

    // Can this company's thresholds be checked against its own history at all?
    // MSTR tags holdings in XBRL so a real mNAV range exists; Strive does not,
    // so its verdict rests entirely on reasoned thresholds with no empirical
    // bracket. That difference should be visible, not buried in an explainer.
    const validated = !!(TREASURIES?.[ctx.companyKey]?.holdingsHistory?.length);

    return { composite, confidence, factors, reliable, mnavAvailable, atDiscount, validated };
}

function renderAssetSignal(ctx) {
    const r = computeAssetSignal(ctx);
    let band = assetSignalBands(r.reliable ? r.composite : null);
    // Cap at HOLD when there is no discount, however well the rest scores.
    if (band.signal === 'accumulate' && !r.atDiscount) {
        band = { label: 'Fairly priced — no discount to its Bitcoin', signal: 'hold' };
    }
    const cls = r.reliable ? signalClass(band.signal) : 'sig-degraded';
    const pct = r.composite === null ? 0 : r.composite / 100;
    const circ = 2 * Math.PI * 52;

    return `
    <section class="card asset-signal-card">
        <h2 class="card-title">VALUATION READ</h2>
        <div class="asset-signal-top">
            <div class="asset-gauge-wrap">
                <svg viewBox="0 0 130 130" class="asset-gauge">
                    <circle cx="65" cy="65" r="52" class="score-ring-bg" stroke-width="9"/>
                    <circle cx="65" cy="65" r="52" class="score-ring-fg ${cls}" stroke-width="9"
                            transform="rotate(-90 65 65)"
                            style="stroke-dasharray:${circ};stroke-dashoffset:${circ * (1 - pct)}"/>
                </svg>
                <div class="asset-gauge-center">
                    <div class="asset-gauge-value">${r.composite === null ? '—' : Math.round(r.composite)}</div>
                </div>
            </div>
            <div class="asset-signal-verdict">
                ${r.validated ? '' : `<div class="unvalidated-flag" title="No historical mNAV exists for this company, so these thresholds cannot be checked against its own past">UNVALIDATED THRESHOLDS</div>`}
                <div class="signal-pill ${cls}">${
                    r.reliable ? band.signal.toUpperCase() : 'NO CALL'}</div>
                <div class="asset-signal-label">${escapeHtml(band.label)}</div>
                <div class="asset-signal-sub">${r.reliable
                    ? 'Relative to the Bitcoin this company holds — not a view on Bitcoin itself.'
                    : 'mNAV unavailable, so the dominant factor is missing.'}</div>
            </div>
        </div>

        <div class="asset-factors">
            ${r.factors.map(f => {
                const w = f.score === null ? 0 : f.score;
                const contributed = f.score === null ? null : f.score * f.weight / 100;
                return `
                <div class="asset-factor${f.score === null ? ' unscored' : ''}">
                    <div class="breakdown-head">
                        <span class="breakdown-label">${escapeHtml(f.label)}</span>
                        <span class="breakdown-points">${
                            contributed === null ? '—' : contributed.toFixed(1)} / ${f.weight}</span>
                    </div>
                    <div class="breakdown-bar-track">
                        <div class="breakdown-bar-fill ${f.score === null ? '' : barClass(f.score)}"
                             style="width:${w}%"></div>
                    </div>
                    <div class="breakdown-detail">${escapeHtml(f.detailText)}${
                        f.damped ? ' <span class="damped-note">· damped: deep discount already reflects this</span>' : ''}</div>
                    ${f.infoKey ? metricInfoHtml(f.infoKey) : ''}
                </div>`;
            }).join('')}
        </div>

        ${metricInfoHtml('valuationRead')}
    </section>`;
}

// ── Historical mNAV reference ───────────────────────────────────────────────
// Reconstructed from SEC XBRL: BTC holdings (us-gaap:CryptoAssetNumberOfUnits)
// x BTC price at that quarter end, against market cap from the share count
// filed at the time.
//
// Deliberately presented as a RANGE, not a percentile. There are only ~6
// quarterly observations (annual until 2025), and a percentile rank over six
// points would be noise dressed as precision. What it can honestly do is show
// whether today's reading is inside or outside what has actually occurred —
// which is the check the thresholds otherwise lacked.
function historicalMnav(companyKey) {
    const t = TREASURIES?.[companyKey];
    const hist = t?.holdingsHistory;
    if (!hist?.length) return null;

    const btcDaily = SERIES?.daily || [];
    if (!btcDaily.length) return null;
    const dayKey = ts => new Date(ts).toISOString().slice(0, 10);
    const btcMap = new Map(btcDaily.map(p => [dayKey(p.ts), p.close]));
    const pxMap = new Map((t.prices || []).map(p => [dayKey(p.ts), p.close]));

    // Quarter ends fall on weekends/holidays, so walk back for the last trade.
    const near = (map, iso) => {
        for (let i = 0; i < 10; i++) {
            const k = new Date(Date.parse(iso) - i * 86400000).toISOString().slice(0, 10);
            if (map.has(k)) return map.get(k);
        }
        return null;
    };

    // Share rows are keyed by cover date (weeks AFTER the period they report),
    // so asking sharesAsOf for the quarter-end timestamp returns the PREVIOUS
    // quarter's count. For serial issuers that is a large, one-sided error, so
    // match the row reporting this same period directly and only fall back to
    // the as-of walk when no such row exists.
    const shareByEnd = new Map(
        (t.sharesHistory || []).map(r => [r.end, r]));

    const points = [];
    for (const h of hist) {
        const sh = shareByEnd.get(h.end) || sharesAsOf(companyKey, h.ts);
        const equityPx = near(pxMap, h.end);
        const btcPx = near(btcMap, h.end);
        if (!sh || !equityPx || !btcPx || !h.btc) continue;
        points.push({
            end: h.end,
            mnav: (equityPx * sh.shares) / (h.btc * btcPx),
            btc: h.btc,
            shares: sh.shares,
        });
    }
    if (points.length < 2) return null;

    const vals = points.map(p => p.mnav);
    return {
        points,
        min: Math.min(...vals),
        max: Math.max(...vals),
        median: [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)],
    };
}

function renderMnavHistory(companyKey, currentMnav) {
    const h = historicalMnav(companyKey);
    if (!h) {
        // Say why rather than omitting the card silently — the absence is
        // itself informative about what the model can and cannot check.
        return `
        <section class="card">
            <h2 class="card-title">HISTORICAL mNAV RANGE</h2>
            <p class="asset-empty">
                This company does not tag its Bitcoin holdings in SEC XBRL
                (us-gaap:CryptoAssetNumberOfUnits), so no historical mNAV can be
                reconstructed — the thresholds cannot be checked against its own past.
            </p>
        </section>`;
    }

    // Position of today's reading on the observed range.
    const span = h.max - h.min;
    const pos = currentMnav !== null && span > 0
        ? clamp((currentMnav - h.min) / span, 0, 1) : null;
    const outside = currentMnav !== null && (currentMnav < h.min || currentMnav > h.max);

    return `
    <section class="card mnav-hist-card">
        <h2 class="card-title">HISTORICAL mNAV RANGE</h2>
        <div class="mnav-range">
            <div class="mnav-range-track">
                <div class="mnav-range-band"></div>
                ${pos !== null ? `<div class="mnav-range-marker" style="left:${pos * 100}%"></div>` : ''}
            </div>
            <div class="mnav-range-labels">
                <span>${h.min.toFixed(2)}× low</span>
                <span class="mnav-range-mid">median ${h.median.toFixed(2)}×</span>
                <span>${h.max.toFixed(2)}× high</span>
            </div>
        </div>
        <p class="asset-note">
            ${currentMnav !== null ? `Today: <strong>${currentMnav.toFixed(2)}×</strong> — ${
                outside
                    ? (currentMnav < h.min
                        ? 'below anything observed in this series.'
                        : 'above anything observed in this series.')
                    : 'within the observed range.'}` : ''}
        </p>
        <div class="table-wrap">
            <table class="backtest-table">
                <thead><tr><th>Quarter end</th><th>BTC held</th><th>Shares outstanding</th><th>mNAV</th></tr></thead>
                <tbody>
                    ${h.points.map(p => `
                        <tr>
                            <td>${escapeHtml(p.end)}</td>
                            <td>${Math.round(p.btc).toLocaleString('en-US')}</td>
                            <td>${(p.shares / 1e6).toFixed(0)}M</td>
                            <td class="${p.mnav < 1 ? 'val-up' : 'val-down'}">${p.mnav.toFixed(2)}×</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>
        <p class="asset-note">
            Reconstructed from SEC XBRL holdings and the share count filed at each
            quarter end. Only ${h.points.length} observations exist (annual until
            2025), so this is a <strong>range check, not a percentile</strong> —
            far too few points to rank against. It exists to show whether the
            scoring thresholds bracket what has actually occurred.
        </p>
        ${metricInfoHtml('mnavHistory')}
    </section>`;
}
