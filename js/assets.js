// ── Cycle Tide — treasury-company comparison view ──────────────────────────
//
// MSTR and Strive are EQUITIES, not Bitcoin. Most of the cycle model (MVRV,
// NUPL, Puell, ETF flows, Pi Cycle) is Bitcoin-network data that simply does
// not exist for a stock, so these tabs deliberately show NO 0-100 score.
// Presenting one would look authoritative while measuring something it cannot
// see. What they show instead is all directly measurable: price action,
// performance against BTC, drawdown, BTC held, and what you pay for it.

const ASSET_TABS = [
    { key: 'BTC',  label: 'Bitcoin',  ticker: null },
    // MSTR announced its BTC treasury strategy on 2020-08-11, before this
    // price history begins, so its whole series is "as a treasury company".
    { key: 'MSTR', label: 'Strategy', ticker: 'MSTR' },
    // ASST was Asset Entities — an unrelated business — until the Strive
    // merger completed on 2025-09-10 (SEC lists the former name as ending
    // that day). Charting from before then compares BTC against a company
    // that had nothing to do with Bitcoin, so the series starts at the pivot.
    { key: 'ASST', label: 'Strive',   ticker: 'ASST',
      treasurySince: '2025-09-10',
      priorName: 'Asset Entities' },
];

let activeTab = (() => {
    try { return localStorage.getItem('cycletide_tab') || 'BTC'; } catch { return 'BTC'; }
})();

const EQUITY = {};      // key -> daily price series
let TREASURIES = null;  // committed snapshot

async function loadAssetData() {
    TREASURIES = await fetchTreasuries();
    // Prices ship inside the same snapshot — Yahoo cannot be called from a
    // browser (no CORS headers), so they are fetched server-side by
    // scripts/snapshot-treasuries.mjs and committed alongside the holdings.
    for (const t of ASSET_TABS) {
        if (t.key === 'BTC') continue;
        EQUITY[t.key] = TREASURIES?.[t.key]?.prices || [];
    }
}

// Shares outstanding as of a date, from the quarterly SEC series. Uses the
// most recent filing at or before the date — never interpolates, because
// share issuance is lumpy and a smoothed number would be fiction.
// Rows carry two dates: `end` (the reporting period) and `asOf` (the cover-page
// date the share count is actually true for, typically a few weeks later). We
// select on `asOf`, because using a count before it was true back-dates recent
// issuance into a period where those shares did not yet exist — which
// understates historical mNAV exactly where these companies issue hardest.
function sharesAsOf(companyKey, ts) {
    const hist = TREASURIES?.[companyKey]?.sharesHistory;
    if (!hist?.length) return null;
    const keyTs = row => (row.asOf ? Date.parse(row.asOf + 'T00:00:00Z') : row.ts);
    let out = null;
    for (const row of [...hist].sort((a, b) => keyTs(a) - keyTs(b))) {
        if (keyTs(row) <= ts) out = row; else break;
    }
    // Before the first cover date there is no true count; fall back to the
    // earliest rather than returning null and blanking the whole panel.
    return out || hist[0];
}

// Price history from the treasury pivot onward. Everything the dashboard
// reports about a treasury company — ATH, drawdown, relative performance —
// should describe the treasury company, not whatever the shell was before it.
function treasuryEra(key) {
    const px = asOfEquity(EQUITY[key] || []);
    const meta = ASSET_TABS.find(t => t.key === key);
    if (!meta?.treasurySince) return px;
    const pivot = Date.parse(meta.treasurySince + 'T00:00:00Z');
    return px.filter(p => p.ts >= pivot);
}

// Everything on an equity tab is computed as of the date selected in the date
// browser, not always "today" — otherwise stepping back in time would leave
// the valuation read showing current numbers, which is worse than not
// offering the control at all.
function asOfEquity(series) {
    if (!series?.length) return series || [];
    if (viewTs === null) return series;
    const cut = series.filter(p => p.ts <= viewTs);
    return cut.length ? cut : series.slice(0, 1);
}

function pctChange(series, days) {
    if (!series?.length) return null;
    const last = series[series.length - 1];
    const target = last.ts - days * 86400000;
    let ref = null;
    for (const p of series) { if (p.ts <= target) ref = p; else break; }
    if (!ref || !ref.close) return null;
    return (last.close - ref.close) / ref.close;
}

function drawdownFromAth(series) {
    if (!series?.length) return { dd: null, ath: null, athTs: null };
    let ath = -Infinity, athTs = null;
    for (const p of series) {
        const h = p.high ?? p.close;
        if (h > ath) { ath = h; athTs = p.ts; }
    }
    const last = series[series.length - 1].close;
    return { dd: (last - ath) / ath, ath, athTs };
}

