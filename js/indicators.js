// ── Cycle Tide — self-computed price-technical indicators ──────────────────
// All operate on a daily {ts, close}[] series (ascending by ts).

// Drawdown from the running all-time high. The ATH reference uses the
// intraday HIGH (the conventional definition — what "BTC's ATH is $126,199"
// means), while the current level is the close. Measuring both off closes
// understates every drawdown.
function computeAthDrawdown(daily) {
    if (!daily.length) return { series: [], latest: null, ath: null, athTs: null };
    let ath = -Infinity, athTs = null;
    const series = daily.map(d => {
        const high = d.high ?? d.close;
        if (high > ath) { ath = high; athTs = d.ts; }
        return { ts: d.ts, value: (d.close - ath) / ath };
    });
    return { series, latest: series[series.length - 1].value, ath, athTs };
}

// 200-week SMA = 1400-day SMA of daily closes, expressed as price/MA multiple.
function computeMa200wMultiple(daily) {
    const N = 1400;
    if (daily.length < N) return { series: [], latest: null };
    const series = [];
    let sum = 0;
    for (let i = 0; i < daily.length; i++) {
        sum += daily[i].close;
        if (i >= N) sum -= daily[i - N].close;
        if (i >= N - 1) {
            const ma = sum / N;
            series.push({ ts: daily[i].ts, value: ma > 0 ? daily[i].close / ma : null });
        }
    }
    return { series, latest: series.length ? series[series.length - 1].value : null };
}

// ── Pi Cycle Top ───────────────────────────────────────────────────────────
// 111-day SMA vs 2 × 350-day SMA. When the 111DMA crosses ABOVE 2×350DMA it
// has marked cycle tops within days (2013 both peaks, 2017, 2021). 350/111 ≈ π.
//
// Scored as the RATIO 111DMA / (2 × 350DMA) rather than the bare crossover,
// so it contributes a continuous "how close to a top" reading instead of a
// binary that's 0 for years at a time:
//   ratio >= 1.0  → crossover fired, historical top zone
//   ratio ~ 0.4   → early cycle / deep bear
//
// Caveat worth knowing: this has not clearly re-triggered in the ETF era, and
// some analysts consider its reliability untested under the post-2024 market
// structure. It carries modest weight for that reason.
function computePiCycle(daily) {
    const FAST = 111, SLOW = 350;
    if (daily.length < SLOW) return { series: [], latest: null, crossed: false };

    const sma = (n) => {
        const out = new Array(daily.length).fill(null);
        let sum = 0;
        for (let i = 0; i < daily.length; i++) {
            sum += daily[i].close;
            if (i >= n) sum -= daily[i - n].close;
            if (i >= n - 1) out[i] = sum / n;
        }
        return out;
    };

    const fast = sma(FAST), slow = sma(SLOW);
    const series = [];
    for (let i = 0; i < daily.length; i++) {
        if (fast[i] === null || slow[i] === null) continue;
        const denom = 2 * slow[i];
        if (denom > 0) series.push({ ts: daily[i].ts, value: fast[i] / denom });
    }

    const latest = series.length ? series[series.length - 1].value : null;
    return { series, latest, crossed: latest !== null && latest >= 1 };
}

// Resample daily closes to month-end closes, then standard RSI(14).
function computeMonthlyRSI(daily) {
    if (!daily.length) return { series: [], latest: null };
    const monthly = [];
    let curKey = null, lastClose = null;
    for (const d of daily) {
        const date = new Date(d.ts);
        const key = date.getUTCFullYear() * 12 + date.getUTCMonth();
        if (key !== curKey) {
            if (lastClose !== null) monthly.push(lastClose);
            curKey = key;
        }
        lastClose = { ts: d.ts, close: d.close };
    }
    if (lastClose) monthly.push(lastClose);

    const period = 14;
    if (monthly.length < period + 1) return { series: [], latest: null };

    const series = [];
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const chg = monthly[i].close - monthly[i - 1].close;
        if (chg >= 0) avgGain += chg; else avgLoss -= chg;
    }
    avgGain /= period; avgLoss /= period;
    series.push(rsiPoint(monthly[period].ts, avgGain, avgLoss));

    for (let i = period + 1; i < monthly.length; i++) {
        const chg = monthly[i].close - monthly[i - 1].close;
        const gain = chg >= 0 ? chg : 0;
        const loss = chg < 0 ? -chg : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        series.push(rsiPoint(monthly[i].ts, avgGain, avgLoss));
    }
    return { series, latest: series.length ? series[series.length - 1].value : null };
}

function rsiPoint(ts, avgGain, avgLoss) {
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));
    return { ts, value: rsi };
}

