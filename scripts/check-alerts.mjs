#!/usr/bin/env node
// Recompute the BTC cycle score headlessly and report whether it has crossed a
// band edge since the last run. Writes data/alert-state.json so the next run
// can compare, and prints machine-readable output for the workflow to act on.
//
// Deliberately mirrors the browser's scoring rather than reimplementing it:
// the signal definitions and indicator maths are loaded from the same source
// files the dashboard uses, so the two cannot drift apart.
//
//   node scripts/check-alerts.mjs

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STATE = path.join(ROOT, 'data', 'alert-state.json');

function get(url, headers = {}) {
    return new Promise((res, rej) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => res({ status: r.statusCode, body: d }));
        }).on('error', rej);
    });
}

// Load the real scoring logic from the app's own sources.
function loadModule(file, exportNames) {
    const src = fs.readFileSync(path.join(ROOT, 'js', file), 'utf8');
    const stripped = src.replace(/^\s*(async\s+)?function (render|attach|bind)\w+[\s\S]*$/m, '');
    return new Function(
        'function clamp(v,lo,hi){return Math.max(lo,Math.min(hi,v));}'
        + 'function mapRange(v,a,b,c,d){if(b===a)return c;return c+((v-a)/(b-a))*(d-c);}'
        // indicators.js reaches for this helper, which lives in data.js
        // alongside browser-only fetch code we cannot load here.
        + 'function latestAsOf(series,ts){if(!series||!series.length)return null;'
        + 'let lo=0,hi=series.length-1,ans=null;while(lo<=hi){const m=(lo+hi)>>1;'
        + 'if(series[m].ts<=ts){ans=series[m];lo=m+1;}else hi=m-1;}return ans?ans.value:null;}'
        + stripped + `; return {${exportNames.join(',')}};`
    )();
}

const { SIGNAL_DEFS, TOTAL_WEIGHT, CATEGORY_LABELS } =
    loadModule('constants.js', ['SIGNAL_DEFS', 'TOTAL_WEIGHT', 'CATEGORY_LABELS']);

// ── data ────────────────────────────────────────────────────────────────────
// Binance geo-blocks US IPs with HTTP 451, and GitHub's hosted runners are in
// the US. The 451 body is valid JSON ({"code":0,"msg":"...restricted
// location..."}) so JSON.parse succeeds, `b.length` is undefined, the loop
// breaks, and `daily` ends up empty — the script then died on
// `daily[daily.length - 1].close`. Because the commit step runs AFTER this one,
// a hard throw here meant the freshly fetched snapshots were never committed:
// every scheduled run from 2026-09-12 onward refreshed the data and then threw
// it away, leaving the deployed site five days stale while the workflow looked
// like it was running.
//
// Fall back to a mirror, and treat a non-array response as the failure it is
// rather than as an empty page.
const KLINE_HOSTS = [
    'https://api.binance.com',
    'https://data-api.binance.vision',   // same data, not geo-restricted
];

async function fetchKlines() {
    for (const host of KLINE_HOSTS) {
        const rows = [];
        let endTime = null, ok = true;
        for (let i = 0; i < 12; i++) {
            let b;
            try {
                const r = await get(host + '/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=1000'
                    + (endTime ? '&endTime=' + endTime : ''));
                b = JSON.parse(r.body);
            } catch { ok = false; break; }
            if (!Array.isArray(b)) {            // 451 / error object, not a page of bars
                ok = false;
                console.log(`  ${host}: ${b?.msg ? String(b.msg).slice(0, 80) : 'unexpected response'}`);
                break;
            }
            if (!b.length) break;
            rows.push(...b);
            endTime = b[0][0] - 1;
            if (b.length < 1000) break;
        }
        if (ok && rows.length) {
            if (host !== KLINE_HOSTS[0]) console.log(`  price history via ${host}`);
            return rows;
        }
    }
    return [];
}

const all = await fetchKlines();
const daily = all.map(k => ({ ts: k[0], close: +k[4], high: +k[2] }))
    .filter(p => p.close > 0).sort((a, b) => a.ts - b.ts);

// No price history means no score. Exit 0 so the workflow still commits the
// on-chain/ETF/treasury snapshots that were fetched successfully before this
// step — a missing alert is a far smaller problem than a site frozen on stale
// data, which is exactly what the previous behaviour caused.
if (!daily.length) {
    console.log('No BTC price history available from any source — skipping scoring.');
    console.log('Snapshots fetched by earlier steps are unaffected and will still be committed.');
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=false\nskipped=true\n');
    }
    process.exit(0);
}

const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'onchain.json'), 'utf8')).series;
const etf = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'etf-flows.json'), 'utf8')).series;

const fg = await get('https://api.alternative.me/fng/?limit=400')
    .then(r => JSON.parse(r.body).data.map(d => ({ ts: +d.timestamp * 1000, value: +d.value }))
        .sort((a, b) => a.ts - b.ts)).catch(() => []);
const fund = await get('https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1000')
    .then(r => JSON.parse(r.body).map(x => ({ ts: x.fundingTime, value: +x.fundingRate }))
        .sort((a, b) => a.ts - b.ts)).catch(() => []);
