// ── Cycle Tide — main orchestration ─────────────────────────────────────────

const SIGNAL_MIN_WEIGHT_PCT = 0; // shown regardless; confidence reflects available weight

// bitcoin-data.com rate-limits aggressively (per-IP, per-minute) — space
// these out rather than firing them concurrently or back-to-back.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchOnchainSequential() {
    const mvrv = await fetchMvrvZScore();   await sleep(600);
    const nupl = await fetchNupl();         await sleep(600);
    const puell = await fetchPuellMultiple();
    return { mvrv, nupl, puell };
}

// All loaded series live here so any past date can be scored without refetching.
let SERIES = null;

async function loadAllSignals() {
    const [daily, onchain, stableSupply, fearGreed, funding, etfFlows] =
        await Promise.all([
            fetchBTCDaily(),
            fetchOnchainSequential(),
            fetchStablecoinSupply(),
            fetchFearGreed(),
            fetchFundingRate(),
            fetchEtfFlows(),
        ]);
    const { mvrv, nupl, puell } = onchain;

    if (!daily || !daily.length) {
        throw new Error('Could not load BTC price history (Binance klines) — cannot compute anything.');
    }

    const supply = estimateCirculatingSupply(daily[daily.length - 1].ts);

    SERIES = {
        daily,
        ath_drawdown: computeAthDrawdown(daily).series,
        ma200w_mult:  computeMa200wMultiple(daily).series,
        rsi_monthly:  computeMonthlyRSI(daily).series,
        pi_cycle:     computePiCycle(daily).series,
        etf_flow:     etfFlows ? computeEtfFlowPercentile(etfFlows) : [],
        ssr:          stableSupply ? computeSSRPercentileSeries(daily, supply, stableSupply) : [],
        mvrv_z:       mvrv      || [],
        nupl:         nupl      || [],
        puell:        puell     || [],
        funding:      funding   || [],
        fear_greed:   fearGreed || [],
    };

    return SERIES;
}

// Signal values as they stood on a given date (latest reading at/before ts).
// Every signal is backed by a full historical series, so this works for any
// date in range — that's what powers the date browser.
function valuesAsOf(ts) {
    const keys = ['ath_drawdown', 'mvrv_z', 'nupl', 'puell', 'pi_cycle',
                  'ma200w_mult', 'ssr', 'funding', 'fear_greed', 'rsi_monthly',
                  'etf_flow'];
    const values = {};
    for (const k of keys) values[k] = latestAsOf(SERIES[k], ts);
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
const MIN_SCOREABLE_WEIGHT = 0.55;

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

function phaseForScore(score) {
    if (score === null) return { label: 'Unknown', signal: 'hold' };
    if (score >= 75) return { label: 'Phase 1 — Accumulation', signal: 'accumulate' };
    if (score >= 55) return { label: 'Phase 2 — Early Bull',   signal: 'accumulate' };
    if (score >= 35) return { label: 'Neutral / Transition',   signal: 'hold' };
    if (score >= 15) return { label: 'Late Bull / Distribution Watch', signal: 'distribute' };
    return { label: 'Phase 4 — Distribution', signal: 'distribute' };
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
        document.getElementById('signalSub').textContent = signalSubtext(phase.signal);
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
    const confLabel = confidence >= 0.85 ? 'High' : confidence >= 0.6 ? 'Medium' : 'Low';
    document.getElementById('confidenceVal').textContent =
        `${confLabel} (${scoredCount}/${breakdown.length} signals available, ${confPct}% of model weight)`;

    renderBreakdown(breakdown);
    renderDateControls(ctx.actualTs);
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
function signalSubtext(signal) {
    if (signal === 'accumulate') return 'Historically accumulation-favorable zone';
    if (signal === 'distribute') return 'Historically distribution-risk zone';
    return 'Mixed signals — no strong historical edge';
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
                        : escapeHtml(String(item.fmt(item.raw)))}
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
        const evTs = new Date(ev.date + '-15').getTime();
        const inRange = evTs >= first && evTs <= last;

        let score = ev.score, computed = false;
        if (inRange) {
            const c = computeComposite(valuesAsOf(evTs));
            if (c.composite !== null && c.confidence >= 0.5) {
                score = Math.round(c.composite);
                computed = true;
            }
        }
        const phase = phaseForScore(score);

        const tr = document.createElement('tr');
        if (inRange) tr.className = 'clickable-row';
        tr.innerHTML = `
            <td>${ev.label}</td>
            <td><span class="score-chip">${score}</span></td>
            <td><span class="signal-chip ${signalClass(phase.signal)}">${phase.signal.toUpperCase()}</span></td>
            <td>${phase.label}</td>
            <td class="src-cell">${computed ? 'computed' : 'reference'}</td>
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
        renderTrendCard();

        // Asset tabs (BTC / MSTR / Strive). Equity data is independent of the
        // BTC pipeline, so a failure there must not block the main dashboard.
        await loadAssetData().catch(e => console.warn('[cycletide] asset data:', e));
        renderTabs();
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

        // Live updates are always on — no toggle, the way an exchange behaves.
        startLive();
    } catch (err) {
        console.error(err);
        statusEl.textContent = 'Error loading data: ' + err.message;
        statusEl.className = 'live-dot live-err';
    }
}

// Trend structure card (BTC tab, context only — see js/trendline.js).
function renderTrendCard() {
    const host = document.getElementById('trendCard');
    if (!host || !SERIES?.daily) return;
    host.innerHTML = renderTrendStructure(SERIES.daily);
    bindMetricToggles();
}

document.addEventListener('DOMContentLoaded', init);

// Manual refresh: force past any active rate-limit cooldown and refetch in
// place. Retrying the signals that are dark is the whole point, so this
// deliberately bypasses both the TTL and the backoff.
document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('refreshBtn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Refreshing…';
        FORCE_REFRESH = true;
        try {
            await loadAllSignals();
            renderFor(dayBounds().last);
            renderBacktest();
            renderScoreChart();
        } catch (err) {
            console.error('[cycletide] refresh failed:', err);
        } finally {
            FORCE_REFRESH = false;
            btn.disabled = false;
            btn.textContent = original;
        }
    });
});
