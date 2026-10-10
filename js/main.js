// ── Cycle Tide — main orchestration ─────────────────────────────────────────

const SIGNAL_MIN_WEIGHT_PCT = 0; // shown regardless; confidence reflects available weight

const sleep = ms => new Promise(r => setTimeout(r, ms));

// All loaded series live here so any past date can be scored without refetching.
let SERIES = null;

async function loadAllSignals() {
    // NUPL is the only on-chain series left in the model, so bitcoin-data.com
    // (10 requests/hour) now costs one request per load instead of three.
    const [daily, nupl, stableSupply, fearGreed, etfFlows, btcHistory] =
        await Promise.all([
            fetchBTCDaily(),
            fetchNupl(),
            fetchStablecoinSupply(),
            fetchFearGreed(),
            fetchEtfFlows(),
            fetchBtcHistory(),
        ]);

    // Issuer-published live figures (MSTR) and the 8-K capital table (ASST).
    // Deliberately not in the Promise.all above: neither is a signal input and
    // neither must ever be able to fail the load.
    await fetchIssuerFigures();

    if (!daily || !daily.length) {
        throw new Error('Could not load BTC price history (Binance klines) — cannot compute anything.');
    }

    const supply = estimateCirculatingSupply(daily[daily.length - 1].ts);

    const ma200w = computeMa200wRank(daily, btcHistory);

    SERIES = {
        daily,
        btcHistory,                      // kept so live ticks can re-rank
        ma200w_raw:   ma200w.multiples,  // the multiple itself, for display
        ath_drawdown: computeAthDrawdown(daily).series,
        ma200w_mult:  ma200w.series,
        rsi_monthly:  computeMonthlyRSI(daily).series,
        etf_flow:     etfFlows ? computeEtfFlowPercentile(etfFlows) : [],
        ssr:          stableSupply ? computeSSRPercentileSeries(daily, supply, stableSupply) : [],
        nupl:         nupl      || [],
        fear_greed:   fearGreed || [],
    };

    return SERIES;
}

// Signal values as they stood on a given date (latest reading at/before ts).
// Every signal is backed by a full historical series, so this works for any
// date in range — that's what powers the date browser.
function valuesAsOf(ts) {
    // Derived from the definitions so the list cannot drift from the model.
    const keys = SIGNAL_DEFS.map(d => d.key);
    const values = {};
    for (const k of keys) values[k] = latestAsOf(SERIES[k], ts, k);
    return values;
}

// Price / ATH context as of a date (ATH = running high up to that date).
function contextAsOf(ts) {
    const upto = SERIES.daily.filter(d => d.ts <= ts);
    if (!upto.length) return { price: null, ath: null, athTs: null };
    // ATH by intraday high (the conventional definition); current level by close.
    let ath = -Infinity, athTs = null;
    for (const d of upto) {
        const high = d.high ?? d.close;
        if (high > ath) { ath = high; athTs = d.ts; }
    }
    return {
        price: upto[upto.length - 1].close,
        ath,
        athTs,
        actualTs: upto[upto.length - 1].ts,
    };
}

// Below this share of model weight, renormalising over what's left produces a
// number that looks authoritative but is driven by whichever signals happened
// to load. Report it as indeterminate instead.
//
// Raised from 0.55 to 0.70: at 55% a verdict could rest on barely half the
// model while presenting with full confidence. Three-quarters is a more
// defensible floor for showing a directional call at all.
const MIN_SCOREABLE_WEIGHT = 0.70;

// A daily metric that has not advanced in this many days is being served from
// a stale snapshot, not merely published late. Two days absorbs weekends and
// normal publication lag; beyond that the value no longer describes today.
const STALE_SIGNAL_DAYS = 3;

