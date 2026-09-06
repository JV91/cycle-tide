// ── Cycle Tide — trendline structure (context, NOT a scored signal) ─────────
//
// Detects the classic setup: a descending line joining successive lower highs,
// broken to the upside — and its mirror, a rising support line broken down.
//
// It is deliberately NOT part of the composite score, and that is an evidence-
// based decision rather than caution. Backtested over 3,308 daily bars
// (2017-2026), the upside breakout produced:
//
//     +7d   avg  -0.9%  vs baseline  +1.1%   (edge -1.9pp)
//     +30d  avg  +2.8%  vs baseline  +4.9%   (edge -2.1pp)
//     +90d  avg  +8.1%  vs baseline +17.0%   (edge -8.8pp)
//
// Negative at every horizon. An earlier, cruder pivot-selection rule scored
// even worse (-5.8pp / -17.4pp) and was negative across all 22 parameter
// combinations swept, so improving the detection did not rescue the edge. The
// mechanism is straightforward: breakouts fire AFTER a decline, so they
// systematically select entries that then underperform simply holding an asset
// whose baseline drift is strongly positive.
//
// So it is shown as structure — useful for seeing where price sits relative to
// its recent trend — with the backtest stated next to it, rather than folded
// into a score it demonstrably cannot improve.

const TREND_CFG = { look: 120, k: 5, minPivots: 3, minR2: 0.5, minMargin: 0.005 };

// A pivot high/low is a bar unmatched by any bar within k either side.
function trendPivots(bars, k, type) {
    const out = [];
    for (let i = k; i < bars.length - k; i++) {
        let ok = true;
        for (let j = i - k; j <= i + k; j++) {
            if (j === i) continue;
            if (type === 'high' ? bars[j].high >= bars[i].high
                                : bars[j].low  <= bars[i].low) { ok = false; break; }
        }
        if (ok) out.push(i);
    }
    return out;
}

function trendFit(pts) {
    const n = pts.length;
    if (n < 2) return null;
    const mx = pts.reduce((s, p) => s + p.x, 0) / n;
    const my = pts.reduce((s, p) => s + p.y, 0) / n;
    let num = 0, den = 0;
    for (const p of pts) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
    if (den === 0) return null;
    const slope = num / den, icpt = my - slope * mx;
    let ssTot = 0, ssRes = 0;
    for (const p of pts) {
        const yh = slope * p.x + icpt;
        ssRes += (p.y - yh) ** 2;
        ssTot += (p.y - my) ** 2;
    }
    return { slope, icpt, r2: ssTot ? 1 - ssRes / ssTot : 0 };
}

// Current trendline state. Returns the fitted line plus whether price has just
// broken it, so the UI can show both "where the line is" and "did it break".
function analyseTrendline(daily, direction = 'down') {
    const { look, k, minPivots, minR2 } = TREND_CFG;
    if (!daily || daily.length < look + 1) return null;

    const end = daily.length - 1;
    const win = daily.slice(end - look, end + 1);
    const isDown = direction === 'down';   // descending resistance vs rising support

    const piv = trendPivots(win, k, isDown ? 'high' : 'low')
        .map(x => ({ x, y: isDown ? win[x].high : win[x].low }));
    if (piv.length < minPivots) return null;

    // Take the monotonic "hull" rather than the last N pivots: keep only
    // pivots that each sit below (above) the previous one, discarding those
    // that break the sequence. Simply using the last three fails on the
    // textbook case — a lower-highs line running May→Aug is invisible if a
    // mid-sequence bounce inserts a higher pivot. This is also where the
    // discretion lives: a human drawing the line by eye skips exactly these,
    // and different reasonable choices give different lines.
    const hull = [];
    for (const p of piv) {
        while (hull.length && (isDown ? hull[hull.length - 1].y <= p.y
                                      : hull[hull.length - 1].y >= p.y)) hull.pop();
        hull.push(p);
    }
    if (hull.length < minPivots) return null;
    const recent = hull.slice(-Math.max(minPivots, 4));

    const line = trendFit(recent);
    if (!line) return null;
    if (isDown ? line.slope >= 0 : line.slope <= 0) return null;
    if (line.r2 < minR2) return null;

    const xNow = win.length - 1;
    const level = line.slope * xNow + line.icpt;
    const prevLevel = line.slope * (xNow - 1) + line.icpt;
    const c = win[xNow].close, cPrev = win[xNow - 1].close;

    const broken = isDown ? (c > level) : (c < level);
    const justBroke = isDown ? (cPrev <= prevLevel && c > level)
                             : (cPrev >= prevLevel && c < level);
    const distance = (c - level) / level;

    // How long has the break held? Walk back while price stays the right side.
    let heldDays = 0;
    if (broken) {
        for (let i = xNow; i >= 1; i--) {
            const lv = line.slope * i + line.icpt;
            if (isDown ? win[i].close > lv : win[i].close < lv) heldDays++;
            else break;
        }
    }

    return {
        direction, level, slope: line.slope, r2: line.r2,
        broken, justBroke, distance, heldDays,
        pivotCount: recent.length,
        fromTs: win[recent[0].x].ts,
        pivots: recent.map(p => ({ ts: win[p.x].ts, y: p.y })),
        // Line endpoints in timestamp space, for drawing on the chart.
        startTs: win[0].ts,
        endTs: win[xNow].ts,
        startLevel: line.icpt,
        endLevel: level,
    };
}