// Stablecoin Supply Ratio = BTC market cap / total stablecoin supply.
// Returns the SSR series plus the latest value's percentile rank within the
// trailing `windowDays` (default 2y) — low percentile = relatively more
// stablecoin dry powder vs BTC's own market cap = accumulation-favorable.
function computeSSRPercentile(dailyBtc, circulatingSupplyBtc, stablecoinSeries, windowDays = 730) {
    if (!dailyBtc.length || !stablecoinSeries.length) return { series: [], latestPercentile: null };

    const series = dailyBtc.map(d => {
        const stable = latestAsOf(stablecoinSeries, d.ts);
        if (!stable) return { ts: d.ts, value: null };
        const mcap = d.close * circulatingSupplyBtc;
        return { ts: d.ts, value: mcap / stable };
    }).filter(p => p.value !== null);

    if (!series.length) return { series, latestPercentile: null };

    const windowStart = series[series.length - 1].ts - windowDays * 86400000;
    const windowVals = series.filter(p => p.ts >= windowStart).map(p => p.value).sort((a, b) => a - b);
    const latestVal = series[series.length - 1].value;
    const rank = windowVals.filter(v => v <= latestVal).length / windowVals.length;

    return { series, latestPercentile: rank };
}

// Rolling-percentile SSR series: for each day, where that day's SSR ranked
// within the trailing `windowDays`. Needed (vs. just the latest value) so the
// date browser can score any past day the same way it scores today.
function computeSSRPercentileSeries(dailyBtc, circulatingSupplyBtc, stablecoinSeries, windowDays = 730) {
    if (!dailyBtc.length || !stablecoinSeries.length) return [];

    const raw = dailyBtc.map(d => {
        const stable = latestAsOf(stablecoinSeries, d.ts);
        if (!stable) return null;
        return { ts: d.ts, value: (d.close * circulatingSupplyBtc) / stable };
    }).filter(Boolean);

    const windowMs = windowDays * 86400000;
    const out = [];
    let lo = 0;
    for (let i = 0; i < raw.length; i++) {
        while (raw[lo].ts < raw[i].ts - windowMs) lo++;
        const win = raw.slice(lo, i + 1);
        // Need a meaningful window before a percentile means anything.
        if (win.length < 30) continue;
        const v = raw[i].value;
        const rank = win.filter(p => p.value <= v).length / win.length;
        out.push({ ts: raw[i].ts, value: rank });
    }
    return out;
}

// ── ETF net flow ───────────────────────────────────────────────────────────
// Daily net flow is far too noisy to score directly (it swings from -$1.1bn to
// +$1.4bn day to day), so this sums a trailing 30 days and then percentile-
// ranks that against a trailing window. The percentile is what gets scored:
// it answers "is institutional demand strong or weak relative to this cycle?"
// rather than "was yesterday a big day?".
function computeEtfFlowPercentile(flowSeries, sumDays = 30, windowDays = 540) {
    if (!flowSeries || flowSeries.length < sumDays) return [];

    // Trailing 30-day sum at each day.
    const rolling = [];
    let sum = 0;
    for (let i = 0; i < flowSeries.length; i++) {
        sum += flowSeries[i].value;
        if (i >= sumDays) sum -= flowSeries[i - sumDays].value;
        if (i >= sumDays - 1) rolling.push({ ts: flowSeries[i].ts, value: sum });
    }
    if (!rolling.length) return [];

    // Percentile rank of each day within its own trailing window.
    const windowMs = windowDays * 86400000;
    const out = [];
    let lo = 0;
    for (let i = 0; i < rolling.length; i++) {
        while (rolling[lo].ts < rolling[i].ts - windowMs) lo++;
        const win = rolling.slice(lo, i + 1);
        if (win.length < 60) continue; // need a real distribution to rank against
        const v = rolling[i].value;
        out.push({ ts: rolling[i].ts, value: win.filter(p => p.value <= v).length / win.length });
    }
    return out;
}

// Rough circulating supply estimate (BTC), good enough for SSR — updates
// deterministically via the halving schedule, no external call needed.
function estimateCirculatingSupply(atTs = Date.now()) {
    const genesis = new Date('2009-01-03').getTime();
    const blocksPerHalving = 210000;
    const secPerBlock = 600;
    let supply = 0, reward = 50, blocksLeft = Math.floor((atTs - genesis) / 1000 / secPerBlock);
    while (blocksLeft > 0 && reward > 0.00000001) {
        const blocks = Math.min(blocksLeft, blocksPerHalving);
        supply += blocks * reward;
        blocksLeft -= blocks;
        reward /= 2;
    }
    return supply;
}