function computeComposite(values) {
    let weightedSum = 0, availableWeight = 0;
    const byCategory = {};

    const breakdown = SIGNAL_DEFS.map(def => {
        const raw = values[def.key];
        const score = def.score(raw);
        const cat = byCategory[def.category] ||= { total: 0, available: 0 };
        cat.total += def.weight;
        if (score !== null) {
            weightedSum += score * def.weight;
            availableWeight += def.weight;
            cat.available += def.weight;
        }
        return { ...def, raw, score };
    });

    const confidence = availableWeight / TOTAL_WEIGHT;
    const composite = availableWeight > 0 ? weightedSum / availableWeight : null;

    // Which whole categories are dark? Losing an entire pillar (e.g. all
    // on-chain valuation) skews the composite even when total weight looks OK.
    const missingCategories = Object.entries(byCategory)
        .filter(([, c]) => c.available === 0)
        .map(([name]) => CATEGORY_LABELS[name] || name);

    const reliable = confidence >= MIN_SCOREABLE_WEIGHT && missingCategories.length === 0;

    return {
        composite, confidence, availableWeight, breakdown,
        byCategory, missingCategories, reliable,
    };
}

// The band names say how cheap or expensive price is, and nothing about which
// way the market is heading. They used to name a market phase ("Phase 2 — Early
// Bull", "Late Bull"), which the score cannot know: it passes through 55-75 on
// the way up from a low and again on the way down from a top. In December 2025
// it read 70 and was labelled "Early Bull" two months into a bear market.
function phaseForScore(score) {
    if (score === null) return { label: 'Unknown', signal: 'hold' };
    if (score >= 75) return { label: 'Deep discount', signal: 'accumulate' };
    if (score >= 55) return { label: 'Discounted',    signal: 'accumulate' };
    if (score >= 35) return { label: 'Mid-range',     signal: 'hold' };
    if (score >= 15) return { label: 'Stretched — distribution watch', signal: 'distribute' };
    return { label: 'Overheated — distribution', signal: 'distribute' };
}

function fmtUSD(v) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtPct(v, digits = 1) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v * 100).toFixed(digits) + '%';
}

function daysBetween(a, b) { return Math.round(Math.abs(a - b) / 86400000); }

// The date currently being viewed (midnight UTC). null = live/today.
let viewTs = null;

function isToday(ts) {
    const last = SERIES.daily[SERIES.daily.length - 1].ts;
    return ts >= last;
}

