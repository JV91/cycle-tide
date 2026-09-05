// ── Cycle Tide — historical score chart (inline SVG, no dependencies) ──────
// One primary series (the composite score over time) plus a clearly-distinct
// projected segment. Emphasis form: the real history is the subject; the
// projection is visually subordinate (dashed, muted) so it never reads as
// measured data.

// Two stacked panels sharing one time axis: score on top, BTC price below.
// Deliberately NOT a dual-axis overlay — score (0-100) and price (log USD)
// have no common scale, so overlaying them on one plot would invent
// crossovers that are artifacts of axis alignment rather than real signal.
// Stacked panels let you read "score was high while price was low" off the
// vertical alignment, which is the actual question, without that distortion.
// Desktop geometry. On a phone the same CSS width maps onto a much narrower
// viewBox, which proportionally enlarges text and strokes — otherwise axis
// labels render at ~4 effective pixels and are unreadable.
const CHART_DESKTOP = {
    w: 1000,
    h: 300,            // score-only height
    hWithPrice: 450,   // total height when the price panel is shown
    priceH: 130,       // height of the price panel itself
    panelGap: 22,
    padL: 44, padR: 16, padT: 16, padB: 28,
};

const CHART_MOBILE = {
    w: 460,
    h: 240,
    hWithPrice: 400,
    priceH: 120,
    panelGap: 20,
    padL: 40, padR: 10, padT: 14, padB: 26,
};

// Mutable so the render path can keep reading CHART.* unchanged.
let CHART = { ...CHART_DESKTOP };

function syncChartGeometry() {
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    CHART = { ...(narrow ? CHART_MOBILE : CHART_DESKTOP) };
}

// True when the viewport has crossed the breakpoint since the last render,
// so the caller knows a re-render is actually needed.
function chartGeometryChanged() {
    const narrow = window.matchMedia('(max-width: 640px)').matches;
    return (narrow ? CHART_MOBILE.w : CHART_DESKTOP.w) !== CHART.w;
}

// Price panel visibility (persisted so it survives reloads).
let showPricePanel = (() => {
    try { return localStorage.getItem('cycletide_show_price') !== '0'; } catch { return true; }
})();

const DAY_MS = 86400000;

// Below this share of model weight the composite is too thin to plot at all.
const MIN_PLOT_CONFIDENCE = 0.35;
// At or above this, the line is drawn solid; between the two it's drawn faint,
// so sparse-data stretches are visibly weaker rather than silently missing.
const FULL_PLOT_CONFIDENCE = 0.6;

function scoreHistorySeries(stepDays = 7) {
    // Recompute the composite at weekly intervals across the full range where
    // enough signals exist. Weekly (not daily) keeps this ~200 points instead
    // of ~1400 — smooth enough to read, cheap enough to recompute on demand.
    const { first, last } = dayBounds();
    const out = [];
    for (let ts = first; ts <= last; ts += stepDays * DAY_MS) {
        const c = computeComposite(valuesAsOf(ts));
        if (c.composite !== null && c.confidence >= MIN_PLOT_CONFIDENCE) {
            out.push({ ts, value: c.composite, confidence: c.confidence });
        }
    }
    return out;
}

// Split a series into consecutive runs of "strong" vs "weak" confidence so
// each can be stroked differently. Runs overlap by one point to avoid gaps.
function splitByConfidence(pts) {
    const runs = [];
    let cur = null;
    for (const p of pts) {
        const strong = p.confidence >= FULL_PLOT_CONFIDENCE;
        if (!cur || cur.strong !== strong) {
            if (cur) { cur.pts.push(p); runs.push(cur); }
            cur = { strong, pts: [p] };
        } else {
            cur.pts.push(p);
        }
    }
    if (cur) runs.push(cur);
    return runs;
}

