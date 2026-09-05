// ── Cycle Tide — live data ──────────────────────────────────────────────────
// Exchange-style live updates, matched to how fast each source ACTUALLY
// changes. Polling a daily on-chain metric every few seconds would just burn
// rate limits (bitcoin-data.com 429s aggressively) without producing a single
// new number, so each source gets its own cadence:
//
//   BTC price      — WebSocket stream (continuous ticks)
//   Funding rate   — 5 min  (settles every 8h)
//   Fear & Greed   — 60 min (updates daily)
//   On-chain       — left to the 1h cache in data.js (updates daily)
//
// Everything degrades safely: if the socket won't connect we fall back to
// REST polling, and if that fails too the dashboard keeps its last good values.

const LIVE = {
    ws: null,
    reconnectDelay: 1000,
    maxReconnectDelay: 30000,
    lastTick: null,
    pending: null,      // newest frame, awaiting the next paint
    paintTimer: null,
    pollTimers: [],
    enabled: true,
    fallbackTimer: null,
};

const LIVE_INTERVALS = {
    funding: 5 * 60 * 1000,
    fearGreed: 60 * 60 * 1000,
    restFallback: 15 * 1000,
};

// How exchanges actually do it: the socket pushes continuously, but the UI
// repaints on a fixed cadence and shows change against a FIXED reference
// (24h open), not against the previous tick. Anchoring to 24h open is what
// makes the number feel stable — it only moves when price really moves.
const PAINT_INTERVAL = 5000;

// ── Price stream ────────────────────────────────────────────────────────────

function startPriceStream() {
    if (!LIVE.enabled) return;
    stopPriceStream();

    let ws;
    try {
        // @ticker (1s aggregated), not @trade (every individual trade). The
        // raw trade stream fires many times a second and consecutive trades
        // differ by a cent as they cross the spread, which makes the ticker
        // flicker between two values that aren't a real price move.
        ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');
    } catch (e) {
        console.warn('[cycletide] WebSocket unavailable, falling back to polling:', e.message);
        startRestFallback();
        return;
    }
    LIVE.ws = ws;

    ws.addEventListener('open', () => {
        LIVE.reconnectDelay = 1000; // reset backoff on a good connection
        stopRestFallback();
        setLiveStatus('live', 'Live');
    });

    ws.addEventListener('message', ev => {
        try {
            const msg = JSON.parse(ev.data);
            // @ticker carries the 24h rolling window alongside the last price:
            //   c = last price, o = 24h open, p = 24h change, P = 24h change %
            const price = parseFloat(msg.c);
            if (!(price > 0)) return;
            // Buffer only — the paint loop decides when this reaches the DOM.
            LIVE.pending = {
                price,
                open24h:  parseFloat(msg.o),
                change24h:    parseFloat(msg.p),
                changePct24h: parseFloat(msg.P),
                ts: msg.E || Date.now(),
            };
        } catch { /* ignore malformed frame */ }
    });

    ws.addEventListener('close', () => {
        if (!LIVE.enabled) return;
        setLiveStatus('reconnecting', 'Reconnecting…');
        startRestFallback();
        // Exponential backoff so a dead endpoint isn't hammered.
        setTimeout(startPriceStream, LIVE.reconnectDelay);
        LIVE.reconnectDelay = Math.min(LIVE.reconnectDelay * 2, LIVE.maxReconnectDelay);
    });

    ws.addEventListener('error', () => {
        // 'close' fires after 'error'; reconnect is handled there.
        try { ws.close(); } catch {}
    });
}

function stopPriceStream() {
    if (LIVE.ws) {
        try { LIVE.ws.onclose = null; LIVE.ws.close(); } catch {}
        LIVE.ws = null;
    }
}

// REST fallback for environments where the WS is blocked.
function startRestFallback() {
    if (LIVE.fallbackTimer || !LIVE.enabled) return;
    const tick = async () => {
        try {
            // 24hr endpoint (not /ticker/price) so the fallback carries the
            // same 24h change fields the socket provides.
            const j = await fetchJSON('https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT');
            const p = parseFloat(j.lastPrice);
            if (p > 0) {
                LIVE.pending = {
                    price: p,
                    open24h: parseFloat(j.openPrice),
                    change24h: parseFloat(j.priceChange),
                    changePct24h: parseFloat(j.priceChangePercent),
                    ts: Date.now(),
                };
            }
            setLiveStatus('live', 'Live');
        } catch (e) {
            setLiveStatus('stale', 'Connection lost — showing last known data');
        }
    };
    tick();
    LIVE.fallbackTimer = setInterval(tick, LIVE_INTERVALS.restFallback);
}

function stopRestFallback() {
    if (LIVE.fallbackTimer) { clearInterval(LIVE.fallbackTimer); LIVE.fallbackTimer = null; }
}

// ── Paint loop ──────────────────────────────────────────────────────────────
// The socket fills LIVE.pending continuously; this drains it on a fixed
// cadence. Decoupling receive-rate from paint-rate is what keeps the UI calm
// without throwing away data — the newest frame always wins.

function startPaintLoop() {
    stopPaintLoop();
    LIVE.paintTimer = setInterval(paintPending, PAINT_INTERVAL);
    paintPending(); // paint immediately rather than waiting a full interval
}

function stopPaintLoop() {
    if (LIVE.paintTimer) { clearInterval(LIVE.paintTimer); LIVE.paintTimer = null; }
}