function renderFor(ts) {
    viewTs = ts;
    // On an equity tab the date browser drives that view instead; re-render it
    // and skip the BTC-only DOM below, which does not exist there.
    if (typeof activeTab !== 'undefined' && activeTab !== 'BTC') {
        renderDateControls(contextAsOf(ts).actualTs);
        renderAssetView(activeTab);
        return;
    }
    const values = valuesAsOf(ts);
    const ctx = contextAsOf(ts);
    const scored = computeComposite(values);
    const { composite, confidence, breakdown, reliable, missingCategories } = scored;
    const phase = phaseForScore(composite);

    // Gauge. When too little of the model is available, the number is still
    // shown (it's the best estimate we have) but it is NOT dressed up as a
    // signal — renormalising over a fraction of the weights would otherwise
    // produce a confident-looking call driven by whichever signals loaded.
    document.getElementById('scoreValue').textContent =
        composite === null ? '—' : Math.round(composite);
    const ring = document.getElementById('scoreRing');
    const pct = composite === null ? 0 : composite / 100;
    const circumference = 2 * Math.PI * 80;
    ring.style.strokeDasharray = `${circumference}`;
    ring.style.strokeDashoffset = `${circumference * (1 - pct)}`;
    ring.setAttribute('class', 'score-ring-fg ' +
        (reliable ? signalClass(phase.signal) : 'sig-degraded'));

    document.getElementById('phaseBadge').textContent =
        reliable ? phase.label : 'Insufficient data';

    const sigEl = document.getElementById('signalBadge');
    if (reliable) {
        sigEl.textContent = phase.signal.toUpperCase();
        sigEl.className = 'signal-pill ' + signalClass(phase.signal);
        document.getElementById('signalSub').textContent = signalSubtext(phase.signal, ctx.actualTs);
    } else {
        sigEl.textContent = 'NO CALL';
        sigEl.className = 'signal-pill sig-degraded';

        // Prefer the concrete cause (e.g. "provider rate-limited") over the
        // generic "no data", so it's clear whether this is a transient outage
        // or genuinely missing history.
        const causes = [...new Set(
            breakdown.filter(b => b.score === null)
                     .map(b => unavailableReason(b.key))
                     .filter(Boolean)
        )];
        const why = causes.length
            ? causes.join('; ')
            : missingCategories.length
                ? `No data for: ${missingCategories.join(', ')}`
                : `Only ${Math.round(confidence * 100)}% of model weight available`;
        document.getElementById('signalSub').textContent =
            `${why} — score shown for reference only`;
    }

    document.getElementById('btcPrice').textContent = fmtUSD(ctx.price);
    document.getElementById('athPrice').textContent = fmtUSD(ctx.ath);
    document.getElementById('drawdownVal').textContent = fmtPct(values.ath_drawdown);
    document.getElementById('daysSinceAth').textContent =
        ctx.athTs ? daysBetween(ctx.actualTs, ctx.athTs) : '—';

    const scoredCount = breakdown.filter(b => b.score !== null).length;
    const confPct = Math.round(confidence * 100);
    let confLabel = confidence >= 0.85 ? 'High' : confidence >= 0.6 ? 'Medium' : 'Low';

    // "Available" is not the same as "current". A signal served from a stale
    // snapshot still counts toward model weight, so without this the header
    // could read "100% of model weight" while a quarter of it was days old.
    //
    // Only meaningful when viewing the LATEST bar — when browsing history every
    // value is old by construction and its age says nothing. Compare against
    // the last bar rather than testing `viewTs === null`, because renderFor()
    // assigns viewTs before reaching this point, so that test never fires.
    const stale = [];
    if (ctx.actualTs >= dayBounds().last) {
        for (const b of breakdown) {
            if (b.score === null) continue;
            const vts = VALUE_TS[b.key];
            if (!vts) continue;
            const days = Math.floor((ctx.actualTs - vts) / 86400000);
            if (days >= STALE_SIGNAL_DAYS) stale.push({ label: b.label, days, weight: b.weight });
        }
    }
    stale.sort((a, b) => b.days - a.days);

    const staleWeight = stale.reduce((sum, x) => sum + x.weight, 0);
    // Data this old is a real dent in the read, not a footnote.
    if (staleWeight >= 25 && confLabel === 'High') confLabel = 'Medium';

    const conf = document.getElementById('confidenceVal');
    conf.textContent =
        `${confLabel} (${scoredCount}/${breakdown.length} signals available, ${confPct}% of model weight`
        + (stale.length ? `; ${staleWeight}% of weight is ${stale[0].days}d stale)` : ')');
    conf.title = stale.length
        ? 'Served from a cached snapshot rather than a live fetch:\n'
          + stale.map(x => `  ${x.label} — ${x.days} day${x.days === 1 ? '' : 's'} old (${x.weight}% weight)`).join('\n')
        : '';
    conf.classList.toggle('conf-stale', stale.length > 0);

    renderScoreDelta(ts, composite);
    // The 200-week row is scored on a rank but people know it as a multiple,
    // so hand the multiple for this date to its formatter as well.
    const maRow = breakdown.find(b => b.key === 'ma200w_mult');
    if (maRow) maRow.extra = latestAsOf(SERIES.ma200w_raw, ts + 86400000 - 1);
    renderBreakdown(breakdown);
    renderCycleClock(ctx.actualTs);
    renderDateControls(ctx.actualTs);
}

// Trajectory: where the score sat 7 and 30 days before the date being viewed.
// A bare number says nothing about direction, and direction is most of what
// matters when reading a cycle position.
function renderScoreDelta(ts, composite) {
    const el = document.getElementById('scoreDelta');
    if (!el) return;
    if (composite === null) { el.innerHTML = ''; return; }

    const at = back => {
        const c = computeComposite(valuesAsOf(ts - back * 86400000));
        return (c.composite !== null && c.confidence >= MIN_SCOREABLE_WEIGHT)
            ? c.composite : null;
    };
    const parts = [[7, '7d'], [30, '30d']].map(([d, lbl]) => {
        const prev = at(d);
        if (prev === null) return `<span class="delta-item delta-na">${lbl} —</span>`;
        const diff = composite - prev;
        const cls = Math.abs(diff) < 0.5 ? 'delta-flat' : diff > 0 ? 'delta-up' : 'delta-down';
        const sign = diff > 0 ? '+' : '';
        return `<span class="delta-item ${cls}">${lbl} ${sign}${diff.toFixed(1)}</span>`;
    });
    el.innerHTML = parts.join('');
}

