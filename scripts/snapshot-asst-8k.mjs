#!/usr/bin/env node
// Build data/asst-capital.json — Strive's current capital structure.
//
// Strategy publishes live figures at api.strategy.com; Strive publishes
// nothing comparable, which is why every ASST number in this dashboard used to
// come from a quarterly 10-Q and drift badly between filings (its share count
// was ~13% stale and its holdings ~23% stale by late September).
//
// But Strive files an 8-K after EVERY bitcoin purchase — roughly weekly — and
// each one carries a full capital-structure table:
//
//     As of September 18, 2026
//     Cash and cash equivalents (in thousands)   $229,600
//     Fair value of STRC Stock (in thousands)     $49,748
//     Bitcoin held                                 26,355
//     Class A common stock                     87,804,613
//     Class B common stock                      9,198,036
//     Effective Common Shares Outstanding       97,002,649
//     Assumed Fully Diluted Shares             100,144,713
//     SATA Stock                               11,184,160
//
// That is everything needed for both a gross and a net mNAV, dated to within a
// week. Parsing the newest 8-K gives ASST the same standing MSTR already has.
//
//   node scripts/snapshot-asst-8k.mjs

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'asst-capital.json');
const SEC_UA = 'CycleTide dashboard (janvais1991@gmail.com)';
const CIK = '0001920406';

function get(url, headers = {}) {
    return new Promise((res, rej) => {
        https.get(url, { headers: { 'User-Agent': SEC_UA, ...headers } }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => res({ status: r.statusCode, body: d }));
        }).on('error', rej);
    });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// EDGAR splits words across inline spans, so flatten before matching and keep
// digit separators intact.
const flatten = html => html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&#8212;|&#8211;/g, '-')
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/\s+/g, ' ');

const num = s => {
    const n = parseFloat(String(s).replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
};

// Each row reads "<label> <prior value> <current value> <change>", so the
// SECOND number on the row is the current one. Anchoring on the label and
// taking the second match keeps that stable even when the change column is an
// em-dash or a parenthesised negative.
function rowValue(text, label) {
    const re = new RegExp(
        label + String.raw`\s*(?:\(\d\)\s*)?\$?\s*\(?(-?[\d,.]+)\)?\s*\$?\s*\(?(-?[\d,.]+)\)?`,
        'i');
    const m = text.match(re);
    if (!m) return null;
    return num(m[2] ?? m[1]);
}

async function latestCapitalTable() {
    const subs = await get(`https://data.sec.gov/submissions/CIK${CIK}.json`);
    if (subs.status !== 200) throw new Error('submissions HTTP ' + subs.status);
    const rec = JSON.parse(subs.body)?.filings?.recent;
    if (!rec) throw new Error('no filings');

    for (let i = 0; i < rec.form.length; i++) {
        if (rec.form[i] !== '8-K') continue;
        const url = `https://www.sec.gov/Archives/edgar/data/${Number(CIK)}/`
                  + `${rec.accessionNumber[i].replace(/-/g, '')}/${rec.primaryDocument[i]}`;
        const r = await get(url);
        await sleep(320);
        if (r.status !== 200) continue;
        const text = flatten(r.body);
        if (!/following updates to its holdings/i.test(text)) continue;

        // "As of <date A> As of <date B>" — B is the current column.
        const dates = [...text.matchAll(/As of ([A-Z][a-z]+ \d{1,2}, \d{4})/g)].map(m => m[1]);
        const asOf = dates.length >= 2 ? dates[1] : dates[0] || null;

        const classA   = rowValue(text, 'Class A common stock');
        const classB   = rowValue(text, 'Class B common stock');
        const effective = rowValue(text, 'Effective Common Shares Outstanding');
        const diluted  = rowValue(text, 'Assumed Fully Diluted Shares');
        const sata     = rowValue(text, 'SATA Stock');
        const btc      = rowValue(text, 'Bitcoin held');
        const cashK    = rowValue(text, String.raw`Cash and cash equivalents \(in thousands\)`);
        const strcK    = rowValue(text, String.raw`Fair value of STRC Stock \(in thousands\)`);

        if (!btc || !effective) continue;   // not the table we want

        return {
            asOf: asOf ? new Date(asOf + ' UTC').toISOString().slice(0, 10) : null,
            filed: rec.filingDate[i],
            accession: rec.accessionNumber[i],
            btcHoldings: btc,
            classA, classB,
            // Class A + Class B. The company's own preferred denominator, and
            // the one that matches the market cap a quote service reports.
            effectiveShares: effective,
            dilutedShares: diluted,
            // SATA is perpetual preferred with a $100 stated amount, carried in
            // mezzanine equity — senior to common in a wind-up.
            sataShares: sata,
            sataStatedAmount: 100,
            cashUsd: cashK !== null ? cashK * 1000 : null,
            strcFairValueUsd: strcK !== null ? strcK * 1000 : null,
            sourceUrl: url,
        };
    }
    return null;
}

const cap = await latestCapitalTable();
if (!cap) {
    console.error('No 8-K capital table found — leaving existing snapshot alone.');
    process.exit(1);
}

console.log(`Strive capital structure as of ${cap.asOf} (filed ${cap.filed})`);
console.log(`  bitcoin held        ${cap.btcHoldings.toLocaleString()}`);
console.log(`  effective shares    ${cap.effectiveShares.toLocaleString()}`);
console.log(`  fully diluted       ${cap.dilutedShares?.toLocaleString() ?? 'n/a'}`);
console.log(`  SATA preferred      ${cap.sataShares?.toLocaleString() ?? 'n/a'} x $100`);
console.log(`  cash                $${((cap.cashUsd ?? 0) / 1e6).toFixed(1)}M`);
console.log(`  STRC held           $${((cap.strcFairValueUsd ?? 0) / 1e6).toFixed(1)}M`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    note: 'Strive capital structure parsed from the most recent 8-K bitcoin-purchase '
        + 'announcement, which tabulates holdings, share classes and preferred. Filed '
        + 'roughly weekly, so this is far fresher than the quarterly 10-Q figures.',
    company: 'ASST',
    ...cap,
}, null, 2));
console.log(`\nWrote ${OUT}`);
