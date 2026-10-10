// ── Cycle Tide — four-year cycle clock (context, NOT part of the score) ─────
//
// Where the viewed date sits in the halving cycle, against where earlier
// cycles topped and bottomed. Pure calendar: it knows nothing about price.
//
// Why it is shown but not scored. Calibrated on three cycles and checked on the
// fourth (2026-10-10), a days-since-halving clock placed every held-out top at
// 12-21 and every held-out bottom at 72-100 on a 0-100 scale — as good as any
// signal in the model. It still stays out of the score because:
//
//   * four cycles is all the evidence there is;
//   * it would read 100 for about 40% of every cycle, the same constant uplift
//     that got four signals removed;
//   * it cannot react: if the cycle breaks, a clock stays confidently wrong for
//     years, where every scored signal would move with the market;
//   * this cycle has already drifted — the 2026 low came on day 803 against
//     777-924 before, and far shallower (-54% against -77% to -86%).
//
// So it is context for reading the score, with its own evidence stated.
//
// The windows drawn for past tops and bottoms come from the OTHER cycles, never
// the one being viewed. Browsing back to 2021 therefore shows what the clock
// would have suggested then, not a window that already contains the answer.

function cycleClock(ts) {
    const cycles = CYCLE_HISTORY.map(c => {
        const h = Date.parse(c.halving + 'T00:00:00Z');
        return {
            h,
            topTs: c.top ? Date.parse(c.top + 'T00:00:00Z') : null,
            bottomTs: c.bottom ? Date.parse(c.bottom + 'T00:00:00Z') : null,
        };
    });
    for (const c of cycles) {
        c.topDay = c.topTs ? Math.round((c.topTs - c.h) / DAY) : null;
        c.bottomDay = c.bottomTs ? Math.round((c.bottomTs - c.h) / DAY) : null;
    }

    // Halving boundaries, including the next scheduled one and a nominal one
    // after it so a date past 2028 still has a cycle to sit in.
    const bounds = cycles.map(c => c.h).concat([NEXT_HALVING, NEXT_HALVING + 1461 * DAY]);
    let k = -1;
    for (let i = 0; i < bounds.length - 1; i++) if (bounds[i] <= ts) k = i;
    if (k < 0) return null;

    const start = bounds[k], end = bounds[k + 1];
    const length = Math.round((end - start) / DAY);
    const day = Math.floor((ts - start) / DAY);
    const cur = cycles[k] || null;                    // null once past NEXT_HALVING
    const others = cycles.filter((c, i) => i !== k);

    const range = key => {
        const v = others.map(c => c[key]).filter(x => x !== null);
        return v.length ? { lo: Math.min(...v), hi: Math.max(...v), n: v.length } : null;
    };
    const tops = range('topDay'), bottoms = range('bottomDay');

    // This cycle's own turning points, only once they are in the past as of ts.
    const ownTop = cur?.topTs && cur.topTs <= ts ? cur.topDay : null;
    const ownBottom = cur?.bottomTs && cur.bottomTs <= ts ? cur.bottomDay : null;

    return { start, end, length, day, tops, bottoms, ownTop, ownBottom,
             toNext: Math.max(0, Math.ceil((end - ts) / DAY)), nextEstimated: end >= NEXT_HALVING };
}

function renderCycleClock(ts) {
    const el = document.getElementById('cycleClock');
    if (!el) return;
    const c = cycleClock(ts);
    if (!c || !c.tops || !c.bottoms) { el.innerHTML = ''; return; }

    const pct = d => Math.max(0, Math.min(100, (d / c.length) * 100));
    const mon = t => new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    const T = c.tops, B = c.bottoms;

    // One plain sentence for where this date sits, in the order a cycle runs.
    let read;
    if (c.day < T.lo)       read = `Before the stretch where earlier cycles topped (days ${T.lo}–${T.hi}).`;
    else if (c.day <= T.hi) read = `Inside the stretch where earlier cycles topped (days ${T.lo}–${T.hi}).`;
    else if (c.day < B.lo)  read = `Between where earlier cycles topped (days ${T.lo}–${T.hi}) and where they bottomed (days ${B.lo}–${B.hi}).`;
    else if (c.day <= B.hi) read = `Inside the stretch where earlier cycles bottomed (days ${B.lo}–${B.hi}).`;
    else                    read = `Past the stretch where earlier cycles bottomed (days ${B.lo}–${B.hi}), in the run-up to the next halving.`;

    const own = [
        c.ownTop !== null ? `this cycle topped on day ${c.ownTop}` : null,
        c.ownBottom !== null ? `made its low on day ${c.ownBottom}` : null,
    ].filter(Boolean).join(' and ');

    el.innerHTML = `
        <div class="cc-head">
            <span class="cc-title">FOUR-YEAR CYCLE</span>
            <span class="cc-tag" title="Shown for context. It is not one of the seven scored signals and does not move the score.">context · not scored</span>
        </div>
        <div class="cc-day">Day ${c.day.toLocaleString('en-US')} <span>of about ${c.length.toLocaleString('en-US')}</span></div>
        <div class="cc-track" role="img"
             aria-label="Day ${c.day} of the halving cycle. Earlier cycles topped on days ${T.lo} to ${T.hi} and bottomed on days ${B.lo} to ${B.hi}.">
            <div class="cc-zone cc-zone-top" style="left:${pct(T.lo)}%;width:${pct(T.hi) - pct(T.lo)}%"
                 title="Earlier cycles topped on days ${T.lo}–${T.hi}"></div>
            <div class="cc-zone cc-zone-bottom" style="left:${pct(B.lo)}%;width:${pct(B.hi) - pct(B.lo)}%"
                 title="Earlier cycles bottomed on days ${B.lo}–${B.hi}"></div>
            ${c.ownTop !== null ? `<div class="cc-mark cc-mark-top" style="left:${pct(c.ownTop)}%" title="This cycle's top, day ${c.ownTop}"></div>` : ''}
            ${c.ownBottom !== null ? `<div class="cc-mark cc-mark-bottom" style="left:${pct(c.ownBottom)}%" title="This cycle's low, day ${c.ownBottom}"></div>` : ''}
            <div class="cc-now" style="left:${pct(c.day)}%" title="Day ${c.day}"></div>
        </div>
        <div class="cc-scale">
            <span>halving ${mon(c.start)}</span>
            <span>${c.nextEstimated ? 'next ≈ ' : 'next '}${mon(c.end)}</span>
        </div>
        <div class="cc-legend">
            <span><i class="cc-sw cc-sw-top"></i>earlier tops</span>
            <span><i class="cc-sw cc-sw-bottom"></i>earlier bottoms</span>
        </div>
        <p class="cc-read">${read}${own ? ` ${own.charAt(0).toUpperCase() + own.slice(1)}.` : ''}
            ${c.toNext.toLocaleString('en-US')} days to the next halving.</p>
        <p class="cc-note">Calendar only — it knows nothing about price. Built from four cycles, and this
            one has already run early and shallower than the others, so read it beside the score, not instead of it.</p>`;
}
