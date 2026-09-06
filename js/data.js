// ── Cycle Tide — data fetchers ───────────────────────────────────────────────
// All sources are free / no-key. Every fetcher fails soft: on error it
// returns null (caller marks that signal "not scored — no data cached yet")
// rather than throwing and breaking the whole dashboard.

// Bump this whenever the SHAPE of any cached payload changes, so existing
// browsers don't keep serving records that are missing new fields. v2 added
// the intraday `high` to the daily price series (needed for a correct ATH);
// without a version bump a cached v1 entry silently falls back to the close.
const CACHE_KEY = 'cycletide_cache_v2';

// Drop payloads written by older schema versions.
(function purgeOldCaches() {
    try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const k = localStorage.key(i);
            if (k && k.startsWith('cycletide_cache_') && k !== CACHE_KEY) {
                localStorage.removeItem(k);
            }
        }
    } catch { /* private mode / storage disabled */ }
})();
const CACHE_TTL_MS = 15 * 60 * 1000;            // 15 min — price/funding/sentiment
const DAILY_CACHE_TTL_MS = 20 * 60 * 60 * 1000; // 20h — on-chain updates once daily,
                                                // and the provider allows only 10 req/hour

function loadCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return {};
        return JSON.parse(raw);
    } catch { return {}; }
}

function saveCache(cache) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* quota/private-mode */ }
}

// No retry-on-429 here: retrying into an active rate limit only extends it.
// A single failed attempt just falls through to cachedFetch's soft-fail path.
async function fetchJSON(url, opts) {
    const resp = await fetch(url, opts);
    if (!resp.ok) throw new Error(`${url} → HTTP ${resp.status}`);
    return resp.json();
}

// bitcoin-data.com enforces a HARD limit of 10 requests per hour per IP
// (confirmed from its own error body: RATE_LIMIT_HOUR_EXCEEDED). With 3
// on-chain endpoints per load that's only ~3 cold loads an hour, so the
// on-chain data is cached for a full day: these metrics update once daily
// anyway, and a stale-but-present reading beats an empty signal.
//
// When the limit is hit there is no point retrying sooner than the top of the
// next hour, so the cooldown is a flat 60 minutes rather than a backoff ramp.
const RATE_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;

// Set by the Refresh button to punch through an active cooldown once.
let FORCE_REFRESH = false;

// Why a given source has no data right now, so the UI can say "rate limited,
// retry at 14:35" rather than the misleading "no data for this date".
const FETCH_STATUS = {};

async function cachedFetch(name, fetcher, ttlMs = CACHE_TTL_MS) {
    const cache = loadCache();
    const entry = cache[name];
    const fresh = !FORCE_REFRESH && entry && (Date.now() - entry.ts) < ttlMs;
    if (fresh) { FETCH_STATUS[name] = { ok: true, cached: true }; return entry.data; }

    const cooldownUntil = FORCE_REFRESH ? 0 : (entry?.cooldownUntil || 0);
    if (Date.now() < cooldownUntil) {
        console.warn(`[cycletide] ${name} in rate-limit cooldown for ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s, serving cache`);
        FETCH_STATUS[name] = { ok: false, reason: 'rate-limit', retryAt: cooldownUntil };
        return entry ? entry.data : null;
    }

    try {
        const data = await fetcher();
        cache[name] = { ts: Date.now(), data, failCount: 0 };
        saveCache(cache);
        FETCH_STATUS[name] = { ok: true };
        return data;
    } catch (e) {
        console.warn(`[cycletide] ${name} fetch failed:`, e.message);
        const isRateLimit = /HTTP 429/.test(e.message);
        FETCH_STATUS[name] = isRateLimit
            ? { ok: false, reason: 'rate-limit', retryAt: Date.now() + RATE_LIMIT_COOLDOWN_MS }
            : { ok: false, reason: 'error', message: e.message };
        cache[name] = {
            ts: entry?.ts || 0,
            data: entry?.data ?? null,
            failCount: (entry?.failCount || 0) + (isRateLimit ? 1 : 0),
            cooldownUntil: isRateLimit
                ? Date.now() + RATE_LIMIT_COOLDOWN_MS
                : (entry?.cooldownUntil || 0),
        };
        saveCache(cache);
        return entry ? entry.data : null; // serve stale cache over nothing
    }
}