// ── Date browser ────────────────────────────────────────────────────────────

function dayBounds() {
    return {
        first: SERIES.daily[0].ts,
        last:  SERIES.daily[SERIES.daily.length - 1].ts,
    };
}

function renderDateControls(actualTs) {
    const { first, last } = dayBounds();
    const input = document.getElementById('viewDate');
    const iso = new Date(actualTs).toISOString().slice(0, 10);
    input.value = iso;
    input.min = new Date(first).toISOString().slice(0, 10);
    input.max = new Date(last).toISOString().slice(0, 10);

    document.getElementById('prevDay').disabled = actualTs <= first;
    document.getElementById('nextDay').disabled = actualTs >= last;
    document.getElementById('todayBtn').disabled = actualTs >= last;

    const badge = document.getElementById('asOfBadge');
    if (actualTs >= last) {
        badge.textContent = 'Viewing: latest';
        badge.className = 'asof-badge asof-live';
    } else {
        const ago = daysBetween(last, actualTs);
        badge.textContent = `Viewing: ${iso} (${ago}d ago)`;
        badge.className = 'asof-badge asof-past';
    }
}

function stepDay(delta) {
    const { first, last } = dayBounds();
    // Move by index within the daily series so gaps/weekends behave sanely.
    const days = SERIES.daily;
    let idx = days.findIndex(d => d.ts >= viewTs);
    if (idx < 0) idx = days.length - 1;
    idx = Math.max(0, Math.min(days.length - 1, idx + delta));
    renderFor(days[idx].ts);
}

function signalClass(signal) {
    return signal === 'accumulate' ? 'sig-good' : signal === 'distribute' ? 'sig-critical' : 'sig-warning';
}
// The line under the call. The score measures price level, not direction, and
// two consequences of that are spelled out here rather than left to be found
// out the hard way.
//
// Early in a bear market the score reads "cheap" long before the low: after
// each of the last three tops (Apr 2021, Nov 2021, Oct 2025) it reached 55+
// within 24-37 days and price fell a further 36%, 68% and 42%. Adding price
// trend to the score was tested (2026-10-10) and not adopted — see the README,
// "What the score does not measure". The cycle clock is the one thing that
// tells those readings apart, so the caution is keyed to it: after the stretch
// where earlier cycles topped and before the stretch where they bottomed.
// Wording only; the number and the call are unchanged.
function signalSubtext(signal, ts) {
    if (signal === 'distribute') return 'Historically distribution-risk zone';
    if (signal !== 'accumulate') {
        return 'Neither cheap nor expensive. The score reads price level, not direction: '
             + 'it peaks at a low and falls as price recovers.';
    }
    const c = typeof cycleClock === 'function' ? cycleClock(ts) : null;
    const early = c && c.tops && c.bottoms && c.day > c.tops.hi && c.day < c.bottoms.lo;
    if (!early) return 'Historically accumulation-favorable zone';
    return 'Cheap against history, but early: earlier cycles were still falling at this point '
         + '(see the clock below). After each of the last three tops the score got here within '
         + '3–5 weeks and price fell a further 36–68%.';
}

// Which signals are currently expanded — kept outside the render so the panel
// survives a live-price re-render instead of snapping shut every few seconds.
const expandedSignals = new Set();

