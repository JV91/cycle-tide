// ── Cycle Tide — satoshis per share, and the RATE it changes ────────────────
//
// The dashboard already shows BTC per share as a level. The level alone is not
// the interesting part: what matters for a multi-year hold is how fast it
// grows, because that is the only driver that compounds instead of oscillating.
//
// Why this earns its own card. Decomposing MSTR's price into its four
// arithmetic drivers — price = mNAV x (BTC/share) x BTCprice — and measuring
// each driver's share of the move over rolling windows (925 daily observations,
// 2023-01 to 2026-09):
//
//     horizon    mNAV    BTC px   stack    dilution   stack+dilution
//     1 month    48.0%   38.7%     4.6%     8.8%        13.4%
//     1 year     28.2%   26.7%    28.5%    16.5%        45.1%
//     2 years    17.8%   23.2%    38.3%    20.7%        59.0%
//
// mNAV dominates the short run and fades; stack growth net of dilution — which
// is exactly satoshis per share — dominates the long run. The reason is that
// mNAV mean-reverts and BTC per share does not. Correlation between mNAV level
// and its own forward change: -0.25 at 1 month, -0.50 at 6 months, -0.75 at
// 1 year. A driver that reverts contributes noise that cancels over time; one
// that accumulates compounds.
//
// The catch, and why this card sits NEXT TO mNAV rather than replacing it:
// accretion is a FUNCTION of mNAV. Issuing stock above 1.0x buys more Bitcoin
// than it dilutes; below 1.0x it destroys BTC per share. So mNAV is not a
// return driver so much as the switch that governs whether the return driver
// still works. Both numbers are needed, and the card says so.

// Growth is computed between filed quarters only. Interpolating daily would
// invent precision: holdings are stamped at period end, share counts at a
// cover date weeks later, so a daily series shows sawtooth artefacts that are
// an artefact of the calendar rather than anything the company did.
function accretionSeries(companyKey) {
    const t = TREASURIES?.[companyKey];
    const hist = t?.holdingsHistory;
    if (!hist?.length) return null;

    const shareByEnd = new Map((t.sharesHistory || []).map(r => [r.end, r]));
    const points = [];
    for (const h of hist) {
        const sh = shareByEnd.get(h.end);
        if (!sh || !h.btc) continue;
        points.push({
            end: h.end,
            ts: Date.parse(h.end + 'T00:00:00Z'),
            btc: h.btc,
            shares: sh.shares,
            sats: (h.btc / sh.shares) * 1e8,
        });
    }
    if (points.length < 2) return null;

    // Annualise each step so periods of different length are comparable — the
    // series mixes annual (10-K) and quarterly (10-Q) gaps.
    for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const years = (b.ts - a.ts) / (365.25 * 86400000);
        b.growth = b.sats / a.sats - 1;
        b.cagr = years > 0 ? Math.pow(b.sats / a.sats, 1 / years) - 1 : null;
        b.years = years;
    }

    const first = points[0], last = points[points.length - 1];
    const totalYears = (last.ts - first.ts) / (365.25 * 86400000);
    return {
        points,
        latest: last,
        totalChange: last.sats / first.sats - 1,
        totalCagr: totalYears > 0 ? Math.pow(last.sats / first.sats, 1 / totalYears) - 1 : null,
        totalYears,
        recentCagr: last.cagr,
    };
}

function fmtSats(v) {
    return Math.round(v).toLocaleString();
}

function fmtRate(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    const pct = v * 100;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${Math.abs(pct) >= 10 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

function renderAccretion(companyKey, currentMnav) {
    const a = accretionSeries(companyKey);
    if (!a) {
        // Say why rather than dropping the card: the absence is informative.
        // Strive never tags a coin count in XBRL, so no per-share history can
        // be built for it at all — that is a real limitation of the company's
        // disclosure, not a gap in the fetch.
        const why = TREASURIES?.[companyKey]?.holdingsHistory?.length
            ? 'Not enough filed quarters pair a coin count with a share count.'
            : 'This company does not tag its Bitcoin holdings in XBRL, so no '
              + 'per-share history can be reconstructed from filings.';
        return `
        <section class="card">
            <h2 class="card-title">SATOSHIS PER SHARE — GROWTH</h2>
            <p class="asset-empty">${why}</p>
        </section>`;
    }

    const rows = a.points.slice(1).reverse();          // newest first, skip the base
    const rate = a.recentCagr;

    // Below 1.0x mNAV, issuing stock destroys BTC per share. That is the single
    // most important piece of context for reading the rate, so it is stated
    // inline rather than left to the reader to connect.
    const dilutive = currentMnav !== null && currentMnav !== undefined && currentMnav < 1;

    let verdict, tone;
    if (rate === null) { verdict = 'Not enough history.'; tone = 'warn'; }
    else if (rate <= 0) { verdict = 'Shrinking — issuance is outpacing accumulation.'; tone = 'bad'; }
    else if (rate < 0.10) { verdict = 'Barely growing.'; tone = 'warn'; }
    else if (rate < 0.30) { verdict = 'Growing steadily.'; tone = 'good'; }
    else { verdict = 'Growing fast.'; tone = 'good'; }

    return `
    <section class="card">
        <h2 class="card-title">SATOSHIS PER SHARE — GROWTH</h2>

        <div class="accretion-hero">
            <div class="accretion-main">
                <div class="accretion-value">${fmtSats(a.latest.sats)}</div>
                <div class="accretion-label">sats per share</div>
            </div>
            <div class="accretion-main">
                <div class="accretion-value tone-${tone}">${fmtRate(rate)}</div>
                <div class="accretion-label">latest quarter, annualised</div>
            </div>
            <div class="accretion-main">
                <div class="accretion-value">${fmtRate(a.totalCagr)}</div>
                <div class="accretion-label">since ${a.points[0].end.slice(0, 7)}, annualised</div>
            </div>
        </div>

        <p class="accretion-read tone-${tone}">${verdict}</p>

        ${dilutive ? `<p class="accretion-warn">
            At <strong>${currentMnav.toFixed(2)}×</strong> mNAV every $1 of stock issued
            buys about <strong>${(currentMnav * 100).toFixed(0)}¢</strong> of Bitcoin per
            existing share, so raising equity here <em>reduces</em> this number. Accretion
            resumes only once the discount closes — which is why the multiple still
            matters even though it is a poor guide to long-run returns.
        </p>` : `<p class="accretion-note">
            Above 1.0× mNAV, issuing stock buys more Bitcoin than it dilutes, so
            equity raises push this number up. That is the flywheel working.
        </p>`}

        <div class="table-wrap">
            <table class="backtest-table">
                <thead><tr>
                    <th>Quarter end</th><th>Sats / share</th><th>Change</th><th>Annualised</th>
                </tr></thead>
                <tbody>
                    ${rows.map(p => `
                        <tr>
                            <td>${p.end}</td>
                            <td>${fmtSats(p.sats)}</td>
                            <td class="${p.growth >= 0 ? 'val-up' : 'val-down'}">${fmtRate(p.growth)}</td>
                            <td class="${p.cagr >= 0 ? 'val-up' : 'val-down'}">${fmtRate(p.cagr)}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>

        <p class="asset-note">
            Computed only between filed quarters — holdings are stamped at period
            end and share counts at a cover date some weeks later, so a daily
            series would show sawtooth steps that reflect the filing calendar
            rather than anything the company did. Annualised figures scale each
            step by its own length, because the series mixes annual (10-K) and
            quarterly (10-Q) gaps.
        </p>
        ${metricInfoHtml('satsPerShare')}
    </section>`;
}
