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

// ── CHF → USD ───────────────────────────────────────────────────────────────
//
// The plan is in francs; Bitcoin and both stocks are priced in dollars. The
// card used to divide one by the other as if a franc were a dollar, which
// understated every "how much does this buy" figure by the whole exchange rate
// (about 17% at 1.20 USD per CHF: 0.072 BTC shown where CHF 6,000 bought 0.087).
//
// Kraken's USD/CHF market is live around the clock and answers browsers. The
// two fallbacks are daily reference rates (ECB via Frankfurter, then
// open.er-api.com), close enough for a monthly buy and labelled as daily.
// Checked 2026-10-10: 1.2037 / 1.2033 / 1.2038. If none answers, FX stays null
// and the card says so rather than quietly going back to 1:1.
let FX = null;   // { usdPerChf, source, live, ts }

async function fetchChfRate() {
    const ok = v => Number.isFinite(v) && v > 0.5 && v < 3;
    const sources = [
        async () => {
            const j = await (await fetch('https://api.kraken.com/0/public/Ticker?pair=USDCHF')).json();
            const t = Object.values(j?.result || {})[0];
            const chfPerUsd = parseFloat(t?.c?.[0]);
            return { usdPerChf: 1 / chfPerUsd, source: 'Kraken', live: true };
        },
        async () => {
            const j = await (await fetch('https://api.frankfurter.dev/v1/latest?base=CHF&symbols=USD')).json();
            return { usdPerChf: j?.rates?.USD, source: 'ECB reference rate ' + (j?.date || ''), live: false };
        },
        async () => {
            const j = await (await fetch('https://open.er-api.com/v6/latest/CHF')).json();
            return { usdPerChf: j?.rates?.USD, source: 'open.er-api.com daily rate', live: false };
        },
    ];
    for (const get of sources) {
        try {
            const r = await get();
            if (ok(r.usdPerChf)) { FX = { ...r, ts: Date.now() }; return FX; }
        } catch { /* try the next source */ }
    }
    return FX;   // all failed: keep the last good rate from this session, if any
}

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

        // Use the issuer's own current figures where we have them (MSTR's live
        // API, ASST's weekly 8-K). Filing-derived counts go stale between
        // quarters and understated ASST's mNAV by 13% — which is exactly the
        // error that would send the monthly buy to the wrong name.
        const iss = ISSUER[tab.key];
        const shares  = iss?.shares ?? sh.shares;
        const holdings = iss?.btcHoldings ?? t.btcHoldings;
        const price   = iss?.price ?? last.close;

        const mnav = (price * shares) / (holdings * btcPrice);
        const btcPerUnit = (holdings / shares) / price;

        // Net of everything senior to common. This is the figure both companies
        // publish about themselves, and the only one on which they are
        // genuinely comparable — a wrapper with a large preferred stack looks
        // far cheaper on the gross number than it is.
        // MSTR publishes its net figure directly (netBtcReserve); ASST's is
        // derived in issuer.js from its 8-K. Fall back to the published mNAV
        // when only that is available.
        const netNav = iss?.netNav ?? iss?.netBtcReserve ?? null;
        const mnavNet = (netNav && netNav > 0)
            ? (price * shares) / netNav
            : (iss?.mnavPublished ?? null);
        const netUplift = (netNav && netNav > 0)
            ? ((netNav / btcPrice) / shares) / price * btcPrice : null;

        out.push({
            key: tab.key, label: tab.label, ticker: tab.ticker,
            mnav, mnavNet, price,
            uplift: btcPerUnit / (1 / btcPrice),
            netUplift,
            live: !!iss,
            asOf: iss?.asOf ? String(iss.asOf).slice(0, 10) : null,
            validated: (t.holdingsHistory?.length || 0) >= 2,
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
    // Francs to dollars before dividing by a dollar price. null when no rate
    // could be fetched — the amounts are then left out, not guessed.
    const fx = FX?.usdPerChf ?? null;
    const usd = chf => fx === null ? null : chf * fx;
    const shares = fx === null ? null : usd(P.treasury) / best.price;
    const btcUnits = fx === null ? null : usd(P.btc) / a.btcPrice;
    const noFx = `${P.currency} exchange rate unavailable — amount not shown`;

    const age = a.age;
    const stale = age && age.sessionsBehind >= 1;

    // Collapsed by default is wrong — this is the card that answers "what do I
    // buy this month". But at 505px it pushed the score gauge and the cycle
    // chart entirely below the fold on a 900px screen, so it can be folded down
    // to a one-line summary that still carries the decision. The choice is
    // remembered per browser; a failure to read it just means "expanded".
    let collapsed = false;
    try { collapsed = localStorage.getItem('cycletide_alloc_collapsed') === '1'; } catch {}

    // The summary has to stand alone when the body is hidden: amount, ticker,
    // and the mNAV that justified it.
    const summary = worthIt
        ? `${P.currency} ${P.treasury.toLocaleString()} \u2192 ${escapeHtml(best.ticker)} at ${best.mnav.toFixed(2)}\u00d7 mNAV`
        : `${P.currency} ${P.treasury.toLocaleString()} \u2192 spot \u2014 no wrapper below 0.95\u00d7`;

    host.innerHTML = `
    <section class="card alloc-card${collapsed ? ' alloc-collapsed' : ''}">
        <button class="alloc-head" id="allocToggle" aria-expanded="${!collapsed}"
                aria-controls="allocBody" title="${collapsed ? 'Show' : 'Hide'} allocation detail">
            <span class="disclosure" aria-hidden="true">${collapsed ? '\u25b8' : '\u25be'}</span>
            <span class="card-title">THIS MONTH'S ALLOCATION</span>
            <span class="alloc-summary">${P.currency} ${P.btc.toLocaleString()} \u2192 BTC
                <span class="alloc-sep">\u00b7</span> ${summary}</span>
        </button>
        <div id="allocBody" class="alloc-body"${collapsed ? ' hidden' : ''}>
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
                <span class="alloc-detail">${btcUnits === null
                    ? `at ${fmtUSD(a.btcPrice)} · ${noFx}`
                    : `≈ ${btcUnits.toFixed(5)} BTC at ${fmtUSD(a.btcPrice)} · ${P.currency} ${P.btc.toLocaleString()} = ${fmtUSD(usd(P.btc))}`}</span>
            </div>
            <div class="alloc-row${worthIt ? '' : ' alloc-skip'}">
                <span class="alloc-amt">${P.currency} ${P.treasury.toLocaleString()}</span>
                <span class="alloc-target">${worthIt
                    ? escapeHtml(best.label) + ' <span class="alloc-tick">' + escapeHtml(best.ticker) + '</span>'
                    : 'Bitcoin <span class="alloc-tick">spot</span> — neither at a discount'}</span>
                <span class="alloc-detail">${worthIt
                    ? (shares === null
                        ? `at ${fmtEq(best.price)} · ${noFx}`
                        : `≈ ${shares.toFixed(1)} shares at ${fmtEq(best.price)} · ${P.currency} ${P.treasury.toLocaleString()} = ${fmtUSD(usd(P.treasury))}`)
                      + ` · ${best.uplift.toFixed(2)}× the BTC exposure of spot`
                    : 'both at or above 0.95× mNAV, so the wrapper buys no extra Bitcoin'}</span>
            </div>
        </div>
        <p class="alloc-fx">${fx === null
            ? `No ${P.currency}/USD rate could be fetched, so the amounts above are left out. The comparison below does not depend on it.`
            : `1 ${P.currency} = ${fx.toFixed(4)} USD · ${escapeHtml(FX.source)}${FX.live ? ', live' : ''}. Bitcoin is ${P.currency} ${Math.round(a.btcPrice / fx).toLocaleString()}.`}</p>

        <div class="table-wrap">
            <table class="backtest-table alloc-compare">
                <thead><tr><th>Route</th><th>mNAV</th><th>Net mNAV</th>
                    <th title="How much Bitcoin price movement one ${P.currency} gives you, relative to buying spot. Includes Bitcoin funded by debt and preferred, so part of it is leverage.">BTC exposure / ${P.currency}</th>
                    <th title="How much Bitcoin one ${P.currency} actually owns after debt and preferred are paid, relative to buying spot.">BTC owned / ${P.currency}</th>
                    <th></th></tr></thead>
                <tbody>
                    ${a.candidates.map(c => `
                        <tr class="${(c === best && worthIt) ? 'alloc-picked' : ''}">
                            <td>${escapeHtml(c.label)} <span class="alloc-tick">${escapeHtml(c.ticker)}</span>${
                                c.validated ? '' : ' <span class="alloc-unval" title="Fewer than two dated holdings observations could be built from this company’s filings, so its thresholds cannot be checked against its own past">unvalidated</span>'}</td>
                            <td class="${c.mnav < 1 ? 'val-up' : 'val-down'}">${c.mnav.toFixed(2)}×</td>
                            <td class="${c.mnavNet === null ? '' : (c.mnavNet < 1 ? 'val-up' : 'val-down')}"
                                title="Market cap over Bitcoin value after debt and preferred">${
                                c.mnavNet === null ? '—' : c.mnavNet.toFixed(2) + '×'}</td>
                            <td>${c.uplift.toFixed(2)}×</td>
                            <td class="${c.netUplift === null ? '' : (c.netUplift >= 1 ? 'val-up' : 'val-down')}">${
                                c.netUplift === null ? '—' : c.netUplift.toFixed(2) + '×'}</td>
                            <td>${(c === best && worthIt) ? '← cheaper' : ''}</td>
                        </tr>`).join('')}
                    <tr class="${worthIt ? '' : 'alloc-picked'}">
                        <td>Bitcoin <span class="alloc-tick">spot</span></td>
                        <td>—</td><td>—</td><td>1.00×</td><td>1.00×</td>
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
        <p class="asset-note">
            <strong>Exposure is not ownership.</strong> Part of each company's Bitcoin
            is funded by debt and preferred stock that are paid before common
            shareholders, so a ${P.currency} of stock moves with more Bitcoin than it
            owns. That is leverage: it adds upside when Bitcoin rises and brings the
            point where common is wiped out closer when it falls. The rule above
            compares <em>exposure</em>. ${(() => {
                const owners = a.candidates.filter(c => c.netUplift !== null && c.netUplift >= 1);
                return owners.length
                    ? `On <em>ownership</em>, ${owners.map(c => escapeHtml(c.label)).join(' and ')}
                       also beat${owners.length === 1 ? 's' : ''} spot today — more Bitcoin owned
                       per ${P.currency} as well as more exposure.`
                    : `On <em>ownership</em> neither company beats buying spot today — you pay
                       a premium for the leverage and for whatever the company adds by issuing
                       stock above its backing.`;
            })()}
        </p>
        ${metricInfoHtml('allocation')}
        </div>
    </section>`;

    document.getElementById('allocToggle')?.addEventListener('click', () => {
        const next = !host.querySelector('.alloc-card').classList.contains('alloc-collapsed');
        try { localStorage.setItem('cycletide_alloc_collapsed', next ? '1' : '0'); } catch {}
        renderAllocation();
    });

    // The card can render before any tab is opened, so bind here too — the
    // guard inside makes repeat calls harmless.
    if (typeof bindMetricToggles === 'function') bindMetricToggles();
}