function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderBreakdown(breakdown) {
    const container = document.getElementById('breakdownList');
    container.innerHTML = '';
    const sorted = [...breakdown].sort((a, b) => b.weight - a.weight);

    for (const item of sorted) {
        const row = document.createElement('div');
        const isOpen = expandedSignals.has(item.key);
        row.className = 'breakdown-row'
            + (item.score === null ? ' unscored' : '')
            + (isOpen ? ' expanded' : '');

        const pct = item.score === null ? 0 : item.score / 100;
        const contributed = item.score === null ? null : (item.score * item.weight / 100);
        const info = item.info;

        row.innerHTML = `
            <button class="breakdown-toggle" aria-expanded="${isOpen}"
                    aria-controls="info-${item.key}">
                <div class="breakdown-head">
                    <span class="breakdown-label">
                        <span class="disclosure" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
                        ${escapeHtml(item.label)}
                    </span>
                    <span class="breakdown-points">${contributed === null ? '—' : contributed.toFixed(1)} / ${item.weight}</span>
                </div>
                <div class="breakdown-bar-track">
                    <div class="breakdown-bar-fill ${item.score === null ? '' : barClass(item.score)}" style="width:${pct * 100}%"></div>
                </div>
                <div class="breakdown-detail">
                    ${item.score === null
                        ? escapeHtml('not scored — ' +
                            (unavailableReason(item.key) || 'no data for this date'))
                        : escapeHtml(String(item.fmt(item.raw, item.extra)))}
                </div>
            </button>
            ${info ? `
            <div class="signal-info" id="info-${item.key}" ${isOpen ? '' : 'hidden'}>
                <div class="info-block">
                    <span class="info-label">What it tracks</span>
                    <p>${escapeHtml(info.tracks)}</p>
                </div>
                <div class="info-block">
                    <span class="info-label">Why it matters</span>
                    <p>${escapeHtml(info.why)}</p>
                </div>
                <div class="info-block">
                    <span class="info-label">How it reads</span>
                    <ul class="info-scale">
                        ${info.scale.map(([range, meaning, tone]) => `
                            <li class="tone-${tone}">
                                <span class="scale-range">${escapeHtml(range)}</span>
                                <span class="scale-meaning">${escapeHtml(meaning)}</span>
                            </li>`).join('')}
                    </ul>
                </div>
                <div class="info-block info-caveat">
                    <span class="info-label">Caveat</span>
                    <p>${escapeHtml(info.caveat)}</p>
                </div>
                <div class="info-source">
                    ${escapeHtml(info.source)}
                    · weight ${item.weight} of ${TOTAL_WEIGHT}
                </div>
            </div>` : ''}
        `;

        const toggle = row.querySelector('.breakdown-toggle');
        if (info && toggle) {
            toggle.addEventListener('click', () => {
                if (expandedSignals.has(item.key)) expandedSignals.delete(item.key);
                else expandedSignals.add(item.key);
                renderBreakdown(breakdown);
            });
        } else if (toggle) {
            toggle.disabled = true;
        }

        container.appendChild(row);
    }
}

function barClass(score) {
    if (score >= 65) return 'bar-good';
    if (score >= 35) return 'bar-warning';
    return 'bar-critical';
}

// Backtest table: where the model has real data (2022+ for on-chain), the
// score is computed live from the same series the dashboard uses. Older
// events keep their documented reference reading, clearly marked, since no
// free API backfills on-chain history that far.
function renderBacktest() {
    const tbody = document.getElementById('backtestBody');
    tbody.innerHTML = '';
    const { first, last } = dayBounds();

    for (const ev of BACKTEST_EVENTS) {
        const evTs = Date.parse(ev.date + 'T00:00:00Z');   // the event's own day
        if (evTs < first || evTs > last) continue;   // no data — omit entirely

        const c = computeComposite(valuesAsOf(evTs));
        // Only show rows the model can actually score. Hardcoded estimates
        // sitting beside computed values invited false equivalence.
        if (c.composite === null || c.confidence < 0.5) continue;
        const score = Math.round(c.composite);
        const computed = true;
        const inRange = true;
        const phase = phaseForScore(score);

        const tr = document.createElement('tr');
        if (inRange) tr.className = 'clickable-row';
        tr.innerHTML = `
            <td>${ev.label}</td>
            <td><span class="score-chip">${score}</span></td>
            <td><span class="signal-chip ${signalClass(phase.signal)}">${phase.signal.toUpperCase()}</span></td>
            <td>${phase.label}</td>
        `;
        if (inRange) {
            tr.title = 'Click to view the full breakdown for this date';
            tr.addEventListener('click', () => {
                renderFor(evTs);
                document.querySelector('.grid-top').scrollIntoView({ behavior: 'smooth' });
            });
        }
        tbody.appendChild(tr);
    }
}