const stable = await get('https://stablecoins.llama.fi/stablecoincharts/all')
    .then(r => JSON.parse(r.body).map(x => ({ ts: +x.date * 1000, value: x.totalCirculatingUSD?.peggedUSD }))
        .filter(x => x.value > 0)).catch(() => []);

const ind = loadModule('indicators.js',
    ['computeAthDrawdown', 'computeMa200wMultiple', 'computeMonthlyRSI', 'computePiCycle',
     'computeSSRPercentileSeries', 'estimateCirculatingSupply', 'computeEtfFlowPercentile']);

// latestAsOf is defined in data.js alongside browser-only code; reimplement.
const latest = s => (s && s.length) ? s[s.length - 1].value : null;

const supply = ind.estimateCirculatingSupply(daily[daily.length - 1].ts);
const values = {
    ath_drawdown: latest(ind.computeAthDrawdown(daily).series),
    ma200w_mult:  latest(ind.computeMa200wMultiple(daily).series),
    rsi_monthly:  latest(ind.computeMonthlyRSI(daily).series),
    pi_cycle:     latest(ind.computePiCycle(daily).series),
    etf_flow:     latest(ind.computeEtfFlowPercentile(etf)),
    ssr:          latest(ind.computeSSRPercentileSeries(daily, supply, stable)),
    mvrv_z:       latest(snap.mvrv_z),
    nupl:         latest(snap.nupl),
    puell:        latest(snap.puell),
    funding:      latest(fund),
    fear_greed:   latest(fg),
};

// ── score ───────────────────────────────────────────────────────────────────
let sum = 0, avail = 0;
const byCat = {};
const missing = [];
for (const def of SIGNAL_DEFS) {
    const sc = def.score(values[def.key]);
    const c = byCat[def.category] ||= { total: 0, avail: 0 };
    c.total += def.weight;
    if (sc !== null) { sum += sc * def.weight; avail += def.weight; c.avail += def.weight; }
    else missing.push(def.label);
}
const score = avail > 0 ? sum / avail : null;
const confidence = avail / TOTAL_WEIGHT;

// The on-chain series come from the committed snapshot, which goes stale
// whenever the daily refresh is rate-limited (bitcoin-data.com allows 10
// requests/hour). Those signals still count toward model weight, so without
// this check an alert email can report "confidence=100%" on a score partly
// computed from week-old data. Measure the age of the newest row we actually
// used rather than trusting the file to be current.
const STALE_DAYS = 3;
const today = Date.now();
const staleSeries = [];
for (const [key, label, weight] of [
    ['mvrv_z', 'MVRV Z-Score', 12], ['nupl', 'NUPL', 8], ['puell', 'Puell Multiple', 8],
]) {
    const rows = snap?.[key];
    if (!rows?.length) continue;
    const age = Math.floor((today - rows[rows.length - 1].ts) / 86400000);
    if (age >= STALE_DAYS) staleSeries.push({ label, age, weight });
}
const staleWeight = staleSeries.reduce((a, b) => a + b.weight, 0);
const darkCats = Object.entries(byCat).filter(([, c]) => c.avail === 0)
    .map(([k]) => CATEGORY_LABELS[k] || k);
const reliable = score !== null && confidence >= 0.70 && darkCats.length === 0;

const band = s => s === null ? 'NO CALL'
    : s >= 75 ? 'ACCUMULATE (Phase 1)'
    : s >= 55 ? 'ACCUMULATE (Phase 2)'
    : s >= 35 ? 'HOLD'
    : s >= 15 ? 'DISTRIBUTE (watch)' : 'DISTRIBUTE';

const now = { score: score === null ? null : Math.round(score),
              band: reliable ? band(score) : 'NO CALL',
              confidence: Math.round(confidence * 100),
              staleWeight,
              staleNote: staleSeries.length
                  ? staleSeries.map(x => `${x.label} ${x.age}d`).join(', ')
                  : null,
              price: Math.round(daily[daily.length - 1].close),
              date: new Date().toISOString().slice(0, 10) };

let prev = null;
try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}

const changed = prev && prev.band !== now.band;
fs.writeFileSync(STATE, JSON.stringify({ ...now, previousBand: prev?.band ?? null }, null, 2));

console.log(`score=${now.score} band=${now.band} confidence=${now.confidence}%`
    + (staleWeight ? ` (${staleWeight}% of weight stale: ${now.staleNote})` : '')
    + ` price=$${now.price}`);
if (missing.length) console.log('missing: ' + missing.join(', '));

// Signal the workflow via GITHUB_OUTPUT when a band edge is crossed.
if (process.env.GITHUB_OUTPUT) {
    const out = [
        `changed=${changed ? 'true' : 'false'}`,
        `score=${now.score}`,
        `band=${now.band}`,
        `previous=${prev?.band ?? 'none'}`,
        `confidence=${now.confidence}`,
        // Surfaced in the email: a band change computed partly from a stale
        // snapshot should say so rather than read as a fresh signal.
        `staleweight=${now.staleWeight}`,
        `stalenote=${now.staleNote ?? ''}`,
        `price=${now.price}`,
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, out + '\n');
}
if (changed) console.log(`BAND CHANGED: ${prev.band} -> ${now.band}`);
