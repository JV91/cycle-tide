// ── Cycle Tide — BTC backing per share, projected ───────────────────────────
//
// Deliberately NOT a share-price forecast. A price projection would need three
// stacked assumptions on top of the BTC band: future mNAV, future dilution,
// and future holdings. mNAV alone swings the answer ~2.9x (0.7x to 2.0x), and
// the market decides it — so a price line would be dominated by the least
// knowable input while looking authoritative.
//
// What IS projectable is the intrinsic backing: how much Bitcoin sits behind
// one share, valued at a given BTC price. That is arithmetic, not forecasting:
//
//     BTC value per share = (BTC held x BTC price) / shares outstanding
//
// The market price is then that number multiplied by whatever mNAV the market
// grants — currently 0.73x for MSTR, 1.01x for ASST. Separating the two keeps
// the knowable part clean and leaves the unknowable part visible as a
// multiplier rather than buried inside a single confident-looking line.
//
// Dilution is the factor that actually decides these outcomes, so it is an
// explicit input rather than an assumption hidden in the maths. MSTR has
// issued shares at roughly 40%/yr; at that rate a 3x rise in Bitcoin barely
// moves the backing per share.

const ASSET_DILUTION_DEFAULTS = {
    // Reasoned defaults, not fitted. MSTR's own recent run-rate is ~40%/yr;
    // that is used as-is. ASST's raw history spans a reverse split and the
    // Strive merger, so its measured rate (~386%/yr) is meaningless as a
    // forward assumption — a deliberately conservative placeholder is used
    // instead, and the UI says so.
    MSTR: { pct: 40, basis: 'measured: ~40%/yr over the last 2 years' },
    ASST: { pct: 25, basis: 'placeholder — measured history is distorted by a reverse split and the merger' },
};

function dilutionInputFor(key) {
    const el = document.getElementById('assumeDilution');
    const v = el ? parseFloat(el.value) : NaN;
    if (!isNaN(v)) return v;
    return ASSET_DILUTION_DEFAULTS[key]?.pct ?? 0;
}

// ── Empirical: how the stock has actually moved with Bitcoin ────────────────
// Beta from daily log returns over the treasury era. This is a second,
// INDEPENDENT estimate: the backing calculation is bottom-up arithmetic on the
// balance sheet, while beta is top-down observed behaviour. They embed
// different things — beta already contains historical dilution and mNAV
// swings, the arithmetic does not — so where they disagree, the gap is
// informative rather than an error to reconcile away.
function computeBeta(key) {
    const px = treasuryEra(key);
    const btc = SERIES?.daily || [];
    if (px.length < 60 || !btc.length) return null;

    // Match on calendar date, not raw timestamp: equity bars are stamped at
    // the US market open (13:30 UTC) while BTC candles are midnight UTC, so
    // exact-timestamp lookups never hit.
    const dayKey = ts => new Date(ts).toISOString().slice(0, 10);
    const bmap = new Map(btc.map(p => [dayKey(p.ts), p.close]));
    const ra = [], rb = [];
    for (let i = 1; i < px.length; i++) {
        const b1 = bmap.get(dayKey(px[i].ts)), b0 = bmap.get(dayKey(px[i - 1].ts));
        if (!b1 || !b0) continue;
        const a = Math.log(px[i].close / px[i - 1].close);
        const b = Math.log(b1 / b0);
        if (isFinite(a) && isFinite(b)) { ra.push(a); rb.push(b); }
    }
    if (ra.length < 60) return null;

    const mean = x => x.reduce((s, v) => s + v, 0) / x.length;
    const ma = mean(ra), mb = mean(rb);
    let cov = 0, varb = 0, va = 0;
    for (let i = 0; i < ra.length; i++) {
        cov += (ra[i] - ma) * (rb[i] - mb);
        varb += (rb[i] - mb) ** 2;
        va += (ra[i] - ma) ** 2;
    }
    if (varb === 0) return null;
    return {
        beta: cov / varb,
        corr: cov / Math.sqrt(va * varb),
        vol: Math.sqrt(va / ra.length) * Math.sqrt(365),
        btcVol: Math.sqrt(varb / rb.length) * Math.sqrt(365),
        days: ra.length,
    };
}