// mNAV: market cap ÷ value of BTC held. Below 1.0 means the market values the
// company at less than its Bitcoin alone — the headline number for these.
function computeMnav(companyKey, btcPrice, asOfTs) {
    const t = TREASURIES?.[companyKey];
    const px = asOfEquity(EQUITY[companyKey]);
    if (!t?.btcHoldings || !px?.length || !btcPrice) return null;

    const last = px[px.length - 1];
    const sh = sharesAsOf(companyKey, asOfTs ?? last.ts);
    if (!sh) return null;

    const marketCap = last.close * sh.shares;
    const btcValue  = t.btcHoldings * btcPrice;

    // Holdings are live (CoinGecko); share counts are quarterly (SEC). These
    // companies buy Bitcoin BY ISSUING STOCK, so a company whose stack has
    // grown a lot since its last filing has also issued shares we are not
    // counting — and its mNAV is understated by roughly that much. The bias is
    // one-directional and it is NOT symmetric between companies: MSTR's stack
    // is flat since 2026-06-30 while Strive's grew ~23%, so the same stale
    // share count flatters Strive far more. Quantify it rather than leaving the
    // reader to assume the two figures are equally trustworthy.
    //
    // Strive tags no coin count in XBRL, so holdingsHistory is empty for it and
    // the direct comparison is unavailable — for exactly the company that needs
    // it most. Fall back to the coin count IMPLIED by the filed balance sheet
    // (digital assets at fair value / BTC price on the period end date), which
    // is derivable for any filer that reports a dollar value.
    let filedBtc = (t.holdingsHistory || []).find(h => h.end === sh.end)?.btc ?? null;
    if (filedBtc === null && t.filedDigitalAssets?.[sh.end] && SERIES?.daily?.length) {
        const endTs = Date.parse(sh.end + 'T00:00:00Z');
        let px = null;
        for (const p of SERIES.daily) { if (p.ts <= endTs) px = p.close; else break; }
        if (px) filedBtc = t.filedDigitalAssets[sh.end] / px;
    }
    const stackGrowth = filedBtc ? (t.btcHoldings / filedBtc - 1) : null;
    return {
        marketCap, btcValue,
        mnav: marketCap / btcValue,
        shares: sh.shares,
        sharesAsOfDate: sh.asOf || sh.end,
        sharesPeriod: sh.end,
        sharesClasses: sh.classes?.length || 1,
        stackGrowth,
        btcPerShare: t.btcHoldings / sh.shares,
        costUsd: t.btcCostUsd,
        unrealised: btcValue - t.btcCostUsd,
        unrealisedPct: (btcValue - t.btcCostUsd) / t.btcCostUsd,
    };
}

// ── Rendering ───────────────────────────────────────────────────────────────

function renderTabs() {
    const nav = document.getElementById('assetTabs');
    if (!nav) return;
    nav.innerHTML = ASSET_TABS.map(t =>
        `<button class="asset-tab${t.key === activeTab ? ' active' : ''}"
                 data-tab="${t.key}" role="tab"
                 aria-selected="${t.key === activeTab}">${t.label}</button>`).join('');
    nav.querySelectorAll('.asset-tab').forEach(b => {
        b.addEventListener('click', () => switchTab(b.dataset.tab));
    });
}

function switchTab(key) {
    activeTab = key;
    try { localStorage.setItem('cycletide_tab', key); } catch {}
    renderTabs();
    document.getElementById('btcView').hidden = key !== 'BTC';
    document.getElementById('assetView').hidden = key === 'BTC';
    // The date browser drives the BTC model only — hide it elsewhere rather
    // than leaving a control that silently does nothing.
    // The date browser now drives the equity tabs too, so it stays visible.
    const db = document.querySelector('.date-browser');
    if (db) db.hidden = false;
    // The live ticker streams BTC only — showing an empty one on an equity tab
    // reads as broken rather than as "not applicable".
    const tick = document.querySelector('.status-row');
    if (tick) tick.hidden = key !== 'BTC';

    // Header follows the tab, so the page never claims to be showing one thing
    // while displaying another.
    const h1 = document.querySelector('.top-header h1');
    const lede = document.querySelector('.lede');
    if (key === 'BTC') {
        if (h1) h1.textContent = 'BTC Accumulation / Distribution Monitor';
        if (lede) lede.textContent = 'A weighted, explainable read on where current conditions sit relative to prior Bitcoin cycles. Not a price prediction — a historical risk/reward context tool. Deep water = accumulation-favorable; low tide = distribution risk.';
    } else {
        const m = ASSET_TABS.find(t => t.key === key);
        if (h1) h1.textContent = `${m.label} — Bitcoin Treasury Company`;
        if (lede) lede.textContent = 'Price action, Bitcoin holdings and valuation against those holdings. No cycle score here: the on-chain signals that drive the Bitcoin model do not exist for an equity, so none is shown rather than implying one.';
    }
    if (key === 'BTC') {
        renderFor(dayBounds().last);
        renderScoreChart();
    } else {
        renderAssetView(key);
    }
}

