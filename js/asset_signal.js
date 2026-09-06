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

function assetSignalBands(score) {
    if (score === null) return { label: 'No call', signal: 'hold' };
    if (score >= 70) return { label: 'Cheap vs its Bitcoin', signal: 'accumulate' };
    if (score >= 45) return { label: 'Fairly priced',        signal: 'hold' };
    if (score >= 25) return { label: 'Rich vs its Bitcoin',  signal: 'distribute' };
    return { label: 'Expensive vs its Bitcoin', signal: 'distribute' };
}

// Requires the dominant factor: an "ACCUMULATE" driven only by the two minor
// factors, with mNAV missing, would be an unsupported call.
const ASSET_MIN_WEIGHT = 0.6;

function computeAssetSignal(ctx) {
    // A price crash makes all three factors fire negative at once — but
    // "treasury underwater" and "underperformed BTC" are largely CONSEQUENCES
    // of the price falling, which is the same event the discount already
    // reflects. Left unadjusted the model punishes one event three times, so a
    // company trading at a fifth of its Bitcoin could still read HOLD.
    //
    // Below 0.7x mNAV the two consequence factors are progressively pulled
    // toward neutral (50). At 0.3x they are almost entirely damped, letting
    // the discount speak for itself; above 0.7x nothing changes.
    const m = ctx.mnav;
    const damp = (m !== null && m !== undefined && m < 0.7)
        ? clamp((0.7 - m) / 0.4, 0, 1)
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

    return { composite, confidence, factors, reliable, mnavAvailable };
}

function renderAssetSignal(ctx) {
    const r = computeAssetSignal(ctx);
    const band = assetSignalBands(r.reliable ? r.composite : null);
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