// ── BTC daily price history (Binance klines, 1d, paginated back to genesis-ish) ──
async function fetchBTCDaily() {
    // Belt-and-braces alongside the cache version bump: if a cached series
    // somehow lacks `high`, discard it rather than computing a wrong ATH from
    // closes. A silently-wrong number is worse than one refetch.
    try {
        const cache = loadCache();
        const cached = cache.btc_daily?.data;
        if (Array.isArray(cached) && cached.length && cached[cached.length - 1].high === undefined) {
            delete cache.btc_daily;
            saveCache(cache);
        }
    } catch { /* ignore */ }

    return cachedFetch('btc_daily', async () => {
        const all = [];
        let endTime = null;
        for (let i = 0; i < 12; i++) {
            const url = 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000'
                + (endTime ? '&endTime=' + endTime : '');
            const batch = await fetchJSON(url);
            if (!batch.length) break;
            all.push(...batch);
            endTime = batch[0][0] - 1;
            if (batch.length < 1000) break;
        }
        // Keep the intraday high alongside the close: ATH (and therefore
        // drawdown-from-ATH, a 15-point signal) is conventionally measured
        // against the true high, not the daily close. Using closes understated
        // the 2025 top by ~$1,540.
        return all
            .map(k => ({ ts: k[0], close: parseFloat(k[4]), high: parseFloat(k[2]) }))
            .filter(p => p.close > 0)
            .sort((a, b) => a.ts - b.ts);
    });
}

// ── bitcoin-data.com on-chain metrics ────────────────────────────────────────
// The free tier allows only 10 requests per HOUR per IP, and three endpoints
// are needed per load — so a few visits exhaust the quota and the on-chain
// block goes dark entirely. To avoid that, a snapshot of these series ships
// in data/onchain.json (regenerate with scripts/snapshot-onchain.mjs). The
// live API is then only a top-up: if it 429s we fall back to the snapshot,
// which is at most a day or two stale on metrics that update daily anyway.

let _snapshotPromise = null;
function loadOnchainSnapshot() {
    if (!_snapshotPromise) {
        _snapshotPromise = fetch('data/onchain.json')
            .then(r => r.ok ? r.json() : null)
            .then(j => j?.series || null)
            .catch(() => null);
    }
    return _snapshotPromise;
}

