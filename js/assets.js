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
function sharesAsOf(companyKey, ts) {
    const hist = TREASURIES?.[companyKey]?.sharesHistory;
    if (!hist?.length) return null;
    let out = null;
    for (const row of hist) {
        if (row.ts <= ts) out = row; else break;
    }
    return out;
}

// Price history from the treasury pivot onward. Everything the dashboard
// reports about a treasury company — ATH, drawdown, relative performance —
// should describe the treasury company, not whatever the shell was before it.
function treasuryEra(key) {
    const px = EQUITY[key] || [];
    const meta = ASSET_TABS.find(t => t.key === key);
    if (!meta?.treasurySince) return px;
    const pivot = Date.parse(meta.treasurySince + 'T00:00:00Z');
    return px.filter(p => p.ts >= pivot);
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
function computeMnav(companyKey, btcPrice) {
    const t = TREASURIES?.[companyKey];
    const px = EQUITY[companyKey];
    if (!t?.btcHoldings || !px?.length || !btcPrice) return null;

    const last = px[px.length - 1];
    const sh = sharesAsOf(companyKey, last.ts);
    if (!sh) return null;

    const marketCap = last.close * sh.shares;
    const btcValue  = t.btcHoldings * btcPrice;
    return {
        marketCap, btcValue,
        mnav: marketCap / btcValue,
        shares: sh.shares,
        sharesAsOfDate: sh.end,
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
    const db = document.querySelector('.date-browser');
    if (db) db.hidden = key !== 'BTC';
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

    const era = treasuryEra(key);          // treasury-era slice
    const last = px[px.length - 1];
    const prev = px.length > 1 ? px[px.length - 2].close : null;
    const dayChg = prev ? (last.close - prev) / prev : null;
    // ATH/drawdown measured over the treasury era only.
    const { dd, ath, athTs } = drawdownFromAth(era);

    const btc = SERIES?.daily;
    const btcPrice = btc?.length ? btc[btc.length - 1].close : null;
    const nav = computeMnav(key, btcPrice);

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
            ${meta.treasurySince ? `<p class="asset-note">
                Figures cover the treasury era only — from ${meta.treasurySince},
                when the ${meta.priorName} merger completed and the company became
                ${meta.label}. Earlier price history belongs to a different
                business and is excluded rather than blended in.
            </p>` : ''}
        </section>

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
                <div class="stat-row"><dt>Diluted shares</dt>
                    <dd>${(nav.shares / 1e6).toFixed(1)}M</dd></div>
                <div class="stat-row"><dt>BTC per share</dt>
                    <dd>${nav.btcPerShare.toFixed(6)}</dd></div>
                <div class="stat-row"><dt>BTC value per share</dt>
                    <dd>${btcPrice ? fmtEq(nav.btcPerShare * btcPrice) : '—'}</dd></div>
            </dl>
            <p class="asset-note">
                Share count is diluted, from the latest SEC filing
                (${nav.sharesAsOfDate}) — quarterly, so it lags recent issuance.
                These companies issue stock frequently to buy Bitcoin, so mNAV
                is indicative rather than precise between filings.
            </p>` : `<p class="asset-empty">Share count unavailable — mNAV cannot be computed.</p>`}
        </section>` : ''}

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
        </section>
    `;

    renderAssetChart(key);
}

// Indexed comparison chart: both series rebased to 100 so they share one axis.
function renderAssetChart(key) {
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

    const tMin = start, tMax = Math.max(ai[ai.length - 1].ts, bi[bi.length - 1].ts);
    const all = [...ai, ...bi].map(p => p.v);
    const lo = Math.min(...all), hi = Math.max(...all);
    // Log scale: these can diverge by 10x+, which a linear axis would flatten.
    const lLo = Math.log10(Math.max(lo, 1)), lHi = Math.log10(hi);

    const x = ts => padL + ((ts - tMin) / (tMax - tMin)) * (w - padL - padR);
    const y = v => padT + (1 - (Math.log10(Math.max(v, 1)) - lLo) / (lHi - lLo || 1)) * (h - padT - padB);
    const path = pts => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');

    const ticks = [];
    for (let e = Math.floor(lLo); e <= Math.ceil(lHi); e++) {
        for (const m of [1, 2, 5]) {
            const v = m * Math.pow(10, e);
            if (v < lo || v > hi) continue;
            ticks.push(v);
        }
    }

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
        <path d="${path(bi)}" class="chart-line-price"/>
        <path d="${path(ai)}" class="chart-line-real"/>
    `;

    const legend = document.createElement('div');
    legend.className = 'chart-legend asset-legend';
    legend.innerHTML = `
        <span class="lg-item"><span class="lg-swatch lg-real"></span>${key}</span>
        <span class="lg-item"><span class="lg-swatch lg-price"></span>BTC</span>
        <span class="lg-item lg-hint">log scale · both = 100 at ${new Date(start).toISOString().slice(0, 10)}${
            pivot && start === pivot ? ` · from ${meta.label} treasury pivot` : ''}</span>`;
    svg.parentElement.parentElement.insertBefore(legend, svg.parentElement);
}