function paintPending() {
    const f = LIVE.pending;
    if (!f) return;
    const prev = LIVE.lastTick?.price ?? null;
    LIVE.lastTick = f;

    // Keep today's candle current so downstream signals (drawdown, 200W MA
    // multiple, RSI) reflect the live price.
    const days = SERIES?.daily;
    if (days && days.length) {
        const todayTs = new Date().setUTCHours(0, 0, 0, 0);
        const lastDay = days[days.length - 1];
        if (lastDay.ts === todayTs) {
            lastDay.close = f.price;
            // Today's high must ratchet up with the live price, otherwise a
            // new ATH made intraday wouldn't register until the daily candle
            // is refetched.
            lastDay.high = Math.max(lastDay.high ?? f.price, f.price);
        } else if (todayTs > lastDay.ts) {
            days.push({ ts: todayTs, close: f.price, high: f.price });
            recomputeDerivedSeries();
        }
    }

    updatePriceTicker(f, prev);

    // Only recompute the dashboard when viewing "latest" — if the user is
    // browsing a past date, live ticks must not overwrite what they're reading.
    if (viewTs !== null && isToday(viewTs)) scheduleLiveRerender();
}

function recomputeDerivedSeries() {
    const daily = SERIES.daily;
    SERIES.ath_drawdown = computeAthDrawdown(daily).series;
    SERIES.ma200w_mult  = computeMa200wMultiple(daily).series;
    SERIES.rsi_monthly  = computeMonthlyRSI(daily).series;
    SERIES.pi_cycle     = computePiCycle(daily).series;
}

// Recomputing the whole composite on every trade tick would be wasteful, so
// coalesce to at most one update per second.
let _rerenderTimer = null;
function scheduleLiveRerender() {
    if (_rerenderTimer) return;
    _rerenderTimer = setTimeout(() => {
        _rerenderTimer = null;
        const { last } = dayBounds();
        // Price-derived signals only — the on-chain series are unchanged by a
        // price tick, so there's no reason to touch them here.
        SERIES.ath_drawdown = computeAthDrawdown(SERIES.daily).series;
        SERIES.ma200w_mult  = computeMa200wMultiple(SERIES.daily).series;
        SERIES.pi_cycle     = computePiCycle(SERIES.daily).series;
        renderFor(last);
    }, 1000);
}

// ── Live price ticker in the header ─────────────────────────────────────────

function updatePriceTicker(frame, prev) {
    const el = document.getElementById('livePrice');
    if (!el) return;
    const { price, change24h, changePct24h } = frame;

    const text = '$' + price.toLocaleString('en-US', { maximumFractionDigits: 0 });

    // Repaint the price only when the rendered string actually differs, so a
    // sub-dollar move doesn't re-trigger the flash on an unchanged number.
    if (text !== el.textContent) {
        const dir = prev === null ? '' : price > prev ? 'up' : price < prev ? 'down' : '';
        el.textContent = text;
        el.className = 'live-price' + (dir ? ' tick-' + dir : '');
        if (dir) {
            clearTimeout(el._flash);
            el._flash = setTimeout(() => { el.className = 'live-price'; }, 400);
        }
    }

    // 24h change — anchored to the rolling 24h open, the way exchanges show
    // it. Colour follows the sign of the change, not the direction of the
    // last tick, so it stays put while price hovers.
    const chEl = document.getElementById('liveChange');
    if (chEl && !isNaN(changePct24h)) {
        const sign = change24h > 0 ? '+' : '';
        chEl.innerHTML =
            `<span class="chg-abs">${sign}${Math.round(change24h).toLocaleString('en-US')}</span>` +
            `<span class="chg-pct">${sign}${changePct24h.toFixed(2)}%</span>`;
        chEl.className = 'live-change ' +
            (change24h > 0 ? 'chg-up' : change24h < 0 ? 'chg-down' : 'chg-flat');
    }

    const stamp = document.getElementById('liveUpdated');
    if (stamp) stamp.textContent = new Date().toLocaleTimeString();
}

// Connection state is conveyed by the dot's colour + tooltip, not a sentence
// in the header. Text is reserved for a hard failure the user must act on.
function setLiveStatus(kind, text) {
    const el = document.getElementById('liveStatus');
    if (!el) return;
    el.className = 'live-dot ' + (
        kind === 'live' ? 'live-ok' :
        kind === 'reconnecting' ? 'live-pending' : 'live-err');
    el.title = text;
}

// ── Slow-cadence pollers ────────────────────────────────────────────────────

function startPollers() {
    const poll = (fn, interval) => {
        const timer = setInterval(async () => {
            if (document.hidden) return; // don't poll a backgrounded tab
            await fn();
        }, interval);
        LIVE.pollTimers.push(timer);
    };

    poll(async () => {
        const f = await fetchFundingRate();
        if (f) { SERIES.funding = f; refreshIfLive(); }
    }, LIVE_INTERVALS.funding);

    poll(async () => {
        const fg = await fetchFearGreed();
        if (fg) { SERIES.fear_greed = fg; refreshIfLive(); }
    }, LIVE_INTERVALS.fearGreed);
}

function refreshIfLive() {
    if (viewTs !== null && isToday(viewTs)) renderFor(dayBounds().last);
}

function stopLive() {
    LIVE.enabled = false;
    stopPriceStream();
    stopRestFallback();
    stopPaintLoop();
    LIVE.pollTimers.forEach(clearInterval);
    LIVE.pollTimers = [];
}

function startLive() {
    LIVE.enabled = true;
    startPriceStream();
    startPaintLoop();
    startPollers();
}

// Pause the stream while the tab is hidden; resume (and catch up) on return.
document.addEventListener('visibilitychange', () => {
    if (!LIVE.enabled) return;
    if (document.hidden) {
        stopPriceStream();
        stopRestFallback();
        stopPaintLoop();
    } else {
        startPriceStream();
        startPaintLoop();
    }
});