// Merge live rows over snapshot rows, live winning on duplicate timestamps.
function mergeSeries(snapshot, live) {
    if (!snapshot?.length) return live || [];
    if (!live?.length) return snapshot;
    const byTs = new Map(snapshot.map(p => [p.ts, p]));
    for (const p of live) byTs.set(p.ts, p);
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

async function fetchOnchainSeries(key, path, field) {
    const live = await cachedFetch(`onchain_${path}`, async () => {
        const rows = await fetchJSON(`https://api.bitcoin-data.com/v1/${path}`);
        return rows
            .map(r => ({ ts: new Date(r.d).getTime(), value: parseFloat(r[field]) }))
            .filter(r => !isNaN(r.value))
            .sort((a, b) => a.ts - b.ts);
    }, DAILY_CACHE_TTL_MS);

    const snapshot = await loadOnchainSnapshot();
    const merged = mergeSeries(snapshot?.[key], live);
    return merged.length ? merged : null;
}

const fetchMvrvZScore    = () => fetchOnchainSeries('mvrv_z', 'mvrv-zscore', 'mvrvZscore');
const fetchNupl          = () => fetchOnchainSeries('nupl', 'nupl', 'nupl');
const fetchPuellMultiple = () => fetchOnchainSeries('puell', 'puell-multiple', 'puellMultiple');

// ── US spot BTC ETF net flows ────────────────────────────────────────────────
// Served entirely from the committed snapshot (data/etf-flows.json, refreshed
// by scripts/snapshot-etf.mjs). Deliberately NOT fetched from a third party at
// runtime: the upstream is a community mirror that could disappear, and a dead
// URL must never be able to break the dashboard.
let _etfPromise = null;
function fetchEtfFlows() {
    if (!_etfPromise) {
        _etfPromise = fetch('data/etf-flows.json')
            .then(r => r.ok ? r.json() : null)
            .then(j => Array.isArray(j?.series) ? j.series : null)
            .catch(() => null);
    }
    return _etfPromise;
}

// ── DefiLlama total stablecoin supply (for SSR) ──────────────────────────────
async function fetchStablecoinSupply() {
    return cachedFetch('stablecoin_supply', async () => {
        const rows = await fetchJSON('https://stablecoins.llama.fi/stablecoincharts/all');
        return rows
            .map(r => ({ ts: parseInt(r.date, 10) * 1000, value: r.totalCirculatingUSD?.peggedUSD }))
            .filter(r => typeof r.value === 'number' && r.value > 0)
            .sort((a, b) => a.ts - b.ts);
    });
}

// ── Alternative.me Fear & Greed Index ────────────────────────────────────────
async function fetchFearGreed() {
    return cachedFetch('fear_greed', async () => {
        const json = await fetchJSON('https://api.alternative.me/fng/?limit=400');
        return json.data
            .map(d => ({ ts: parseInt(d.timestamp, 10) * 1000, value: parseFloat(d.value) }))
            .sort((a, b) => a.ts - b.ts);
    });
}

// ── Binance funding rate (BTCUSDT perp) ──────────────────────────────────────
// Funding settles every 8h, so 1000 rows ≈ 333 days, not 1000 days. Page
// backwards to build a couple of years of history — otherwise the signal is
// blank for any date older than the first page and the whole
// "Derivatives & Leverage" category goes dark on historical views.
async function fetchFundingRate() {
    return cachedFetch('funding_rate', async () => {
        const all = [];
        let endTime = null;
        for (let i = 0; i < 8; i++) {
            const url = 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000'
                + (endTime ? '&endTime=' + endTime : '');
            const batch = await fetchJSON(url);
            if (!batch.length) break;
            all.push(...batch);
            endTime = batch[0].fundingTime - 1;
            if (batch.length < 1000) break;
        }
        return all
            .map(r => ({ ts: r.fundingTime, value: parseFloat(r.fundingRate) }))
            .filter(r => !isNaN(r.value))
            .sort((a, b) => a.ts - b.ts);
    });
}

// ── Helpers: latest value at/before a timestamp from a {ts,value}[] series ──
function latestAsOf(series, ts) {
    if (!series || !series.length) return null;
    let lo = 0, hi = series.length - 1, ans = null;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (series[mid].ts <= ts) { ans = series[mid]; lo = mid + 1; }
        else hi = mid - 1;
    }
    return ans ? ans.value : null;
}

function latest(series) {
    if (!series || !series.length) return null;
    return series[series.length - 1].value;
}

// Signal key → the cache entry whose fetch status explains its availability.
const SIGNAL_SOURCE = {
    mvrv_z: 'onchain_mvrv-zscore',
    nupl:   'onchain_nupl',
    puell:  'onchain_puell-multiple',
    ssr:    'stablecoin_supply',
    funding: 'funding_rate',
    fear_greed: 'fear_greed',
};

// Human-readable explanation for why a signal has no value, or null if the
// data source is fine (in which case the date genuinely predates the series).
function unavailableReason(signalKey) {
    const src = SIGNAL_SOURCE[signalKey];
    if (!src) return null; // self-computed from price — never a source failure
    const st = FETCH_STATUS[src];
    if (!st || st.ok) return null;
    if (st.reason === 'rate-limit') {
        const mins = st.retryAt ? Math.max(1, Math.ceil((st.retryAt - Date.now()) / 60000)) : null;
        return mins
            ? `provider rate-limited — retries in ~${mins} min`
            : 'provider rate-limited';
    }
    return 'data source unreachable';
}

// ── Equity price history ────────────────────────────────────────────────────
// Served from the committed treasuries snapshot, NOT fetched live: Yahoo's
// chart endpoint sends no CORS headers, so a browser request is blocked
// outright. scripts/snapshot-treasuries.mjs fetches it server-side instead.

// ── Treasury reference data (committed snapshot) ────────────────────────────
let _treasuryPromise = null;
function fetchTreasuries() {
    if (!_treasuryPromise) {
        _treasuryPromise = fetch('data/treasuries.json')
            .then(r => r.ok ? r.json() : null)
            .then(j => j?.companies || null)
            .catch(() => null);
    }
    return _treasuryPromise;
}
