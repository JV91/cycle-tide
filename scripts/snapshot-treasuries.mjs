#!/usr/bin/env node
// Build data/treasuries.json — BTC treasury company reference data.
//
//   • BTC holdings + cost basis  — CoinGecko public_treasury (free, no key)
//   • Shares outstanding         — SEC EDGAR 10-Q/10-K cover page (free, official)
//
// Shares outstanding comes from the FILING COVER PAGE, not from XBRL. This
// matters more than it sounds. We previously used the XBRL concept
// WeightedAverageNumberOfDilutedSharesOutstanding, which is wrong twice over:
//
//   1. It is an AVERAGE over the reporting period, not a point-in-time count.
//      For companies issuing stock continuously to buy BTC, the period average
//      trails the true count badly — it understated MSTR by 10.7% and ASST by
//      19.8%, deflating mNAV by the same proportion and making both look
//      cheaper than they were.
//   2. Its cadence is deceptive: a 10-K carries a FULL-YEAR average, so the
//      annual row can read LOWER than the preceding quarter's row and look
//      like the share count shrank when it was still climbing.
//
// Neither company tags a point-in-time count in XBRL (no
// CommonStockSharesOutstanding; dei:EntityCommonStockSharesOutstanding 404s
// because both are multi-class), so the cover page is the only official
// source. Both have Class A and Class B, and BOTH must be summed — Class B is
// ~5% of MSTR and ~11% of ASST, and dropping it silently understates mNAV.
//
// This is the count of shares that EXIST, not a fully-diluted figure. Strategy's
// own dashboard publishes a larger number (~420M vs our 384M) because it assumes
// conversion of all converts, preferred, options and RSUs. That is a legitimate
// but different measure; see mNAV notes in js/asset_signal.js.
//
//   node scripts/snapshot-treasuries.mjs

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'data', 'treasuries.json');

// SEC asks for a descriptive UA with contact info on its APIs.
const SEC_UA = 'CycleTide dashboard (janvais1991@gmail.com)';

const COMPANIES = [
    { key: 'MSTR', ticker: 'MSTR', cik: '0001050446', name: 'Strategy',
      cgMatch: /^Strategy$/i },
    { key: 'ASST', ticker: 'ASST', cik: '0001920406', name: 'Strive',
      cgMatch: /^Strive$/i },
];

function get(url, headers = {}) {
    return new Promise((res, rej) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => res({ status: r.statusCode, body: d }));
        }).on('error', rej);
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Split events per symbol, populated by fetchEquity, consumed by adjustSplits.
const splits = {};

// ── Equity daily prices ─────────────────────────────────────────────────────
// Yahoo's chart endpoint sends no CORS headers, so a browser cannot call it.
// Fetching here (server-side, where CORS does not apply) and committing the
// result is the same pattern used for the on-chain and ETF snapshots.
async function fetchEquity(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
              + '?interval=1d&range=5y&events=split';
    const r = await get(url);
    if (r.status !== 200) throw new Error(`${symbol} HTTP ${r.status}`);
    const res = JSON.parse(r.body)?.chart?.result?.[0];
    if (!res?.timestamp) throw new Error(`${symbol}: no chart data`);
    // Yahoo prices are split-ADJUSTED all the way back; SEC cover-page share
    // counts are as-reported, i.e. PRE-split before the event. Multiplying the
    // two without reconciling them is a 10x error on MSTR before Aug 2024 —
    // it produced historical mNAVs of 0.07x, implying a 93% discount that
    // never existed. Return the split events so the share series can be put
    // on the same basis.
    splits[symbol] = Object.values(res.events?.splits || {})
        .map(s => ({
            ts: s.date * 1000,
            // splitRatio "10:1" = each old share became 10 new ones.
            factor: (() => {
                const [a, b] = String(s.splitRatio).split(/[:\/]/).map(Number);
                return (a && b) ? a / b : 1;
            })(),
        }))
        .sort((a, b) => a.ts - b.ts);
    const q = res.indicators.quote[0];
    const out = [];
    for (let i = 0; i < res.timestamp.length; i++) {
        const close = q.close[i], high = q.high[i];
        if (typeof close !== 'number') continue; // holidays / halts
        out.push({
            ts: res.timestamp[i] * 1000,
            close: Math.round(close * 1e4) / 1e4,
            high: typeof high === 'number' ? Math.round(high * 1e4) / 1e4 : Math.round(close * 1e4) / 1e4,
        });
    }
    return out.sort((a, b) => a.ts - b.ts);
}

// ── BTC holdings ────────────────────────────────────────────────────────────
async function fetchHoldings() {
    const r = await get('https://api.coingecko.com/api/v3/companies/public_treasury/bitcoin');
    if (r.status !== 200) throw new Error('CoinGecko HTTP ' + r.status);
    return JSON.parse(r.body).companies || [];
}

