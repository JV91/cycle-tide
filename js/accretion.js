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

    // Weekly 8-K rows (Strive) are kept out of the step series except the most
    // recent one: annualising a single week turns a 3.5% week into several
    // hundred percent a year. Quarter ends plus the latest 8-K keeps each step
    // about a quarter long while the newest point is still current.
    const weekly = hist.filter(h => h.source === '8-K');
    const rows = hist.filter(h => h.source !== '8-K');
    if (weekly.length) rows.push(weekly[weekly.length - 1]);

    const shareByEnd = new Map((t.sharesHistory || []).map(r => [r.end, r]));
    const points = [];
    for (const h of rows) {
        const shares = h.shares ?? shareByEnd.get(h.end)?.shares;
        if (!shares || !h.btc) continue;
        points.push({
            end: h.end,
            ts: Date.parse(h.end + 'T00:00:00Z'),
            btc: h.btc,
            shares,
            sats: (h.btc / shares) * 1e8,
            source: h.source || 'xbrl',
        });
    }
    points.sort((a, b) => a.ts - b.ts);

    // A live point after the last filing, where the issuer publishes current
    // holdings and a share count on the same basis as the filings (shares that
    // exist: Strategy's market cap / price). Without it the rate stopped at the
    // last 10-Q and missed what happened since — for Strategy in Q3 2026, +9.8%
    // shares against +0.2% Bitcoin, the proceeds going to a USD reserve.
    // Strive's latest 8-K is already the last point, so it is not duplicated.
    const iss = typeof ISSUER !== 'undefined' ? ISSUER[companyKey] : null;
    const lastPt = points[points.length - 1];
    if (iss && iss.source !== '8-K' && iss.btcHoldings && iss.shares && lastPt) {
        const ts = Date.now();
        if (ts - lastPt.ts > 20 * 86400000) {
            points.push({ end: new Date(ts).toISOString().slice(0, 10), ts,
                          btc: iss.btcHoldings, shares: iss.shares,
                          sats: (iss.btcHoldings / iss.shares) * 1e8, source: 'live' });
        }
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
            : 'No holdings history could be built from this company’s filings, '
              + 'so no per-share history exists.';
        return `
        <section class="card">
            <h2 class="card-title">SATOSHIS PER SHARE — GROWTH</h2>
            <p class="asset-empty">${why}</p>
        </section>`;
    }

    const rows = a.points.slice(1).reverse();          // newest first, skip the base
    const rate = a.recentCagr;

    // The quarterly series is the right basis for the RATE — it measures growth
    // between filings — but its latest LEVEL is stale, because it divides by a
    // share count from the last 10-Q while the company has kept issuing. In
    // Sept 2026 that read 220,183 sats/share against the 187,955 the issuer
    // itself published: a 17% overstatement, in the flattering direction.
    // Prefer the issuer's live figure for the headline when we have it.
    const live = ISSUER[companyKey];
    const headlineSats = live?.satsPerShare ?? a.latest.sats;
    const headlineStale = !live;

    // Whether issuing stock helps or hurts common shareholders depends on NET
    // mNAV, not gross. New shares take a slice of what is left AFTER debt and
    // preferred, so issuing above net backing per share adds to every existing
    // share's Bitcoin even when gross mNAV is below 1. Keying this warning off
    // gross told Strategy holders (0.92x gross, 1.18x net) that issuance was
    // shrinking their Bitcoin when it was growing it.
    const netMnav = live?.mnavPublished ?? null;
    const gross = currentMnav ?? null;
    const gate = netMnav ?? gross;
    const dilutive = gate !== null && gate < 1;
    const grossOnlyBelow = !dilutive && gross !== null && gross < 1;

    // Net growth: per-share Bitcoin after the claims ahead of common, with the
    // BTC price held at today's level so it measures the company, not the
    // market. Only computable where each observation carries its claims —
    // Strive's weekly 8-K tables do. Buying Bitcoin with new preferred raises
    // GROSS sats/share but adds an equal dollar claim ahead of you, so without
    // this the card counted leverage as accretion: over 2026-07-24..09-25 Strive
    // grew +18.3% gross but +9.0% net.
    let net = null;
    const hist = live?.history;
    if (hist?.length >= 2 && live.btcPrice) {
        const P = live.btcPrice;
        const perShare = h => (h.btcHoldings
            - ((h.sataShares || 0) * 100 - (h.cashUsd || 0) - (h.strcFairValueUsd || 0)) / P)
            / h.effectiveShares;
        const f = hist[0], l = hist[hist.length - 1];
        const days = (Date.parse(l.asOf) - Date.parse(f.asOf)) / 86400000;
        const g = perShare(l) / perShare(f);
        const gg = (l.btcHoldings / l.effectiveShares) / (f.btcHoldings / f.effectiveShares);
        if (days > 20 && g > 0) {
            net = { change: g - 1, ann: Math.pow(g, 365 / days) - 1, gross: gg - 1,
                    from: f.asOf, to: l.asOf, weeks: Math.round(days / 7) };
        }
    }

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
                <div class="accretion-value">${fmtSats(headlineSats)}</div>
                <div class="accretion-label">sats per share${headlineStale ? ' (last filing)' : ''}</div>
            </div>
            ${live?.netSatsPerShare ? `
            <div class="accretion-main">
                <div class="accretion-value">${fmtSats(live.netSatsPerShare)}</div>
                <div class="accretion-label">net of senior claims</div>
            </div>` : ''}
            <div class="accretion-main">
                <div class="accretion-value tone-${tone}">${fmtRate(rate)}</div>
                <div class="accretion-label">since last quarter end, annualised${net ? ' (gross)' : ''}</div>
            </div>
            ${net ? `
            <div class="accretion-main">
                <div class="accretion-value ${net.ann >= 0 ? 'tone-good' : 'tone-bad'}">${fmtRate(net.ann)}</div>
                <div class="accretion-label">net of claims, annualised</div>
            </div>` : ''}
            <div class="accretion-main">
                <div class="accretion-value">${fmtRate(a.totalCagr)}</div>
                <div class="accretion-label">since ${a.points[0].end.slice(0, 7)}, annualised</div>
            </div>
        </div>

        <p class="accretion-read tone-${tone}">${verdict}</p>

        ${dilutive ? `<p class="accretion-warn">
            At <strong>${gate.toFixed(2)}×</strong> ${netMnav !== null ? 'net ' : ''}mNAV every
            $1 of stock issued adds only about <strong>${(gate * 100).toFixed(0)}¢</strong> of
            Bitcoin that belongs to shareholders, so raising equity here <em>shrinks</em>
            each existing share's Bitcoin. That reverses once the stock trades above its
            backing again — which is why the multiple still matters even though it is a
            poor guide to long-run returns.
        </p>` : grossOnlyBelow ? `<p class="accretion-note">
            Gross mNAV is <strong>${gross.toFixed(2)}×</strong>, so new shares lower the
            sats-per-share figure above — but net mNAV is <strong>${netMnav.toFixed(2)}×</strong>.
            After debt and preferred, each dollar raised by selling stock still adds more
            than a dollar of Bitcoin that is yours. Read this card's gross figures with
            that in mind: for a company with claims ahead of common, the net number is
            the one that measures your share.
        </p>` : `<p class="accretion-note">
            Above 1.0× ${netMnav !== null ? 'net ' : ''}mNAV, issuing stock adds more Bitcoin
            than it dilutes. That is the flywheel working.
        </p>`}
        ${net ? `<p class="accretion-note">
            Over the last ${net.weeks} weeks of 8-K tables (${net.from} to ${net.to}), sats per
            share grew <strong>${fmtRate(net.gross)}</strong> gross but
            <strong>${fmtRate(net.change)}</strong> net of claims, at a constant BTC price. The
            difference is Bitcoin bought with new preferred stock: it raises the gross count
            but adds an equal dollar claim ahead of common, so it is leverage, not accretion.
        </p>` : ''}

        <div class="table-wrap">
            <table class="backtest-table">
                <thead><tr>
                    <th>Date</th><th>Sats / share</th><th>Change</th><th>Annualised</th>
                </tr></thead>
                <tbody>
                    ${rows.map(p => `
                        <tr>
                            <td>${p.end}${p.source === 'live' ? ' <span class="alloc-tick" title="Holdings and share count published by the company today">live</span>' : ''}</td>
                            <td>${fmtSats(p.sats)}</td>
                            <td class="${p.growth >= 0 ? 'val-up' : 'val-down'}">${fmtRate(p.growth)}</td>
                            <td class="${p.cagr >= 0 ? 'val-up' : 'val-down'}">${fmtRate(p.cagr)}</td>
                        </tr>`).join('')}
                </tbody>
            </table>
        </div>

        <p class="asset-note">
            ${live ? `The headline figure is the company's own live number; the table below
            is computed from filed quarters, so its latest row sits above it — a filing-based
            count divides by shares as of that filing and ignores issuance since. Use the
            table for the RATE, the headline for the LEVEL. ` : ''}
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