async function init() {
    const statusEl = document.getElementById('liveStatus');
    try {
        await loadAllSignals();
        const { last } = dayBounds();
        renderFor(last);
        renderBacktest();
        renderScoreChart();

        // Start the price stream before the asset snapshot fetch — that fetch
        // is slower, and awaiting it first left the ticker showing an em dash
        // long after the socket was ready.
        startLive();

        // Asset tabs (BTC / MSTR / Strive). Equity data is independent of the
        // BTC pipeline, so a failure there must not block the main dashboard.
        await loadAssetData().catch(e => console.warn('[cycletide] asset data:', e));
        renderTabs();
        renderAllocation();
        renderDataAge();
        if (activeTab !== 'BTC') switchTab(activeTab);

        // Date browser controls
        document.getElementById('prevDay').addEventListener('click', () => stepDay(-1));
        document.getElementById('nextDay').addEventListener('click', () => stepDay(1));
        document.getElementById('todayBtn').addEventListener('click', () => renderFor(dayBounds().last));
        document.getElementById('viewDate').addEventListener('change', e => {
            const ts = new Date(e.target.value + 'T00:00:00Z').getTime();
            if (!isNaN(ts)) renderFor(ts);
        });
        // Price panel toggle
        const priceToggle = document.getElementById('togglePrice');
        if (priceToggle) {
            priceToggle.checked = showPricePanel;
            priceToggle.addEventListener('change', e => {
                showPricePanel = e.target.checked;
                try { localStorage.setItem('cycletide_show_price', showPricePanel ? '1' : '0'); } catch {}
                renderScoreChart();
            });
        }

        // Arrow keys step days when not typing in a field.
        document.addEventListener('keydown', e => {
            if (e.target.tagName === 'INPUT') return;
            if (e.key === 'ArrowLeft')  { e.preventDefault(); stepDay(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); stepDay(1); }
        });

        // Re-render the chart when crossing the mobile/desktop breakpoint
        // (rotation, window resize) so its geometry matches the viewport.
        let _resizeTimer = null;
        window.addEventListener('resize', () => {
            clearTimeout(_resizeTimer);
            _resizeTimer = setTimeout(() => {
                if (chartGeometryChanged()) renderScoreChart();
            }, 200);
        });

        // (live stream already started above, before the asset fetch)
    } catch (err) {
        console.error(err);
        statusEl.textContent = 'Error loading data: ' + err.message;
        statusEl.className = 'live-dot live-err';
    }
}

document.addEventListener('DOMContentLoaded', init);

// ── Keeping an open page current ────────────────────────────────────────────
//
// Previously nothing did. The snapshot loaders memoized their first fetch for
// the life of the page, and "Refresh data" re-ran only the BTC signals — it
// never refetched the treasury, ETF or Strive files and never re-rendered the
// allocation or the treasury tabs. A tab left open showed whatever it loaded
// first, while the live BTC ticker kept streaming and made it look current.
//
// Two cadences, both paused while the tab is hidden:
//   every 5 min   live quotes (MSTR issuer API, ASST quote feed) and every
//                 figure derived from them — cheap, no files
//   every 30 min  the committed files as well, in case the workflow has
//                 published newer ones since the page opened
const QUOTE_REFRESH_MS = 5 * 60 * 1000;
const FILE_REFRESH_MS = 30 * 60 * 1000;
let _refreshing = false;
let _lastFileRefresh = Date.now();

// Re-render without moving the reader: a historical date stays on that date,
// the latest view follows the data forward, the active tab stays put.
function rerenderAll(wasLatest, previousViewTs) {
    const target = wasLatest ? dayBounds().last : previousViewTs;
    renderFor(target);     // on a treasury tab this renders that tab instead
    if (activeTab === 'BTC') {
        renderBacktest();
        renderScoreChart();
    }
    // (on a treasury tab the BTC chart is hidden; switchTab redraws it on return)
    renderAllocation();
    renderDataAge();
}