// ── BTC holdings history (quarterly, from SEC XBRL) ─────────────────────────
// us-gaap:CryptoAssetNumberOfUnits is the tagged coin count. Only some filers
// tag it — Strive reports fair value but never a unit count, so its holdings
// history simply does not exist in XBRL and the caller must cope with [].
async function fetchHoldingsHistory(cik) {
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}`
              + '/us-gaap/CryptoAssetNumberOfUnits.json';
    const r = await get(url, { 'User-Agent': SEC_UA });
    if (r.status !== 200) return [];
    const j = JSON.parse(r.body);
    const rows = j.units?.Bitcoin || [];
    // One row per period end, keeping the most recently filed restatement.
    const byEnd = new Map();
    for (const x of rows) {
        const prev = byEnd.get(x.end);
        if (!prev || x.filed > prev.filed) byEnd.set(x.end, x);
    }
    return [...byEnd.values()]
        .sort((a, b) => a.end.localeCompare(b.end))
        .map(x => ({ end: x.end, ts: Date.parse(x.end + 'T00:00:00Z'), btc: x.val, form: x.form }));
}

// ── Shares outstanding (point-in-time, from filing cover pages) ─────────────
// The cover page of every 10-Q/10-K states the exact share count as of a date
// shortly before filing, e.g.:
//
//   "As of July 24, 2026, the registrant had 364,585,501 and 19,640,250 shares
//    of class A common stock and class B common stock outstanding, respectively."
//
// We sum every class. The `asOf` date is the cover date, which is what the
// count is actually true for — it is typically a few weeks AFTER the period
// end, so it is stored alongside (not in place of) the period date.
//
// EDGAR HTML splits words across inline spans, so the flattened text contains
// stray spaces INSIDE words and before punctuation — real examples from these
// filings: "the r egistrant had", "253,763,053 a nd 19,640,250",
// "As of February 4, 2025 ,". A naive regex silently missed 10 of MSTR's 22
// filings, which left a 2023-2024 hole that back-filled a 2022 share count
// (11.5M) into quarters where the true count was ~200M+ — understating those
// historical mNAV points by more than 20x.
//
// Rather than guess at every split, we collapse the text to a canonical form
// first: drop all whitespace, then match. Digit groups keep their commas so
// the numbers stay unambiguous.
// Two cover phrasings are in use across these filers:
//   MSTR: "As of July 24, 2026, the registrant had 364,585,501 and 19,640,250 shares…"
//   ASST: "As of August 1, 2025, there were a total of 1,000,000 shares of the
//          registrant's Class A Common Stock … outstanding, and 15,624,395 shares…"
// The second interleaves prose between the class figures, so it is matched by
// collecting every "<number> shares" run after the "As of" date instead.
const COVER_RE =
    /Asof([A-Z][a-z]+\d{1,2},\d{4}),?(?:the)?registranthad([\d,]+)(?:and([\d,]+))?(?:and([\d,]+))?shares/i;
// Greedy up to the SENTENCE-ending "outstanding." — a lazy match stops at the
// first "outstanding," which sits between Class A and Class B and silently
// dropped whole share classes (ASST 2025-06 read 1,000,000 instead of
// 16,624,395). Capped so a malformed filing cannot run away.
const COVER_ALT_RE = /Asof([A-Z][a-z]+\d{1,2},\d{4}),?therewereatotalof(.{0,800}outstanding\.)/i;
const SHARE_RUN_RE = /([\d,]{5,})shares/gi;

// Collapse to a whitespace-free canonical form. Applied to both the haystack
// and conceptually to the pattern above, so intra-word splits cannot defeat it.
const canon = t => t.replace(/<[^>]+>/g, ' ')
                    .replace(/&nbsp;|&#160;/g, ' ')
                    .replace(/\s+/g, '');

const num = x => parseInt(String(x).replace(/,/g, ''), 10);

async function fetchShares(cik) {
    const subs = await get(`https://data.sec.gov/submissions/CIK${cik}.json`,
                           { 'User-Agent': SEC_UA });
    if (subs.status !== 200) return [];
    const rec = JSON.parse(subs.body)?.filings?.recent;
    if (!rec) return [];

    const out = [];
    for (let i = 0; i < rec.form.length; i++) {
        if (rec.form[i] !== '10-Q' && rec.form[i] !== '10-K') continue;
        const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/`
                  + `${rec.accessionNumber[i].replace(/-/g, '')}/${rec.primaryDocument[i]}`;
        try {
            const r = await get(url, { 'User-Agent': SEC_UA });
            if (r.status !== 200) continue;
            const flat = canon(r.body);
            let coverDate = null, classes = null;

            const m = flat.match(COVER_RE);
            if (m) {
                coverDate = m[1];
                classes = [m[2], m[3], m[4]].filter(Boolean).map(num);
            } else {
                const alt = flat.match(COVER_ALT_RE);
                if (alt) {
                    coverDate = alt[1];
                    classes = [...alt[2].matchAll(SHARE_RUN_RE)].map(x => num(x[1]));
                }
            }
            if (!coverDate || !classes?.length) {
                console.log(`    ! no cover match: ${rec.form[i]} ${rec.reportDate[i]}`);
                continue;
            }
            // Sum every class present. Class B is ~5% of MSTR and ~11% of ASST;
            // dropping it understates market cap and therefore mNAV.
            const shares = classes.reduce((a, b) => a + b, 0);
            if (!Number.isFinite(shares) || shares <= 0) continue;
            out.push({
                end: rec.reportDate[i],
                ts: Date.parse(rec.reportDate[i] + 'T00:00:00Z'),
                shares,
                // Parse as UTC: `new Date("July 24, 2026")` is local midnight,
                // which shifts back a day in any positive-offset zone.
                // coverDate is canonical ("February4,2025"); re-space it to parse.
                asOf: new Date(coverDate.replace(/([A-Za-z])(\d)/, '$1 $2') + ' UTC')
                          .toISOString().slice(0, 10),
                classes,
                form: rec.form[i],
            });
        } catch { /* skip unreadable filing */ }
        await sleep(350); // SEC fair-access
    }

    // One row per period end, keeping the most recently filed restatement.
    const byEnd = new Map();
    for (const x of out) {
        const prev = byEnd.get(x.end);
        if (!prev || x.asOf > prev.asOf) byEnd.set(x.end, x);
    }
    return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
}

// Restate as-reported share counts onto the split-adjusted basis Yahoo prices
// use: a count reported BEFORE a split is multiplied by that split's factor.
// Counts already after the split are left alone. `sharesReported` is kept so
// the raw filing figure remains inspectable.
function adjustSplits(rows, events) {
    if (!events?.length) return rows;
    return rows.map(r => {
        const at = Date.parse(r.asOf + 'T00:00:00Z');
        const factor = events.filter(e => e.ts > at)
                             .reduce((f, e) => f * e.factor, 1);
        return factor === 1 ? r : {
            ...r,
            shares: Math.round(r.shares * factor),
            sharesReported: r.shares,
            splitFactor: factor,
        };
    });
}

console.log('Fetching BTC treasury holdings…');
const holdings = await fetchHoldings();

const out = {};
for (const c of COMPANIES) {
    const hit = holdings.find(h => c.cgMatch.test(h.name)
        || (h.symbol || '').toUpperCase().startsWith(c.ticker + '.'));
    console.log(`\n${c.name} (${c.ticker})`);
    if (hit) {
        console.log(`  ${hit.total_holdings.toLocaleString()} BTC`
            + ` | cost $${(hit.total_entry_value_usd / 1e9).toFixed(2)}B`);
    } else {
        console.log('  ! not found in CoinGecko treasury list');
    }

    await sleep(800);
    let prices = [];
    try {
        prices = await fetchEquity(c.ticker);
        const lastPx = prices[prices.length - 1];
        console.log(`  prices: ${prices.length} days, latest `
            + `${new Date(lastPx.ts).toISOString().slice(0, 10)} = $${lastPx.close}`);
    } catch (e) {
        console.log('  ! price fetch failed:', e.message);
    }

    await sleep(1200);
    const holdingsHistory = await fetchHoldingsHistory(c.cik);
    console.log(`  holdings history: ${holdingsHistory.length} quarters`
        + (holdingsHistory.length
            ? `, ${holdingsHistory[0].end} → ${holdingsHistory[holdingsHistory.length-1].end}`
            : ' (not tagged in XBRL)'));

    await sleep(1200);
    const shares = adjustSplits(await fetchShares(c.cik), splits[c.ticker]);
    const adj = shares.filter(r => r.splitFactor).length;
    if (adj) console.log(`  split-adjusted ${adj} pre-split share rows`
        + ` (${(splits[c.ticker] || []).map(e => new Date(e.ts).toISOString().slice(0, 10)
            + ' x' + e.factor).join(', ')})`);
    const last = shares[shares.length - 1];
    console.log(`  shares: ${shares.length} quarters`
        + (last ? `, latest ${last.end} = ${(last.shares / 1e6).toFixed(1)}M`
                  + ` (cover date ${last.asOf}${last.classes.length > 1
                      ? ', ' + last.classes.length + ' classes summed' : ''})`
                : ' (none)'));

    out[c.key] = {
        ticker: c.ticker,
        name: c.name,
        cik: c.cik,
        btcHoldings: hit ? hit.total_holdings : null,
        btcCostUsd: hit ? hit.total_entry_value_usd : null,
        pctOfSupply: hit ? hit.percentage_of_total_supply : null,
        sharesHistory: shares,
        holdingsHistory,
        prices,
    };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    note: 'BTC holdings from CoinGecko public_treasury; shares outstanding parsed from SEC EDGAR 10-Q/10-K cover pages (point-in-time, all share classes summed — NOT the XBRL weighted average, which is a period average and understates serial issuers); daily prices from Yahoo Finance (fetched server-side — the endpoint sends no CORS headers).',
    companies: out,
}));
console.log(`\nWrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
