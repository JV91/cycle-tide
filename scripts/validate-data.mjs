#!/usr/bin/env node
// Validate data/*.json before it is committed and served.
//
// These files are the only link between the scripts that write them (GitHub
// Actions) and the code that reads them (the browser, and check-alerts.mjs).
// Nothing imports across that boundary, so a writer can change what it saves
// and no reader notices — which is how three bugs reached the live site:
//
//   * a late refresh wrote a SHORTER price list over a fresher one, losing the
//     newest session's close (MSTR showed $132.25 instead of $153.92)
//   * an incremental run saved a trimmed record, silently dropping
//     dilutedShares and sataStatedAmount
//   * the 8-K parser stored Strive's Class A share count as 0.001 (the par
//     value), so Class A + Class B no longer added up to total shares
//
// Each check below is the contract a reader relies on, plus a comparison with
// the last COMMITTED version so a refresh can never make data older or
// thinner without saying so.
//
//   node scripts/validate-data.mjs              report only
//   node scripts/validate-data.mjs --restore    put failing files back to HEAD
//
// With --restore, a failing file is reverted to its committed version: the site
// keeps serving the last good data, the other files still commit, and the
// failure is reported (GITHUB_OUTPUT `invalid=`, plus the job summary) so the
// workflow can turn the run red instead of failing silently.

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESTORE = process.argv.includes('--restore');