async function refreshAll({ files = true, force = false } = {}) {
    if (_refreshing) return;
    _refreshing = true;
    const previousViewTs = viewTs;
    const wasLatest = viewTs === null || viewTs >= dayBounds().last;
    if (files) { resetSnapshotCaches(); _lastFileRefresh = Date.now(); }
    if (force) FORCE_REFRESH = true;
    try {
        await loadAllSignals();           // BTC signals + onchain/ETF files + MSTR issuer
        await loadAssetData();            // treasury file + live quotes + Strive 8-K
        rerenderAll(wasLatest, previousViewTs);
    } finally {
        FORCE_REFRESH = false;
        _refreshing = false;
    }
}

async function refreshQuotes() {
    if (_refreshing) return;
    _refreshing = true;
    try {
        await fetchIssuerFigures();
        await refreshAssetQuotes();
        renderAllocation();
        if (activeTab !== 'BTC') renderAssetView(activeTab);
        renderDataAge();
    } finally {
        _refreshing = false;
    }
}

function fmtAgo(ts) {
    if (!ts) return null;
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
}

// What the page is actually built from, and how old each piece is. A live BTC
// ticker next to a two-day-old treasury file used to imply the whole page was
// live; this says which parts are.
function renderDataAge() {
    const el = document.getElementById('dataAge');
    if (!el) return;
    const gen = p => SNAPSHOT_META[p]?.generated ? Date.parse(SNAPSHOT_META[p].generated) : null;
    const lastDay = s => s?.length ? new Date(s[s.length - 1].ts).toISOString().slice(0, 10) : '—';

    const files = gen('data/treasuries.json');
    const quotes = typeof LIVE_QUOTES_AT !== 'undefined' ? LIVE_QUOTES_AT : null;
    el.textContent = [
        quotes ? `share prices live, ${fmtAgo(quotes)}` : 'share prices from last snapshot',
        files ? `data files ${fmtAgo(files)}` : null,
    ].filter(Boolean).join(' · ');

    const asst = typeof ISSUER !== 'undefined' ? ISSUER.ASST : null;
    el.title = [
        `Share prices: ${quotes ? 'live quotes, fetched ' + fmtAgo(quotes) : 'last committed daily close'}`,
        `Price history & holdings file: ${files ? fmtAgo(files) : 'not loaded'}`,
        `Strive capital table: 8-K as of ${asst?.asOf || '—'}`,
        `ETF flows: through ${lastDay(SERIES?.etf_flow)}`,
        `On-chain (NUPL): through ${lastDay(SERIES?.nupl)} — the provider publishes about a week behind`,
        'Files are refreshed by a scheduled job several times a day; this page rechecks them every 30 min.',
    ].join('\n');
}

document.addEventListener('DOMContentLoaded', () => {
    // Manual refresh: force past any rate-limit cooldown and refetch
    // everything — files included. Retrying what is dark is the point.
    const btn = document.getElementById('refreshBtn');
    if (btn) btn.addEventListener('click', async () => {
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Refreshing…';
        try {
            await refreshAll({ files: true, force: true });
        } catch (err) {
            console.error('[cycletide] refresh failed:', err);
        } finally {
            btn.disabled = false;
            btn.textContent = original;
        }
    });

    setInterval(() => {
        if (document.hidden || !SERIES) return;
        const due = Date.now() - _lastFileRefresh >= FILE_REFRESH_MS;
        (due ? refreshAll({ files: true }) : refreshQuotes())
            .catch(e => console.warn('[cycletide] background refresh:', e));
    }, QUOTE_REFRESH_MS);

    // Coming back to a tab that sat hidden: catch up at once rather than at
    // the next tick, since the interval was skipping while it was hidden.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden || !SERIES) return;
        const due = Date.now() - _lastFileRefresh >= FILE_REFRESH_MS;
        (due ? refreshAll({ files: true }) : refreshQuotes())
            .catch(e => console.warn('[cycletide] refresh on return:', e));
    });
});