function renderTrendStructure(daily) {
    const down = analyseTrendline(daily, 'down');   // descending resistance
    const up   = analyseTrendline(daily, 'up');     // rising support
    // Either side may legitimately be absent — after a rally the recent highs
    // are rising, so no descending resistance exists to fit. Say so rather
    // than hiding the card, which would look like a failure.
    if (!down && !up) {
        return `
        <section class="card trend-card">
            <h2 class="card-title">TREND STRUCTURE — CONTEXT ONLY</h2>
            <p class="asset-note">No well-formed trendline in the last 120 days —
            recent pivots do not line up cleanly enough to fit one (R² below 0.5).</p>
        </section>`;
    }

    const iso = ts => new Date(ts).toISOString().slice(0, 10);

    const row = (t, labelBroken, labelIntact) => {
        if (!t) return '';
        const cls = t.broken ? (t.direction === 'down' ? 'val-up' : 'val-down') : '';
        return `
        <div class="trend-row">
            <div class="trend-head">
                <span class="trend-label">${t.direction === 'down'
                    ? 'Descending resistance' : 'Rising support'}</span>
                <span class="trend-state ${cls}">${t.broken ? labelBroken : labelIntact}</span>
            </div>
            <div class="trend-detail">
                line at ${fmtUSD(t.level)} · price ${t.distance >= 0 ? '+' : ''}${(t.distance * 100).toFixed(1)}%
                ${t.broken ? `· held ${t.heldDays}d` : ''}
                · ${t.pivotCount} pivots from ${iso(t.fromTs)} · fit R² ${t.r2.toFixed(2)}
            </div>
        </div>`;
    };

    return `
    <section class="card trend-card">
        <h2 class="card-title">TREND STRUCTURE — CONTEXT ONLY</h2>
        ${down ? row(down, 'BROKEN UPWARD', 'intact')
               : `<div class="trend-row"><div class="trend-head">
                    <span class="trend-label">Descending resistance</span>
                    <span class="trend-state">none — recent highs are rising</span>
                  </div></div>`}
        ${up ? row(up, 'BROKEN DOWNWARD', 'intact')
             : `<div class="trend-row"><div class="trend-head">
                  <span class="trend-label">Rising support</span>
                  <span class="trend-state">none — recent lows are falling</span>
                </div></div>`}
        <p class="asset-note trend-warning">
            <strong>Not part of the cycle score, on purpose.</strong> Backtested
            over 3,308 daily bars, an upside break of descending resistance
            returned +2.8% at 30 days against a +4.9% baseline, and +8.1% at 90
            days against +17.0% — negative edge at every horizon, and a cruder
            earlier version scored worse still. Breakouts fire after a decline, so they pick
            entries that then lag simply holding. Shown because seeing where
            price sits against its recent trend is genuinely useful; excluded
            from scoring because it does not predict returns.
        </p>
        ${metricInfoHtml('trendStructure')}
    </section>`;
}