// Equities trade in cents; fmtUSD rounds to whole dollars (right for BTC,
// wrong for a $27 stock).
function fmtEq(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtBig(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
    return fmtUSD(v);
}

function fmtSigned(v, digits = 1) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + (v * 100).toFixed(digits) + '%';
}

function toneClass(v) {
    if (v === null || v === undefined || isNaN(v)) return '';
    return v > 0 ? 'val-up' : v < 0 ? 'val-down' : '';
}

function renderAssetView(key) {
    const el = document.getElementById('assetView');
    if (!el) return;
    const meta = ASSET_TABS.find(t => t.key === key);
    const px = EQUITY[key];
    const t = TREASURIES?.[key];

    if (!px?.length) {
        el.innerHTML = `<section class="card"><p class="asset-empty">
            Could not load price data for ${meta.label} (${meta.ticker}).
            </p></section>`;
        return;
    }

    const era = treasuryEra(key);          // treasury-era slice, as of viewTs
    const pxAsOf = asOfEquity(px);
    const last = pxAsOf[pxAsOf.length - 1];
    const prev = pxAsOf.length > 1 ? pxAsOf[pxAsOf.length - 2].close : null;
    const dayChg = prev ? (last.close - prev) / prev : null;
    // ATH/drawdown measured over the treasury era only.
    const { dd, ath, athTs } = drawdownFromAth(era);

    const btcAll = SERIES?.daily || [];
    const btc = viewTs === null ? btcAll : btcAll.filter(p => p.ts <= viewTs);
    // Must match the date being viewed: pairing a past share price with today's
    // BTC price would produce a meaningless mNAV.
    const btcPrice = btc.length ? btc[btc.length - 1].close : null;
    const nav = computeMnav(key, btcPrice, last?.ts);

    // Performance vs BTC over matched windows.
    const windows = [[30, '1M'], [90, '3M'], [365, '1Y']];
    // Only offer windows that fit inside the treasury era — a "1Y" number
    // that reaches back into the predecessor company would be meaningless.
    const eraDays = era.length
        ? Math.round((era[era.length - 1].ts - era[0].ts) / 86400000) : 0;
    const perf = windows
        .filter(([d]) => d <= eraDays)
        .map(([d, lbl]) => ({ lbl, asset: pctChange(era, d), btc: pctChange(btc, d) }));

    el.innerHTML = `
        <section class="card asset-header-card">
            <div class="asset-title">
                <h2>${meta.label} <span class="asset-ticker">${meta.ticker}</span></h2>
                <div class="asset-price">
                    ${fmtEq(last.close)}
                    <span class="asset-chg ${toneClass(dayChg)}">${fmtSigned(dayChg, 2)}</span>
                </div>
            </div>
            <dl class="stat-list asset-stats">
                <div class="stat-row"><dt>All-time high</dt><dd>${fmtEq(ath)}</dd></div>
                <div class="stat-row"><dt>Drawdown from ATH</dt>
                    <dd class="${toneClass(dd)}">${fmtSigned(dd)}</dd></div>
                <div class="stat-row"><dt>Days since ATH</dt>
                    <dd>${athTs ? daysBetween(last.ts, athTs) : '—'}</dd></div>
            </dl>
            ${(() => {
                if (viewTs !== null && !isToday(viewTs)) return '';
                const age = typeof equityDataAge === 'function' ? equityDataAge() : null;
                if (!age || age.sessionsBehind < 1) return '';
                return `<p class="asset-note alloc-stale">
                    Price is from ${new Date(age.ts).toISOString().slice(0, 10)},
                    ${age.sessionsBehind} trading session${age.sessionsBehind === 1 ? '' : 's'} behind —
                    Bitcoin is live but equity prices come from the daily snapshot, so
                    mNAV and the valuation read are approximate right now.
                </p>`;
            })()}
            ${viewTs !== null && !isToday(viewTs) ? `<p class="asset-note asof-note">
                Showing ${escapeHtml(new Date(last.ts).toISOString().slice(0, 10))} —
                every figure on this tab, including the valuation read, is computed
                as of that date using the share count filed at the time.
            </p>` : ''}
            ${metricInfoHtml('priceAndAth')}
            ${metricInfoHtml('drawdown')}
            ${meta.treasurySince ? `<p class="asset-note">
                Figures cover the treasury era only — from ${meta.treasurySince},
                when the ${meta.priorName} merger completed and the company became
                ${meta.label}. Earlier price history belongs to a different
                business and is excluded rather than blended in.
            </p>` : ''}
        </section>

        ${nav ? (() => {
            // Prefer a 3M window for the relative-performance factor so the two
            // companies stay comparable — Strive's treasury era is too short for
            // 1Y, and silently scoring them over different horizons would make
            // the factor meaningless across tabs. Falls back to the longest
            // window that fits if 3M is unavailable.
            const p3 = perf.find(p => p.lbl === '3M') || perf[perf.length - 1];
            return renderAssetSignal({
                companyKey: key,
                mnav: nav.mnav,
                unrealisedPct: nav.unrealisedPct,
                relPerf: p3 && p3.asset !== null && p3.btc !== null ? p3.asset - p3.btc : null,
                relPerfWindow: p3 ? p3.lbl : '',
            });
        })() : ''}

        ${t?.btcHoldings ? `
        <section class="card">
            <h2 class="card-title">BITCOIN TREASURY</h2>
            <dl class="stat-list">
                <div class="stat-row"><dt>BTC held</dt>
                    <dd>${t.btcHoldings.toLocaleString('en-US', {maximumFractionDigits: 0})}</dd></div>
                <div class="stat-row"><dt>% of all Bitcoin</dt>
                    <dd>${t.pctOfSupply != null ? t.pctOfSupply.toFixed(3) + '%' : '—'}</dd></div>
                <div class="stat-row"><dt>Cost basis</dt><dd>${fmtBig(t.btcCostUsd)}</dd></div>
                <div class="stat-row"><dt>Current value</dt>
                    <dd>${fmtBig(nav ? nav.btcValue : null)}</dd></div>
                <div class="stat-row"><dt>Unrealised P/L</dt>
                    <dd class="${toneClass(nav?.unrealised)}">${
                        nav ? fmtBig(nav.unrealised) + ' (' + fmtSigned(nav.unrealisedPct) + ')' : '—'}</dd></div>
                <div class="stat-row"><dt>Avg cost per BTC</dt>
                    <dd>${t.btcCostUsd && t.btcHoldings ? fmtUSD(t.btcCostUsd / t.btcHoldings) : '—'}</dd></div>
            </dl>
            ${metricInfoHtml('holdings')}
            ${metricInfoHtml('costBasis')}
        </section>

        <section class="card">
            <h2 class="card-title">VALUATION VS HOLDINGS</h2>
            ${nav ? `
            <div class="mnav-hero">
                <div class="mnav-value ${nav.mnav < 1 ? 'val-up' : 'val-down'}">${nav.mnav.toFixed(2)}×</div>
                <div class="mnav-label">mNAV — market cap ÷ BTC value</div>
                <p class="mnav-read">${nav.mnav < 1
                    ? `Trading at a <strong>${((1 - nav.mnav) * 100).toFixed(0)}% discount</strong> to the Bitcoin it holds.`
                    : `Trading at a <strong>${((nav.mnav - 1) * 100).toFixed(0)}% premium</strong> to the Bitcoin it holds.`}</p>
            </div>
            <dl class="stat-list">
                <div class="stat-row"><dt>Market cap</dt><dd>${fmtBig(nav.marketCap)}</dd></div>
                <div class="stat-row"><dt>Shares outstanding</dt>
                    <dd>${(nav.shares / 1e6).toFixed(1)}M</dd></div>
                <div class="stat-row"><dt>BTC per share</dt>
                    <dd>${nav.btcPerShare.toFixed(6)}</dd></div>
                <div class="stat-row"><dt>BTC value per share</dt>
                    <dd>${btcPrice ? fmtEq(nav.btcPerShare * btcPrice) : '—'}</dd></div>
            </dl>
            <p class="asset-note">
                Share count is ${nav.sharesClasses > 1 ? 'all share classes' : 'shares'}
                outstanding as of ${nav.sharesAsOfDate}, read from the cover page of the
                latest SEC filing (period ending ${nav.sharesPeriod}). It counts shares
                that exist — not a fully-diluted figure, so it excludes unconverted
                notes, preferred and unvested awards. Filings are quarterly and these
                companies issue stock continuously to buy Bitcoin, so between filings
                the true count is <em>higher</em> and mNAV correspondingly higher than
                shown.
            </p>
            ${nav.stackGrowth !== null && nav.stackGrowth > 0.05 ? `<p class="accretion-warn">
                Bitcoin holdings are up <strong>${(nav.stackGrowth * 100).toFixed(0)}%</strong>
                since that filing, and these companies buy Bitcoin by issuing stock — so
                shares have almost certainly been issued that this count does not include.
                The real mNAV is <strong>higher</strong> than ${nav.mnav.toFixed(2)}×, and
                the gap grows with that percentage. Treat this figure as a floor, not a
                point estimate.
            </p>` : ''}
            ${metricInfoHtml('mnav')}
            ${metricInfoHtml('btcPerShare')}` : `<p class="asset-empty">Share count unavailable — mNAV cannot be computed.</p>`}
        </section>` : ''}

        ${renderMnavHistory(key, nav ? nav.mnav : null)}

        ${renderAccretion(key, nav ? nav.mnav : null)}

        ${nav ? renderAssetProjection(key, {
            holdings: t.btcHoldings,
            shares: nav.shares,
            btcPrice,
            mnav: nav.mnav,
            price: last.close,
        }) : ''}

        <section class="card">
            <h2 class="card-title">PERFORMANCE VS BITCOIN</h2>
            <div class="table-wrap">
                <table class="backtest-table">
                    <thead><tr><th>Window</th><th>${meta.ticker}</th><th>BTC</th><th>Difference</th></tr></thead>
                    <tbody>${perf.map(p => {
                        const diff = (p.asset !== null && p.btc !== null) ? p.asset - p.btc : null;
                        return `<tr>
                            <td>${p.lbl}</td>
                            <td class="${toneClass(p.asset)}">${fmtSigned(p.asset)}</td>
                            <td class="${toneClass(p.btc)}">${fmtSigned(p.btc)}</td>
                            <td class="${toneClass(diff)}">${fmtSigned(diff)}</td>
                        </tr>`;
                    }).join('')}</tbody>
                </table>
            </div>
            <p class="asset-note">
                Equity returns include leverage, dilution and company-specific
                risk — they are not a pure Bitcoin exposure in either direction.
            </p>
            ${metricInfoHtml('perfVsBtc')}
        </section>

        <section class="card">
            <h2 class="card-title">PRICE VS BITCOIN — INDEXED TO 100</h2>
            <div class="chart-wrap">
                <svg id="assetChart" class="score-chart"></svg>
                <div id="assetTooltip" class="chart-tooltip"></div>
            </div>
            <p class="asset-note">
                Both series indexed to 100 at the start of the window, so relative
                performance is comparable on one axis — never two y-scales, which
                would invent crossovers that are artifacts of scaling.
            </p>
            ${metricInfoHtml('indexedChart')}
        </section>
    `;

    renderAssetChart(key, nav ? {
        holdings: t.btcHoldings, shares: nav.shares, btcPrice, mnav: nav.mnav, price: last.close,
    } : null);
    bindMetricToggles();
    bindDilutionInput();
}

