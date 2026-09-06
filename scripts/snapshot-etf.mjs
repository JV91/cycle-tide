#!/usr/bin/env node
// Build/refresh data/etf-flows.json — US spot Bitcoin ETF daily net flows.
//
// Two sources, by design:
//   1. TFTC (free, no key, CC BY 4.0) — full history back to the 2024-01-11
//      launch. This is the backfill and the fallback.
//   2. SoSoValue (needs SOSOVALUE_API_KEY in .env.local) — only exposes the
//      last ~30 days on the Demo plan, but is upstream of TFTC, so it is used
//      to top up the most recent days if TFTC lags.
//
// TFTC is a mirror of SoSoValue + Farside, so it could disappear. That is why
// the merged result is COMMITTED to the repo rather than fetched at runtime:
// a dead URL can then never break the dashboard.
//
//   node scripts/snapshot-etf.mjs

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'etf-flows.json');
const ENV = path.join(__dirname, '..', '.env.local');

function get(url, headers = {}) {
    return new Promise((res, rej) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => res({ status: r.statusCode, body: d }));
        }).on('error', rej);
    });
}

function readKey() {
    try {
        const m = fs.readFileSync(ENV, 'utf8').match(/SOSOVALUE_API_KEY\s*=\s*(\S+)/);
        return m ? m[1] : null;
    } catch { return null; }
}

// ── 1. TFTC full history ────────────────────────────────────────────────────
async function fetchTFTC() {
    const r = await get('https://www.tftc.io/bitcoin-etf-flows/data.json');
    if (r.status !== 200) throw new Error('TFTC HTTP ' + r.status);
    const j = JSON.parse(r.body);
    if (!Array.isArray(j.days)) throw new Error('TFTC: unexpected shape');
    return {
        rows: j.days
            .filter(d => typeof d.netFlowUsd === 'number')
            .map(d => ({ ts: Date.parse(d.date + 'T00:00:00Z'), value: d.netFlowUsd })),
        attribution: j.attribution || 'TFTC (tftc.io), CC BY 4.0',
        updatedThrough: j.updatedThrough || null,
    };
}

// ── 2. SoSoValue recent top-up (optional) ───────────────────────────────────
async function fetchSoso() {
    const key = readKey();
    if (!key) return [];
    const url = 'https://openapi.sosovalue.com/openapi/v1/etfs/summary-history'
              + '?symbol=BTC&country_code=US';
    const r = await get(url, { 'x-soso-api-key': key });
    if (r.status !== 200) {
        console.log(`  SoSoValue top-up skipped (HTTP ${r.status})`);
        return [];
    }
    const j = JSON.parse(r.body);
    const d = Array.isArray(j.data) ? j.data : [];
    return d
        .filter(x => typeof x.total_net_inflow === 'number')
        .map(x => ({ ts: Date.parse(x.date + 'T00:00:00Z'), value: x.total_net_inflow }));
}

const out = { generated: new Date().toISOString() };

console.log('Fetching TFTC full history…');
const tftc = await fetchTFTC();
console.log(`  ${tftc.rows.length} days, through ${tftc.updatedThrough}`);

console.log('Fetching SoSoValue recent window…');
const soso = await fetchSoso();
if (soso.length) console.log(`  ${soso.length} recent days`);

// SoSoValue wins on overlap: it is upstream of TFTC, so it is fresher.
const byTs = new Map(tftc.rows.map(p => [p.ts, p]));
let added = 0;
for (const p of soso) {
    if (!byTs.has(p.ts)) added++;
    byTs.set(p.ts, p);
}
const merged = [...byTs.values()].sort((a, b) => a.ts - b.ts);
if (added) console.log(`  ${added} day(s) newer than TFTC`);

const iso = ts => new Date(ts).toISOString().slice(0, 10);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
    generated: out.generated,
    attribution: tftc.attribution,
    license: 'CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/',
    note: 'US spot Bitcoin ETF aggregate daily net flow (USD). Sources: TFTC (tftc.io), which compiles SoSoValue and Farside Investors; topped up from SoSoValue where newer.',
    series: merged,
}));

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`\nWrote ${OUT} (${kb} KB)`);
console.log(`  ${merged.length} days, ${iso(merged[0].ts)} → ${iso(merged[merged.length - 1].ts)}`);