function renderScoreChart() {
    const svg = document.getElementById('scoreChart');
    if (!svg) return;
    syncChartGeometry();

    const history = scoreHistorySeries();
    if (!history.length) {
        svg.innerHTML = `<text x="50%" y="50%" text-anchor="middle" class="chart-empty">
            Not enough signal history to plot yet</text>`;
        return;
    }

    const lastReal = history[history.length - 1];
    const proj = projectScoreSeries(lastReal.ts, lastReal.value);

    const allPts = [...history, ...proj.points];
    const tMin = allPts[0].ts;
    const tMax = allPts[allPts.length - 1].ts;

    const { w, padL, padR, padT, padB, priceH, panelGap } = CHART;
    const withPrice = showPricePanel;
    const totalH = withPrice ? CHART.hWithPrice : CHART.h;

    // Score panel occupies the top; price panel (if shown) sits below it,
    // both sharing the same x scale. Only the bottom panel carries the axis.
    const scoreBottom = withPrice ? totalH - padB - priceH - panelGap : totalH - padB;

    const x = ts => padL + ((ts - tMin) / (tMax - tMin)) * (w - padL - padR);
    const y = v  => padT + (1 - v / 100) * (scoreBottom - padT);

    const path = pts => pts.map((p, i) =>
        `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');

    // ── Price panel geometry (log scale — BTC spans orders of magnitude) ──
    const priceTop = scoreBottom + panelGap;
    const priceBottom = totalH - padB;
    const priceSeries = SERIES.daily.filter(d => d.ts >= tMin && d.ts <= tMax);
    const lastPricePt = priceSeries[priceSeries.length - 1];
    const pricePr = lastPricePt
        ? projectPriceSeries(lastPricePt.ts, lastPricePt.close)
        : { points: [], anchors: [], assumptions: priceAssumptions() };

    // Scale must cover both real history and the projected band.
    const priceVals = [
        ...priceSeries.map(d => d.close),
        ...pricePr.points.flatMap(p => [p.lo, p.hi]),
    ];
    const pLo = priceVals.length ? Math.min(...priceVals) : 1;
    const pHi = priceVals.length ? Math.max(...priceVals) : 1;
    const logLo = Math.log10(pLo), logHi = Math.log10(pHi);
    const yPrice = v => {
        const t = (Math.log10(v) - logLo) / (logHi - logLo || 1);
        return priceTop + (1 - t) * (priceBottom - priceTop);
    };
    const pricePath = priceSeries.map((p, i) =>
        `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${yPrice(p.close).toFixed(1)}`).join(' ');

    // Price gridlines at round powers/halves within range.
    const priceTicks = [];
    for (let e = Math.floor(logLo); e <= Math.ceil(logHi); e++) {
        for (const m of [1, 3]) {
            const v = m * Math.pow(10, e);
            if (v < pLo || v > pHi) continue;
            priceTicks.push(v);
        }
    }
    const priceGrid = withPrice ? priceTicks.map(v =>
        `<line x1="${padL}" x2="${w - padR}" y1="${yPrice(v)}" y2="${yPrice(v)}" class="chart-grid"/>
         <text x="${padL - 8}" y="${yPrice(v) + 4}" text-anchor="end" class="chart-axis">${
            v >= 1000 ? '$' + Math.round(v / 1000) + 'k' : '$' + v}</text>`).join('') : '';

    const plotBottom = totalH - padB; // bottom of the lowest visible panel

    // Zone bands (accumulate / neutral / distribute) — score panel only.
    const bands = [
        { from: 75, to: 100, cls: 'band-good' },
        { from: 35, to: 75,  cls: 'band-neutral' },
        { from: 0,  to: 35,  cls: 'band-bad' },
    ].map(b =>
        `<rect x="${padL}" y="${y(b.to)}" width="${w - padL - padR}"
               height="${y(b.from) - y(b.to)}" class="${b.cls}"/>`).join('');

    // Y gridlines + labels at 0/25/50/75/100
    const grid = [0, 25, 50, 75, 100].map(v =>
        `<line x1="${padL}" x2="${w - padR}" y1="${y(v)}" y2="${y(v)}" class="chart-grid"/>
         <text x="${padL - 8}" y="${y(v) + 4}" text-anchor="end" class="chart-axis">${v}</text>`).join('');

    // Year ticks — span every panel, labelled once at the very bottom. On a
    // narrow viewBox the labels would collide, so only every other year is
    // labelled there (the gridline still marks each one).
    const years = [];
    const y0 = new Date(tMin).getUTCFullYear(), y1 = new Date(tMax).getUTCFullYear();
    const labelEvery = (w < 600 && (y1 - y0) > 6) ? 2 : 1;
    for (let yr = y0; yr <= y1; yr++) {
        const ts = Date.UTC(yr, 0, 1);
        if (ts < tMin || ts > tMax) continue;
        const showLabel = (yr - y0) % labelEvery === 0;
        years.push(`<line x1="${x(ts)}" x2="${x(ts)}" y1="${padT}" y2="${plotBottom}" class="chart-grid-v"/>
                    ${showLabel ? `<text x="${x(ts)}" y="${plotBottom + 16}" text-anchor="middle" class="chart-axis">${
                        w < 600 ? "'" + String(yr).slice(2) : yr}</text>` : ''}`);
    }

    // Halving markers — run through both panels so the alignment is readable.
    const halvingMarks = HALVINGS
        .filter(hv => hv.ts >= tMin && hv.ts <= tMax)
        .map(hv => `<line x1="${x(hv.ts)}" x2="${x(hv.ts)}" y1="${padT}" y2="${plotBottom}" class="chart-halving"/>
                    <text x="${x(hv.ts)}" y="${padT + 10}" text-anchor="middle" class="chart-halving-lbl">⌗</text>`)
        .join('');

    // Projection uncertainty band around the projected bottom / top
    const uncertainty = [proj.dates.currentBottom, proj.dates.nextTop]
        .filter(d => d.loTs && d.hiTs && d.hiTs >= tMin && d.loTs <= tMax)
        .map(d => `<rect x="${x(d.loTs)}" y="${padT}" width="${Math.max(1, x(d.hiTs) - x(d.loTs))}"
                         height="${plotBottom - padT}" class="chart-uncertainty"/>`).join('');

    // Projected turning-point markers
    const anchorMarks = proj.anchors
        .filter(a => a.ts >= tMin && a.ts <= tMax)
        .map(a => `<circle cx="${x(a.ts)}" cy="${y(a.score)}" r="4" class="chart-anchor"/>`)
        .join('');

    // Projected price: an uncertainty band with a mid line, never a bare line.
    const bandPath = pricePr.points.length
        ? 'M' + pricePr.points.map(p => `${x(p.ts).toFixed(1)},${yPrice(p.hi).toFixed(1)}`).join(' L')
          + ' L' + [...pricePr.points].reverse()
              .map(p => `${x(p.ts).toFixed(1)},${yPrice(p.lo).toFixed(1)}`).join(' L') + ' Z'
        : '';
    const projMidPath = pricePr.points.map((p, i) =>
        `${i === 0 ? 'M' : 'L'}${x(p.ts).toFixed(1)},${yPrice(p.mid).toFixed(1)}`).join(' ');

    const pricePanel = withPrice ? `
        <text x="${padL + 6}" y="${priceTop + 11}" class="chart-panel-lbl">BTC PRICE (LOG)</text>
        ${priceGrid}
        ${bandPath ? `<path d="${bandPath}" class="chart-price-band"/>` : ''}
        ${projMidPath ? `<path d="${projMidPath}" class="chart-line-price-proj"/>` : ''}
        <path d="${pricePath}" class="chart-line-price"/>
        <circle id="chartHoverDotPrice" r="4" class="chart-hover-dot" style="display:none"/>
    ` : '';

    svg.setAttribute('viewBox', `0 0 ${w} ${totalH}`);
    // Let the SVG scale to its container width at the viewBox aspect ratio,
    // rather than pinning a fixed pixel height that squashes it on a phone.
    svg.style.aspectRatio = `${w} / ${totalH}`;
    svg.style.height = 'auto';
    svg.innerHTML = `
        ${bands}
        ${uncertainty}
        ${grid}
        ${years.join('')}
        ${halvingMarks}
        ${pricePanel}
        <path d="${path(proj.points)}" class="chart-line-proj"/>
        ${splitByConfidence(history).map(run =>
            `<path d="${path(run.pts)}" class="chart-line-real${run.strong ? '' : ' chart-line-weak'}"/>`
          ).join('')}
        ${anchorMarks}
        <circle cx="${x(lastReal.ts)}" cy="${y(lastReal.value)}" r="4.5" class="chart-now"/>
        <line id="chartCrosshair" x1="0" x2="0" y1="${padT}" y2="${plotBottom}"
              class="chart-crosshair" style="display:none"/>
        <circle id="chartHoverDot" r="4" class="chart-hover-dot" style="display:none"/>
        <rect id="chartHit" x="${padL}" y="${padT}" width="${w - padL - padR}"
              height="${plotBottom - padT}" fill="transparent"/>
    `;

    attachChartHover(svg, history, proj.points, x, y, tMin, tMax,
                     withPrice ? { yPrice, series: priceSeries, totalH, proj: pricePr } : null);
    renderProjectionNotes(proj, pricePr);
}

function attachChartHover(svg, history, projPoints, x, y, tMin, tMax, priceCtx) {
    const hit = svg.querySelector('#chartHit');
    const cross = svg.querySelector('#chartCrosshair');
    const dot = svg.querySelector('#chartHoverDot');
    const priceDot = svg.querySelector('#chartHoverDotPrice');
    const tip = document.getElementById('chartTooltip');
    if (!hit || !tip) return;

    const chartH = priceCtx ? priceCtx.totalH : CHART.h;

    const all = [...history.map(p => ({ ...p, kind: 'real' })),
                 ...projPoints.map(p => ({ ...p, kind: 'proj' }))];

    hit.addEventListener('mousemove', e => {
        const rect = svg.getBoundingClientRect();
        const svgX = ((e.clientX - rect.left) / rect.width) * CHART.w;
        const ts = tMin + ((svgX - CHART.padL) / (CHART.w - CHART.padL - CHART.padR)) * (tMax - tMin);

        let nearest = all[0];
        for (const p of all) if (Math.abs(p.ts - ts) < Math.abs(nearest.ts - ts)) nearest = p;

        cross.style.display = '';
        cross.setAttribute('x1', x(nearest.ts));
        cross.setAttribute('x2', x(nearest.ts));

        // Dot marking the exact point being read.
        dot.style.display = '';
        dot.setAttribute('cx', x(nearest.ts));
        dot.setAttribute('cy', y(nearest.value));

        // Matching dot on the price panel at the same date. Past dates read
        // the real series; future dates read the projected band.
        let priceAt = null, priceBand = null;
        if (priceCtx && priceDot) {
            const lastRealTs = priceCtx.series.length
                ? priceCtx.series[priceCtx.series.length - 1].ts : 0;

            if (nearest.ts <= lastRealTs) {
                let np = null;
                for (const p of priceCtx.series) {
                    if (!np || Math.abs(p.ts - nearest.ts) < Math.abs(np.ts - nearest.ts)) np = p;
                }
                if (np) {
                    priceAt = np.close;
                    priceDot.style.display = '';
                    priceDot.setAttribute('cx', x(np.ts));
                    priceDot.setAttribute('cy', priceCtx.yPrice(np.close));
                }
            } else if (priceCtx.proj?.points?.length) {
                let pp = null;
                for (const p of priceCtx.proj.points) {
                    if (!pp || Math.abs(p.ts - nearest.ts) < Math.abs(pp.ts - nearest.ts)) pp = p;
                }
                if (pp) {
                    priceBand = pp;
                    priceDot.style.display = '';
                    priceDot.setAttribute('cx', x(pp.ts));
                    priceDot.setAttribute('cy', priceCtx.yPrice(pp.mid));
                }
            } else {
                priceDot.style.display = 'none';
            }
        }

        const phase = phaseForScore(nearest.value);
        tip.style.display = 'block';
        tip.innerHTML = `
            <div class="tt-date">${new Date(nearest.ts).toISOString().slice(0, 10)}
                ${nearest.kind === 'proj'
                    ? '<span class="tt-proj">projected</span>'
                    : `<span class="tt-conf">${Math.round(nearest.confidence * 100)}% weight</span>`}</div>
            <div class="tt-score">${Math.round(nearest.value)}<span class="tt-phase">${phase.label}</span></div>
            ${priceAt !== null
                ? `<div class="tt-price">BTC ${fmtUSD(priceAt)}</div>` : ''}
            ${priceBand
                ? `<div class="tt-price tt-price-proj">BTC ~${fmtUSD(priceBand.mid)}
                     <span class="tt-band">${fmtUSD(priceBand.lo)} – ${fmtUSD(priceBand.hi)}</span></div>` : ''}
        `;

        // Keep the tooltip off the curve: sit below the point when it's high
        // on the plot, above it when it's low. Clamp horizontally so it never
        // runs past either edge of the chart.
        const pxPerUnitY = rect.height / chartH;
        const pointTopPx = y(nearest.value) * pxPerUnitY;
        const below = nearest.value > 55;
        const gap = 14;

        tip.style.top = below
            ? `${pointTopPx + gap}px`
            : `${Math.max(0, pointTopPx - tip.offsetHeight - gap)}px`;

        const leftPct = (x(nearest.ts) / CHART.w) * 100;
        const halfTipPct = (tip.offsetWidth / 2 / rect.width) * 100;
        tip.style.left = `${Math.min(100 - halfTipPct, Math.max(halfTipPct, leftPct)).toFixed(2)}%`;
    });

    hit.addEventListener('mouseleave', () => {
        cross.style.display = 'none';
        dot.style.display = 'none';
        if (priceDot) priceDot.style.display = 'none';
        tip.style.display = 'none';
    });

    // Click/tap to load that date into the dashboard (real history only).
    hit.addEventListener('click', e => {
        const rect = svg.getBoundingClientRect();
        const svgX = ((e.clientX - rect.left) / rect.width) * CHART.w;
        const ts = tMin + ((svgX - CHART.padL) / (CHART.w - CHART.padL - CHART.padR)) * (tMax - tMin);
        const { last } = dayBounds();
        if (ts > last) return;

        renderFor(ts);

        // On a narrow screen the cards sit far above the chart, so scrolling
        // to them yanks the view away from the thing being tapped. Leave the
        // reader where they are; the date badge confirms the change instead.
        const isNarrow = window.matchMedia('(max-width: 640px)').matches;
        if (!isNarrow) {
            document.querySelector('.grid-top').scrollIntoView({ behavior: 'smooth' });
        }
    });
}

function renderProjectionNotes(proj, pricePr) {
    const el = document.getElementById('projectionNotes');
    if (!el) return;
    const fmtD = ts => new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
    const { stats } = proj.dates;
    const d = proj.dates;
    const A = pricePr ? pricePr.assumptions : null;
    const k = v => '$' + Math.round(v / 1000) + 'k';

    el.innerHTML = `
        <div class="proj-item">
            <span class="proj-label">Projected cycle bottom</span>
            <span class="proj-value">${fmtD(d.currentBottom.ts)}</span>
            <span class="proj-range">range ${fmtD(d.currentBottom.loTs)} – ${fmtD(d.currentBottom.hiTs)}</span>
            ${A ? `<span class="proj-price">~${k(A.bottomUSD)}
                     <span class="proj-price-band">${k(A.bottomLoUSD)}–${k(A.bottomHiUSD)}</span></span>` : ''}
        </div>
        <div class="proj-item">
            <span class="proj-label">Next halving</span>
            <span class="proj-value">${fmtD(d.nextHalving.ts)}</span>
            <span class="proj-range">scheduled, not estimated</span>
        </div>
        <div class="proj-item">
            <span class="proj-label">Projected next top</span>
            <span class="proj-value">${fmtD(d.nextTop.ts)}</span>
            <span class="proj-range">range ${fmtD(d.nextTop.loTs)} – ${fmtD(d.nextTop.hiTs)}</span>
            ${A ? `<span class="proj-price">~${k(A.nextTopUSD)}
                     <span class="proj-price-band">${k(A.nextTopLoUSD)}–${k(A.nextTopHiUSD)}</span></span>` : ''}
        </div>
        ${A ? `
        <div class="proj-assumptions">
            <span class="proj-label">Your assumptions</span>
            <label>Bottom $<input type="number" id="assumeBottom" value="${A.bottomUSD}" step="1000"></label>
            <label>Next top $<input type="number" id="assumeTop" value="${A.nextTopUSD}" step="10000"></label>
            <button id="resetAssume" class="refresh-btn">Reset</button>
        </div>` : ''}
        <p class="proj-basis">
            <strong>Timing</strong> is projected from past cycles: ${Math.min(...stats.toTop)}–${Math.max(...stats.toTop)}
            days halving→top (mean ${Math.round(stats.ttMean)}d),
            ${Math.min(...stats.topToBottom)}–${Math.max(...stats.topToBottom)} days top→bottom
            (mean ${Math.round(stats.btMean)}d).
            <strong>Price is not projected by the model at all</strong> — it is the assumption you set above,
            drawn as a band because cycle magnitude has decayed sharply every cycle
            (+57,400% → +13,133% → +2,126% → +712%) and three cycles is far too small a
            sample to extrapolate. Treat the band as "if the next cycle rhymes", not a forecast.
        </p>
    `;

    // Re-render on assumption change (debounced so typing isn't jumpy).
    let t = null;
    const rerender = () => { clearTimeout(t); t = setTimeout(renderScoreChart, 350); };
    el.querySelector('#assumeBottom')?.addEventListener('input', rerender);
    el.querySelector('#assumeTop')?.addEventListener('input', rerender);
    el.querySelector('#resetAssume')?.addEventListener('click', () => {
        const b = el.querySelector('#assumeBottom'), tp = el.querySelector('#assumeTop');
        if (b)  b.value  = PRICE_ASSUMPTIONS.bottomUSD;
        if (tp) tp.value = PRICE_ASSUMPTIONS.nextTopUSD;
        renderScoreChart();
    });
}
