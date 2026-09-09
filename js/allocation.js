// ── Cycle Tide — monthly allocation helper ─────────────────────────────────
//
// Answers one question: this month, where does the treasury slice go?
//
// The rule is "buy the bigger discount": whichever of MSTR/ASST trades at the
// lower mNAV gets the allocation. That targets the mechanism that actually
// produced returns in these names — buying assets below the value of the coins
// and being paid when the discount closes — rather than chasing whichever
// happened to run recently, which is buying AFTER the re-rating is spent.
//
// Backtested monthly over Strive's treasury era (Oct 2025 - Aug 2026), 2k/mo:
//     pick-cheaper   +76%
//     50/50 split    +42%
//     always MSTR     -2%
// It also correctly refused Strive while it traded at 9-16x mNAV in late 2025.
//
// Caveat kept visible in the UI: eleven months across one partial cycle is a
// thin sample, and "always ASST" scored higher in hindsight (+85%). The rule is
// justified by its mechanism, not by that backtest alone.

const ALLOC_PLAN = {
    monthlyTotal: 8000,
    currency: 'CHF',
    btc: 6000,        // straight to spot, on the 1st
    treasury: 2000,   // to whichever treasury company is cheaper
};

// Below this, a wrapper buys meaningfully more Bitcoin than spot. At or above
// it, you are taking equity/dilution/single-name risk for no extra exposure.
const ALLOC_MIN_DISCOUNT = 0.95;

// How old is the equity price data? BTC streams live but equity prices come
// from a committed snapshot, so the two can drift apart. A 7% stale MSTR price
// moved mNAV by 7.6% — enough to mislead, so the age is surfaced rather than
// left for the reader to assume.
function equityDataAge() {
    let newest = 0;
    for (const tab of ASSET_TABS) {
        if (tab.key === 'BTC') continue;
        const px = EQUITY[tab.key];
        if (px?.length) newest = Math.max(newest, px[px.length - 1].ts);
    }
    if (!newest) return null;
    // Compare to the last weekday: a Saturday reading of a Friday bar is fresh.
    const now = new Date();
    let ref = new Date(now);
    while (ref.getUTCDay() === 0 || ref.getUTCDay() === 6) ref.setUTCDate(ref.getUTCDate() - 1);
    const days = Math.floor((Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate())
        - Date.UTC(new Date(newest).getUTCFullYear(), new Date(newest).getUTCMonth(), new Date(newest).getUTCDate()))
        / 86400000);
    return { ts: newest, sessionsBehind: Math.max(0, days) };
}

function allocationCandidates() {
    const btcPrice = SERIES?.daily?.length
        ? SERIES.daily[SERIES.daily.length - 1].close : null;
    if (!btcPrice || !TREASURIES) return null;

    const out = [];
    for (const tab of ASSET_TABS) {
        if (tab.key === 'BTC') continue;
        const t = TREASURIES[tab.key];
        const px = EQUITY[tab.key];
        if (!t?.btcHoldings || !px?.length) continue;
        const last = px[px.length - 1];
        const sh = sharesAsOf(tab.key, last.ts);
        if (!sh) continue;

        const mnav = (last.close * sh.shares) / (t.btcHoldings * btcPrice);
        const btcPerUnit = (t.btcHoldings / sh.shares) / last.close;
        out.push({
            key: tab.key, label: tab.label, ticker: tab.ticker,
            mnav, price: last.close,
            uplift: btcPerUnit / (1 / btcPrice),
            validated: !!t.holdingsHistory?.length,
        });
    }
    if (!out.length) return null;
    out.sort((a, b) => a.mnav - b.mnav);
    return { btcPrice, candidates: out, age: equityDataAge() };
}

function renderAllocation() {
    const host = document.getElementById('allocationCard');
    if (!host) return;
    const a = allocationCandidates();
    if (!a) { host.innerHTML = ''; return; }

    const best = a.candidates[0];
    const P = ALLOC_PLAN;
    const worthIt = best.mnav < ALLOC_MIN_DISCOUNT;
    const shares = P.treasury / best.price;
    const btcUnits = P.btc / a.btcPrice;

    const age = a.age;
    const stale = age && age.sessionsBehind >= 1;

    host.innerHTML = `
    <section class="card alloc-card">
        <h2 class="card-title">THIS MONTH'S ALLOCATION</h2>
        ${stale ? `<p class="alloc-stale">
            Equity prices are from ${new Date(age.ts).toISOString().slice(0, 10)},
            ${age.sessionsBehind} trading session${age.sessionsBehind === 1 ? '' : 's'} behind.
            Bitcoin is live, so the mNAV figures below are approximate — a 7% move in
            the share price shifts mNAV by about the same amount. Re-run
            <code>node scripts/snapshot-treasuries.mjs</code> (or wait for the daily
            workflow) before acting on the exact numbers.
        </p>` : ''}
        <div class="alloc-rows">
            <div class="alloc-row">
                <span class="alloc-amt">${P.currency} ${P.btc.toLocaleString()}</span>
                <span class="alloc-target">Bitcoin <span class="alloc-tick">spot</span></span>
                <span class="alloc-detail">≈ ${btcUnits.toFixed(5)} BTC at ${fmtUSD(a.btcPrice)}</span>
            </div>
            <div class="alloc-row${worthIt ? '' : ' alloc-skip'}">
                <span class="alloc-amt">${P.currency} ${P.treasury.toLocaleString()}</span>
                <span class="alloc-target">${worthIt
                    ? escapeHtml(best.label) + ' <span class="alloc-tick">' + escapeHtml(best.ticker) + '</span>'
                    : 'Bitcoin <span class="alloc-tick">spot</span> — neither at a discount'}</span>
                <span class="alloc-detail">${worthIt
                    ? `≈ ${shares.toFixed(1)} shares at ${fmtEq(best.price)} · ${best.uplift.toFixed(2)}× the BTC exposure of spot`
                    : 'both at or above 0.95× mNAV, so the wrapper buys no extra Bitcoin'}</span>
            </div>
        </div>

        <div class="table-wrap">
            <table class="backtest-table alloc-compare">
                <thead><tr><th>Route</th><th>mNAV</th><th>BTC per ${P.currency}</th><th></th></tr></thead>
                <tbody>
                    ${a.candidates.map(c => `
                        <tr class="${(c === best && worthIt) ? 'alloc-picked' : ''}">
                            <td>${escapeHtml(c.label)} <span class="alloc-tick">${escapeHtml(c.ticker)}</span>${
                                c.validated ? '' : ' <span class="alloc-unval" title="No historical mNAV exists for this company, so its thresholds cannot be checked against its own past">unvalidated</span>'}</td>
                            <td class="${c.mnav < 1 ? 'val-up' : 'val-down'}">${c.mnav.toFixed(2)}×</td>
                            <td>${c.uplift.toFixed(2)}×</td>
                            <td>${(c === best && worthIt) ? '← cheaper' : ''}</td>
                        </tr>`).join('')}
                    <tr class="${worthIt ? '' : 'alloc-picked'}">
                        <td>Bitcoin <span class="alloc-tick">spot</span></td>
                        <td>—</td><td>1.00×</td>
                        <td>${worthIt ? '' : '← no discount available'}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <p class="asset-note">
            The treasury slice goes to whichever company trades at the bigger
            discount to the Bitcoin it holds — buying coins below their value,
            rather than chasing whichever name has run recently. When neither is
            below 0.95× it goes to spot instead: at parity a wrapper adds equity,
            dilution and single-company risk while buying no extra Bitcoin.
        </p>
        ${metricInfoHtml('allocation')}
    </section>`;
}