// Indexed comparison chart: both series rebased to 100 so they share one axis.
function renderAssetChart(key, projCtx) {
    const svg = document.getElementById('assetChart');
    if (!svg) return;
    syncChartGeometry();
    const { w, padL, padR, padT, padB } = CHART;
    const h = CHART.h;

    const px = EQUITY[key];
    const btc = SERIES?.daily || [];
    if (!px?.length) return;

    // Common window: the later of the two series' starts, and — where the
    // company only became a BTC treasury partway through its listed life —
    // no earlier than that pivot. Indexing from before the pivot would
    // compare Bitcoin against an unrelated former business.
    const meta = ASSET_TABS.find(t => t.key === key);
    const pivot = meta?.treasurySince ? Date.parse(meta.treasurySince + 'T00:00:00Z') : 0;
    const start = Math.max(px[0].ts, btc.length ? btc[0].ts : px[0].ts, pivot);
    const a = px.filter(p => p.ts >= start);
    const b = btc.filter(p => p.ts >= start);
    if (a.length < 2 || b.length < 2) return;

    const idx = (series) => {
        const base = series[0].close;
        return series.map(p => ({ ts: p.ts, v: (p.close / base) * 100 }));
    };
    const ai = idx(a), bi = idx(b);

    // Forward projections, converted onto the same indexed basis as the lines
    // so they can share the axis. Two paths are drawn, not one: the arithmetic
    // (backing per share after dilution) and the empirical (beta-implied)
    // disagree by a wide margin, and showing only one would hide that.
    const equityBase = a[0].close;
    let projPts = [];
    if (projCtx && typeof assetProjectionScenarios === 'function') {
        const pr = assetProjectionScenarios(key, projCtx);
        if (pr) {
            const nowTs = a[a.length - 1].ts;
            const nowV = (a[a.length - 1].close / equityBase) * 100;
            const mk = (field, mnavMul) => {
                const pts = [{ ts: nowTs, v: nowV }];
                for (const r of pr.rows) {
                    if (!r.years || r.years <= 0) continue;
                    const usd = field === 'beta' ? r.betaImplied
                              : (r.backing !== null && mnavMul ? r.backing * mnavMul : null);
                    if (usd === null || usd === undefined) continue;
                    pts.push({ ts: nowTs + r.years * 365.25 * 86400000, v: (usd / equityBase) * 100 });
                }
                return pts.length > 1 ? pts : [];
            };
            // BTC's own projected path over the same window, so the equity
            // forecast can be read against the Bitcoin assumption driving it
            // rather than in isolation.
            const btcBase = b[0].close;
            const btcNowV = (b[b.length - 1].close / btcBase) * 100;
            const btcProj = [{ ts: b[b.length - 1].ts, v: btcNowV }];
            for (const r of pr.rows) {
                if (!r.years || r.years <= 0) continue;
                btcProj.push({ ts: nowTs + r.years * 365.25 * 86400000,
                               v: (r.btc / btcBase) * 100 });
            }

            projPts = [
                { cls: 'chart-line-btcproj', pts: btcProj.length > 1 ? btcProj : [],
                  label: 'BTC projected' },
                { cls: 'chart-line-proj', pts: mk('backing', projCtx.mnav),
                  label: 'backing after dilution, at today’s mNAV' },
                // Fade the beta path when correlation is weak: Strive's beta
                // explains barely half its movement (corr ~0.55 over ~250d)
                // versus MSTR's 0.74 over 1254d, and drawing them with equal
                // visual weight implies equal confidence.
                { cls: 'chart-line-beta' + (pr.beta && pr.beta.corr < 0.6 ? ' chart-line-weakbeta' : ''),
                  pts: mk('beta', null), label: 'beta-implied' },
            ].filter(p => p.pts.length > 1);
        }
    }

    const projTs = projPts.flatMap(p => p.pts.map(q => q.ts));
    const projV  = projPts.flatMap(p => p.pts.map(q => q.v));

    const tMin = start;
    const tMax = Math.max(ai[ai.length - 1].ts, bi[bi.length - 1].ts, ...(projTs.length ? projTs : [0]));
    const all = [...ai, ...bi].map(p => p.v).concat(projV);
    const lo = Math.min(...all), hi = Math.max(...all);
    // Log scale: these can diverge by 10x+, which a linear axis would flatten.
    let lLo = Math.log10(Math.max(lo, 1)), lHi = Math.log10(hi);

    const x = ts => padL + ((ts - tMin) / (tMax - tMin)) * (w - padL - padR);
    const y = v => padT + (1 - (Math.log10(Math.max(v, 1)) - lLo) / (lHi - lLo || 1)) * (h - padT - padB);
    const path = pts => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');

    // Include the first 1/2/5 step at or above the max so the top of the axis
    // carries a label — otherwise the span above the last tick reads as an
    // unexplained empty band.
    const ticks = [];
    let cap = null;
    for (let e = Math.floor(lLo); e <= Math.ceil(lHi) + 1; e++) {
        for (const m of [1, 2, 5]) {
            const v = m * Math.pow(10, e);
            if (v < lo) continue;
            if (v > hi) { if (cap === null) cap = v; continue; }
            ticks.push(v);
        }
    }
    if (cap !== null) { ticks.push(cap); lHi = Math.log10(cap); }

    const years = [];
    const y0 = new Date(tMin).getUTCFullYear(), y1 = new Date(tMax).getUTCFullYear();
    for (let yr = y0; yr <= y1; yr++) {
        const ts = Date.UTC(yr, 0, 1);
        if (ts < tMin || ts > tMax) continue;
        years.push(`<line x1="${x(ts)}" x2="${x(ts)}" y1="${padT}" y2="${h - padB}" class="chart-grid-v"/>
            <text x="${x(ts)}" y="${h - padB + 16}" text-anchor="middle" class="chart-axis">${
                w < 600 ? "'" + String(yr).slice(2) : yr}</text>`);
    }

    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.style.aspectRatio = `${w} / ${h}`;
    svg.style.height = 'auto';
    svg.innerHTML = `
        ${ticks.map(v => `<line x1="${padL}" x2="${w - padR}" y1="${y(v)}" y2="${y(v)}" class="chart-grid"/>
            <text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end" class="chart-axis">${v}</text>`).join('')}
        ${years.join('')}
        ${projPts.length ? `<line x1="${x(a[a.length-1].ts)}" x2="${x(a[a.length-1].ts)}"
              y1="${padT}" y2="${h - padB}" class="chart-now-divider"/>` : ''}
        ${projPts.map(p => `<path d="${path(p.pts.map(q => ({ts:q.ts, v:q.v})))}" class="${p.cls}"/>`).join('')}
        <path d="${path(bi)}" class="chart-line-price"/>
        <path d="${path(ai)}" class="chart-line-real"/>
        <line id="assetCrosshair" x1="0" x2="0" y1="${padT}" y2="${h - padB}"
              class="chart-crosshair" style="display:none"/>
        <circle id="assetDotA" r="4" class="chart-hover-dot" style="display:none"/>
        <circle id="assetDotB" r="4" class="chart-hover-dot" style="display:none"/>
        <rect id="assetHit" x="${padL}" y="${padT}" width="${w - padL - padR}"
              height="${h - padT - padB}" fill="transparent"/>
    `;

    // Remove any legend from a previous render — this function runs again on
    // every explainer toggle, and appending would stack duplicates.
    svg.parentElement.parentElement.querySelectorAll('.asset-legend').forEach(n => n.remove());

    const legend = document.createElement('div');
    legend.className = 'chart-legend asset-legend';
    legend.innerHTML = `
        <span class="lg-item"><span class="lg-swatch lg-real"></span>${key}</span>
        <span class="lg-item"><span class="lg-swatch lg-price"></span>BTC</span>
        ${projPts.length ? `<span class="lg-item"><span class="lg-swatch lg-btcproj"></span>BTC projected</span>
        <span class="lg-item"><span class="lg-swatch lg-proj"></span>projected (backing)</span>
        <span class="lg-item"><span class="lg-swatch lg-beta"></span>projected (beta)${
            projPts.some(p=>/weakbeta/.test(p.cls)) ? ' <span class="lg-warn">— weak fit</span>' : ''}</span>` : ''}
        <span class="lg-item lg-hint">log scale · both = 100 at ${new Date(start).toISOString().slice(0, 10)}${
            pivot && start === pivot ? ` · from ${meta.label} treasury pivot` : ''}</span>`;
    svg.parentElement.parentElement.insertBefore(legend, svg.parentElement);

    attachAssetHover(svg, { key, ai, bi, a, b, x, y, tMin, tMax, h, projPts, equityBase });
}

// Crosshair + tooltip for the indexed comparison chart. Shows BOTH series at
// the hovered date — the whole point of the chart is the relationship between
// them, so reading one without the other would be half the story.
function attachAssetHover(svg, ctx) {
    const { key, ai, bi, a, b, x, y, tMin, tMax, h, projPts = [], equityBase } = ctx;
    const lastHistTs = a.length ? a[a.length - 1].ts : 0;
    // Projected paths keyed by class, so the tooltip can read them past today.
    const projByCls = Object.fromEntries(projPts.map(p => [p.cls, p.pts]));
    const hit = svg.querySelector('#assetHit');
    const cross = svg.querySelector('#assetCrosshair');
    const dotA = svg.querySelector('#assetDotA');
    const dotB = svg.querySelector('#assetDotB');
    const tip = document.getElementById('assetTooltip');
    if (!hit || !tip) return;

    let pinned = false;

    const nearest = (arr, ts) => {
        let out = arr[0];
        for (const p of arr) {
            if (Math.abs(p.ts - ts) < Math.abs(out.ts - ts)) out = p;
        }
        return out;
    };
    // Raw (unindexed) price at a timestamp, so the tooltip can show real money
    // alongside the indexed value.
    const rawAt = (arr, ts) => {
        let out = null;
        for (const p of arr) {
            if (!out || Math.abs(p.ts - ts) < Math.abs(out.ts - ts)) out = p;
        }
        return out ? out.close : null;
    };

    function show(clientX) {
        const rect = svg.getBoundingClientRect();
        const svgX = ((clientX - rect.left) / rect.width) * CHART.w;
        const ts = tMin + ((svgX - CHART.padL) / (CHART.w - CHART.padL - CHART.padR)) * (tMax - tMin);

        const future = ts > lastHistTs;

        if (future && projPts.length) {
            // Past today, read the projected paths instead of clamping to the
            // last real bar — which previously made the whole forward region
            // report today's values.
            const pick = cls => projByCls[cls] ? nearest(projByCls[cls], ts) : null;
            const back = pick('chart-line-proj');
            const beta = pick('chart-line-beta');
            const bproj = pick('chart-line-btcproj');
            const at = back || beta || bproj;
            if (!at) return;

            cross.style.display = '';
            cross.setAttribute('x1', x(at.ts));
            cross.setAttribute('x2', x(at.ts));

            if (back) { dotA.style.display=''; dotA.setAttribute('cx', x(back.ts)); dotA.setAttribute('cy', y(back.v)); }
            else dotA.style.display='none';
            if (bproj) { dotB.style.display=''; dotB.setAttribute('cx', x(bproj.ts)); dotB.setAttribute('cy', y(bproj.v)); }
            else dotB.style.display='none';

            const usd = p => equityBase ? fmtEq((p.v / 100) * equityBase) : '';
            tip.style.display = 'block';
            tip.innerHTML = `
                <div class="tt-date">${new Date(at.ts).toISOString().slice(0, 10)}
                    <span class="tt-proj">projected</span></div>
                ${back ? `<div class="tt-row"><span class="tt-key tt-key-a">backing</span>
                    <span class="tt-idx">${back.v.toFixed(1)}</span>
                    <span class="tt-raw">${usd(back)}</span></div>` : ''}
                ${beta ? `<div class="tt-row"><span class="tt-key tt-key-a">beta</span>
                    <span class="tt-idx">${beta.v.toFixed(1)}</span>
                    <span class="tt-raw">${usd(beta)}</span></div>` : ''}
                ${bproj ? `<div class="tt-row"><span class="tt-key tt-key-b">BTC</span>
                    <span class="tt-idx">${bproj.v.toFixed(1)}</span></div>` : ''}
                <div class="tt-rel">scenario, not a forecast</div>`;
        } else {

        const na = nearest(ai, ts);
        const nb = nearest(bi, ts);

        cross.style.display = '';
        cross.setAttribute('x1', x(na.ts));
        cross.setAttribute('x2', x(na.ts));

        dotA.style.display = '';
        dotA.setAttribute('cx', x(na.ts));
        dotA.setAttribute('cy', y(na.v));
        dotB.style.display = '';
        dotB.setAttribute('cx', x(nb.ts));
        dotB.setAttribute('cy', y(nb.v));

        const rawA = rawAt(a, na.ts);
        const rawB = rawAt(b, nb.ts);
        // Relative performance since the index date is the number that matters.
        const rel = na.v - nb.v;

        tip.style.display = 'block';
        tip.innerHTML = `
            <div class="tt-date">${new Date(na.ts).toISOString().slice(0, 10)}</div>
            <div class="tt-row"><span class="tt-key tt-key-a">${escapeHtml(key)}</span>
                <span class="tt-idx">${na.v.toFixed(1)}</span>
                <span class="tt-raw">${rawA !== null ? fmtEq(rawA) : ''}</span></div>
            <div class="tt-row"><span class="tt-key tt-key-b">BTC</span>
                <span class="tt-idx">${nb.v.toFixed(1)}</span>
                <span class="tt-raw">${rawB !== null ? fmtUSD(rawB) : ''}</span></div>
            <div class="tt-rel ${rel >= 0 ? 'val-up' : 'val-down'}">
                ${rel >= 0 ? '+' : ''}${rel.toFixed(1)} pts vs BTC since start</div>`;
        }

        // Sit ABOVE the plot area rather than tracking the curve. Anchoring to
        // the higher series still overlapped it wherever both lines ran near
        // the top of the chart — the tooltip would clamp to 0 and cover the
        // very curve being read. Parking it in the header strip means the plot
        // is never obscured, whatever the data does.
        // Overlay the top of the plot rather than reserving permanent space
        // below the card title. It is placed on whichever side of the crosshair
        // has more room, so it never sits over the part of the curve being read.
        const wrapTop = tip.parentElement.getBoundingClientRect().top;
        const svgTop = rect.top - wrapTop;
        tip.style.top = `${Math.max(0, svgTop + 6)}px`;

        // Put the tooltip on the emptier side of the crosshair so it does not
        // cover the section of chart being inspected.
        // Read the crosshair we just placed, so this works for both the
        // historical and projected branches without depending on either's locals.
        const xPct = (parseFloat(cross.getAttribute('x1')) / CHART.w) * 100;
        const wPct = (tip.offsetWidth / rect.width) * 100;
        const left = xPct > 50 ? xPct - wPct - 2 : xPct + 2;
        tip.style.transform = 'none';
        tip.style.left = `${Math.min(100 - wPct - 1, Math.max(1, left)).toFixed(2)}%`;
    }

    function hide() {
        if (pinned) return;
        cross.style.display = 'none';
        dotA.style.display = 'none';
        dotB.style.display = 'none';
        tip.style.display = 'none';
    }

    hit.addEventListener('mousemove', e => { if (!pinned) show(e.clientX); });
    hit.addEventListener('mouseleave', hide);

    // Click pins the readout. There is no date browser on these tabs, so a
    // click has no other job — and pinning is what makes this usable on touch,
    // where there is no hover at all.
    hit.addEventListener('click', e => {
        if (pinned) { pinned = false; hide(); }
        else { pinned = true; show(e.clientX); }
    });
}