// Beta-implied price: apply the observed amplification to the BTC move.
// Uses log returns so a large move compounds correctly rather than scaling
// linearly, which would badly overstate multi-hundred-percent scenarios.
function betaImpliedPrice(currentPrice, btcNow, btcTarget, beta) {
    if (!currentPrice || !btcNow || !btcTarget || beta === null) return null;
    const btcLogReturn = Math.log(btcTarget / btcNow);
    return currentPrice * Math.exp(beta * btcLogReturn);
}

// Backing per share at a given BTC price, after n years of dilution.
function backingPerShare(holdings, shares, btcPrice, dilutionPct, years) {
    if (!holdings || !shares || !btcPrice) return null;
    const futureShares = shares * Math.pow(1 + dilutionPct / 100, years);
    return (holdings * btcPrice) / futureShares;
}

// Scenarios reuse the BTC tab's own assumptions so the two views cannot
// silently disagree about where Bitcoin goes.
function assetProjectionScenarios(key, ctx) {
    const A = typeof priceAssumptions === 'function' ? priceAssumptions() : null;
    const dates = typeof projectCycleDates === 'function' ? projectCycleDates() : null;
    if (!A || !dates || !ctx.holdings || !ctx.shares) return null;

    const dil = dilutionInputFor(key);
    const now = Date.now();
    const yearsTo = ts => Math.max(0, (ts - now) / (365.25 * 86400000));

    const rows = [
        {
            label: 'Today',
            when: '',
            btc: ctx.btcPrice,
            years: 0,
        },
        {
            label: 'Projected cycle bottom',
            when: new Date(dates.currentBottom.ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short' }),
            btc: A.bottomUSD,
            years: yearsTo(dates.currentBottom.ts),
        },
        {
            label: 'Projected next top',
            when: new Date(dates.nextTop.ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short' }),
            btc: A.nextTopUSD,
            years: yearsTo(dates.nextTop.ts),
        },
    ];

    const beta = computeBeta(key);

    return {
        dilutionPct: dil,
        beta,
        rows: rows.map(r => {
            const noDil = backingPerShare(ctx.holdings, ctx.shares, r.btc, 0, 0);
            const withDil = backingPerShare(ctx.holdings, ctx.shares, r.btc, dil, r.years);
            return {
                ...r,
                backingNoDilution: noDil,
                backing: withDil,
                // What the market would pay at today's mNAV — shown as a
                // secondary column, clearly flagged as mNAV-dependent.
                atCurrentMnav: withDil !== null && ctx.mnav ? withDil * ctx.mnav : null,
                betaImplied: beta ? betaImpliedPrice(ctx.price, ctx.btcPrice, r.btc, beta.beta) : null,
            };
        }),
    };
}

function renderAssetProjection(key, ctx) {
    const p = assetProjectionScenarios(key, ctx);
    if (!p) return '';
    const def = ASSET_DILUTION_DEFAULTS[key];

    return `
    <section class="card asset-proj-card">
        <h2 class="card-title">BITCOIN BACKING PER SHARE — PROJECTED</h2>
        <p class="asset-note asset-proj-lede">
            What the Bitcoin behind one share would be worth under the Bitcoin
            assumptions set on the Bitcoin tab. This is arithmetic, not a share
            price forecast — the market price is this figure multiplied by
            whatever mNAV the market grants, which it decides, not the model.
        </p>

        <div class="table-wrap">
            <table class="backtest-table">
                <thead>
                    <tr>
                        <th>Scenario</th>
                        <th>BTC price</th>
                        <th>Backing / share</th>
                        <th>After dilution</th>
                        <th>At today's ${ctx.mnav ? ctx.mnav.toFixed(2) : '—'}x mNAV</th>
                        ${p.beta ? `<th>Beta-implied</th>` : ''}
                    </tr>
                </thead>
                <tbody>
                    ${p.rows.map(r => `
                        <tr>
                            <td>${escapeHtml(r.label)}${r.when ? ` <span class="proj-when">${escapeHtml(r.when)}</span>` : ''}</td>
                            <td>${fmtUSD(r.btc)}</td>
                            <td>${r.backingNoDilution !== null ? fmtEq(r.backingNoDilution) : '—'}</td>
                            <td class="${r.years > 0 ? 'val-down' : ''}">${
                                r.years > 0 && r.backing !== null ? fmtEq(r.backing) : (r.years === 0 ? '—' : '—')}</td>
                            <td>${r.atCurrentMnav !== null ? fmtEq(r.atCurrentMnav) : '—'}</td>
                            ${p.beta ? `<td class="beta-col">${
                                r.betaImplied !== null ? fmtEq(r.betaImplied) : '—'}</td>` : ''}
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>

        ${p.beta ? `
        <div class="beta-block">
            <span class="info-label">Second estimate — observed behaviour</span>
            <p class="asset-note">
                Over ${p.beta.days} trading days since the treasury era began,
                ${escapeHtml(key)} has moved with a <strong>beta of ${p.beta.beta.toFixed(2)}</strong>
                to Bitcoin (correlation ${p.beta.corr.toFixed(2)}, annualised volatility
                ${(p.beta.vol * 100).toFixed(0)}% against Bitcoin's ${(p.beta.btcVol * 100).toFixed(0)}%).
                The beta-implied column applies that amplification to each Bitcoin
                scenario, compounded in log space.
                ${p.beta.corr < 0.6 ? `<strong>Correlation is only ${p.beta.corr.toFixed(2)}</strong>, so
                beta explains less than half this stock's movement — treat that column as weak.` : ''}
            </p>
            <p class="asset-note">
                The two estimates are independent and will disagree. Beta already
                contains past dilution and mNAV swings; the backing calculation
                contains neither. Where they diverge, the gap is the market's
                changing willingness to pay a premium — not an error in either.
            </p>
        </div>` : ''}

        <div class="proj-assumptions asset-dilution">
            <span class="proj-label">Dilution assumption</span>
            <label>Share growth
                <input type="number" id="assumeDilution" value="${p.dilutionPct}" step="5" min="0" max="500">
                %/yr
            </label>
            <button id="resetDilution" class="refresh-btn">Reset</button>
        </div>
        ${(() => {
            const top = p.rows[p.rows.length - 1];
            if (!top || !top.years || !top.backingNoDilution || !top.backing) return '';
            const shareMul = Math.pow(1 + p.dilutionPct / 100, top.years);
            const btcMul = ctx.btcPrice ? top.btc / ctx.btcPrice : null;
            const netMul = top.backing / (p.rows[0].backingNoDilution || 1);
            return `<p class="asset-note dilution-maths">
                <strong>Why the projected line is not higher:</strong> Bitcoin rising
                ${btcMul ? btcMul.toFixed(2) + 'x' : '—'} lifts the backing per share by the
                same multiple, but at ${p.dilutionPct}%/yr the share count grows
                ${shareMul.toFixed(2)}x over ${top.years.toFixed(1)} years. Net effect on
                what one share represents: <strong>${netMul.toFixed(2)}x</strong>. Dilution
                is doing more work here than the Bitcoin price.
            </p>`;
        })()}
        <p class="asset-note">
            Default for ${escapeHtml(key)}: ${escapeHtml(def?.basis || '')}.
            Dilution is the factor that decides these outcomes — at 40%/yr a
            near-3x rise in Bitcoin barely moves the backing per share, because
            the coins are spread across proportionally more shares. Issuance is
            only accretive while mNAV is above 1.0x.
        </p>

        ${metricInfoHtml('backingPerShare')}
    </section>`;
}

// Debounced re-render on assumption change, matching the BTC projection inputs.
function bindDilutionInput() {
    const root = document.getElementById('assetView');
    if (!root || root._dilBound) return;
    root._dilBound = true;
    let t = null;
    root.addEventListener('input', e => {
        if (e.target.id !== 'assumeDilution') return;
        clearTimeout(t);
        t = setTimeout(() => renderAssetView(activeTab), 350);
    });
    root.addEventListener('click', e => {
        if (e.target.id !== 'resetDilution') return;
        const el = document.getElementById('assumeDilution');
        if (el) el.value = ASSET_DILUTION_DEFAULTS[activeTab]?.pct ?? 0;
        renderAssetView(activeTab);
    });
}