const read = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
function committed(rel) {
    try {
        return JSON.parse(execFileSync('git', ['show', `HEAD:${rel}`],
            { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
    } catch { return null; }   // new file, or no git: shape checks only
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const pos = v => isNum(v) && v > 0;
const isoDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
const day = ts => new Date(ts).toISOString().slice(0, 10);

// A {ts, value|close} series: non-empty, finite, strictly ascending.
function checkSeries(errs, name, s, valueKey, minLen = 20) {
    if (!Array.isArray(s) || s.length < minLen) {
        errs.push(`${name}: expected at least ${minLen} rows, got ${Array.isArray(s) ? s.length : typeof s}`);
        return;
    }
    for (let i = 0; i < s.length; i++) {
        if (!isNum(s[i]?.ts) || !isNum(s[i]?.[valueKey])) {
            errs.push(`${name}[${i}]: non-numeric ts/${valueKey}`); return;
        }
        if (i && s[i].ts <= s[i - 1].ts) {
            errs.push(`${name}: not strictly ascending at row ${i} (${day(s[i].ts)})`); return;
        }
    }
}

// The series must not lose its newest row or shrink against what is committed.
function noRegression(errs, name, cur, prev) {
    if (!Array.isArray(prev) || !prev.length || !Array.isArray(cur) || !cur.length) return;
    const cLast = cur[cur.length - 1].ts, pLast = prev[prev.length - 1].ts;
    if (cLast < pLast) errs.push(`${name}: newest row went BACKWARDS, ${day(pLast)} -> ${day(cLast)}`);
    if (cur.length < prev.length * 0.98) errs.push(`${name}: shrank from ${prev.length} to ${cur.length} rows`);
}

const CHECKS = {
    'data/treasuries.json'(cur, prev) {
        const e = [];
        if (!isoDay(cur.generated)) e.push('generated: missing or not a date');
        for (const k of ['MSTR', 'ASST']) {
            const c = cur.companies?.[k], p = prev?.companies?.[k];
            if (!c) { e.push(`${k}: missing`); continue; }
            if (!pos(c.btcHoldings)) e.push(`${k}.btcHoldings: ${c.btcHoldings}`);
            if (p && pos(p.btcHoldings) && c.btcHoldings < p.btcHoldings * 0.5)
                e.push(`${k}.btcHoldings: fell by more than half (${p.btcHoldings} -> ${c.btcHoldings})`);
            checkSeries(e, `${k}.prices`, c.prices, 'close', 100);
            if (Array.isArray(c.prices) && c.prices.some(b => !(b.close > 0))) e.push(`${k}.prices: non-positive close`);
            noRegression(e, `${k}.prices`, c.prices, p?.prices);

            const sh = c.sharesHistory;
            if (!Array.isArray(sh) || !sh.length) { e.push(`${k}.sharesHistory: empty`); continue; }
            for (const r of sh) {
                if (!pos(r.shares)) { e.push(`${k}.sharesHistory ${r.end}: shares ${r.shares}`); break; }
                if (Array.isArray(r.classes) && r.classes.length > 1 && !r.splitFactor) {
                    const sum = r.classes.reduce((a, b) => a + b, 0);
                    if (sum !== r.shares) { e.push(`${k}.sharesHistory ${r.end}: classes sum ${sum} != shares ${r.shares}`); break; }
                }
            }
            const last = sh[sh.length - 1], plast = p?.sharesHistory?.[p.sharesHistory.length - 1];
            if (plast && pos(plast.shares) && (last.shares > plast.shares * 2 || last.shares < plast.shares * 0.5))
                e.push(`${k}.sharesHistory: latest count moved more than 2x (${plast.shares} -> ${last.shares}); a parse error is likelier than a real change`);
        }
        return e;
    },

    'data/asst-capital.json'(cur, prev) {
        const e = [];
        const REQUIRED = ['btcHoldings', 'classA', 'classB', 'effectiveShares', 'dilutedShares', 'sataShares'];
        const NONNEG = ['cashUsd', 'strcFairValueUsd'];
        const row = (r, where) => {
            if (!isoDay(r?.asOf)) e.push(`${where}: asOf missing`);
            for (const f of REQUIRED) if (!pos(r?.[f])) e.push(`${where}.${f}: ${r?.[f]}`);
            for (const f of NONNEG) if (!(isNum(r?.[f]) && r[f] >= 0)) e.push(`${where}.${f}: ${r?.[f]}`);
            if (r?.sataStatedAmount !== 100) e.push(`${where}.sataStatedAmount: ${r?.sataStatedAmount} (expected 100)`);
            if (pos(r?.classA) && pos(r?.classB) && pos(r?.effectiveShares) && r.classA + r.classB !== r.effectiveShares)
                e.push(`${where}: Class A ${r.classA} + Class B ${r.classB} != effective ${r.effectiveShares}`);
            if (pos(r?.dilutedShares) && pos(r?.effectiveShares) && r.dilutedShares < r.effectiveShares)
                e.push(`${where}: fully diluted ${r.dilutedShares} below outstanding ${r.effectiveShares}`);
        };
        row(cur, 'latest');
        const h = cur.history;
        if (!Array.isArray(h) || !h.length) e.push('history: empty');
        else {
            h.forEach((r, i) => row(r, `history[${i}] ${r?.asOf ?? ''}`));
            for (let i = 1; i < h.length; i++)
                if (!(h[i].asOf > h[i - 1].asOf)) { e.push(`history: not ascending at ${h[i].asOf}`); break; }
            if (h[h.length - 1].asOf !== cur.asOf) e.push(`latest asOf ${cur.asOf} != newest history row ${h[h.length - 1].asOf}`);
        }
        if (prev?.asOf && cur.asOf < prev.asOf) e.push(`asOf went BACKWARDS, ${prev.asOf} -> ${cur.asOf}`);
        if (Array.isArray(prev?.history) && Array.isArray(h) && h.length < prev.history.length)
            e.push(`history shrank from ${prev.history.length} to ${h.length} rows`);
        return e;
    },

    'data/onchain.json'(cur, prev) {
        const e = [];
        for (const k of ['nupl']) {
            checkSeries(e, `series.${k}`, cur.series?.[k], 'value', 100);
            noRegression(e, `series.${k}`, cur.series?.[k], prev?.series?.[k]);
        }
        return e;
    },

    'data/etf-flows.json'(cur, prev) {
        const e = [];
        checkSeries(e, 'series', cur.series, 'value', 100);
        noRegression(e, 'series', cur.series, prev?.series);
        return e;
    },
};

const invalid = [];
const summary = ['### Data file validation', ''];
for (const [rel, check] of Object.entries(CHECKS)) {
    let errs;
    try { errs = check(read(rel), committed(rel)); }
    catch (err) { errs = [`unreadable: ${err.message}`]; }
    if (!errs.length) {
        console.log(`ok    ${rel}`);
        summary.push(`- ✅ \`${rel}\``);
        continue;
    }
    invalid.push(rel);
    console.log(`FAIL  ${rel}`);
    errs.slice(0, 10).forEach(x => console.log(`        ${x}`));
    summary.push(`- ❌ \`${rel}\``, ...errs.slice(0, 10).map(x => `  - ${x}`));
    if (RESTORE) {
        try {
            execFileSync('git', ['checkout', 'HEAD', '--', rel], { cwd: ROOT, stdio: 'ignore' });
            console.log(`        restored to the committed version`);
            summary.push('  - restored to the committed version');
        } catch {
            console.log(`        could not restore (not committed yet?)`);
        }
    }
}

if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `invalid=${invalid.join(' ')}\n`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
// Report-only runs exit non-zero on failure; --restore runs exit 0 so the
// workflow can still commit the files that passed, and fails the job later.
process.exit(invalid.length && !RESTORE ? 1 : 0);
