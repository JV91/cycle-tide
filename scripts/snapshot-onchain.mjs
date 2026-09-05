#!/usr/bin/env node
// Fetch the on-chain series once and write them to data/onchain.json.
//
// Why this exists: bitcoin-data.com's free tier allows only 10 requests per
// HOUR per IP. Three endpoints per page load means a handful of visits
// exhausts the quota, after which the dashboard has no on-chain data at all
// and correctly refuses to give a call. Shipping a snapshot means the app
// always has a baseline; the live API is then only needed to top up recent
// days, and a 429 degrades to "slightly stale" instead of "no signal".
//
// Re-run periodically (daily is plenty — these metrics update once a day):
//   node scripts/snapshot-onchain.mjs

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'onchain.json');

const SERIES = [
    { key: 'mvrv_z', path: 'mvrv-zscore',    field: 'mvrvZscore' },
    { key: 'nupl',   path: 'nupl',           field: 'nupl' },
    { key: 'puell',  path: 'puell-multiple', field: 'puellMultiple' },
];

function get(url) {
    return new Promise((res, rej) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => res({ status: r.statusCode, body: d }));
        }).on('error', rej);
    });
}

const out = {};
let failed = 0;

for (const s of SERIES) {
    process.stdout.write(`Fetching ${s.path}… `);
    try {
        const { status, body } = await get(`https://api.bitcoin-data.com/v1/${s.path}`);
        const json = JSON.parse(body);
        if (status !== 200 || !Array.isArray(json)) {
            console.log(`FAILED (${status}) ${json?.error?.code || ''}`);
            failed++;
        } else {
            out[s.key] = json
                .map(r => ({ ts: new Date(r.d).getTime(), value: parseFloat(r[s.field]) }))
                .filter(r => !isNaN(r.value))
                .sort((a, b) => a.ts - b.ts);
            const last = out[s.key][out[s.key].length - 1];
            console.log(`${out[s.key].length} points, latest ${new Date(last.ts).toISOString().slice(0,10)} = ${last.value}`);
        }
    } catch (e) {
        console.log('ERROR ' + e.message);
        failed++;
    }
    // Stay well clear of the hourly limit.
    await new Promise(r => setTimeout(r, 2000));
}

if (!Object.keys(out).length) {
    console.error('\nNothing fetched — likely rate limited. Try again in an hour.');
    process.exit(1);
}

// Merge with any existing snapshot so a partial run never loses data.
let existing = {};
try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')).series || {}; } catch {}

const merged = { ...existing, ...out };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    note: 'Snapshot of bitcoin-data.com on-chain series. Free tier allows 10 req/hour, so the app ships this as a baseline and only tops up from the live API.',
    series: merged,
}));

const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`\nWrote ${OUT} (${kb} KB) with: ${Object.keys(merged).join(', ')}`);
if (failed) console.log(`${failed} endpoint(s) failed — re-run later to fill them in.`);
