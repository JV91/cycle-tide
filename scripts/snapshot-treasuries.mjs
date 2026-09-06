#!/usr/bin/env node
// Build data/treasuries.json — BTC treasury company reference data.
//
//   • BTC holdings + cost basis  — CoinGecko public_treasury (free, no key)
//   • Diluted shares outstanding — SEC EDGAR XBRL companyconcept (free, official)
//
// Shares outstanding is quarterly (10-Q/10-K), which is the correct cadence:
// these companies issue stock frequently to buy BTC, and mNAV computed against
// a stale share count is actively misleading. Quarterly-but-true beats
// daily-but-guessed.
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

// ── Equity daily prices ─────────────────────────────────────────────────────
// Yahoo's chart endpoint sends no CORS headers, so a browser cannot call it.
// Fetching here (server-side, where CORS does not apply) and committing the
// result is the same pattern used for the on-chain and ETF snapshots.
async function fetchEquity(symbol) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`
              + '?interval=1d&range=5y';
    const r = await get(url);
    if (r.status !== 200) throw new Error(`${symbol} HTTP ${r.status}`);
    const res = JSON.parse(r.body)?.chart?.result?.[0];
    if (!res?.timestamp) throw new Error(`${symbol}: no chart data`);
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

// ── Diluted shares outstanding (quarterly) ──────────────────────────────────
async function fetchShares(cik) {
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}`
              + '/us-gaap/WeightedAverageNumberOfDilutedSharesOutstanding.json';
    const r = await get(url, { 'User-Agent': SEC_UA });
    if (r.status !== 200) return [];
    const j = JSON.parse(r.body);
    const rows = (j.units?.shares || []).filter(x => x.form === '10-Q' || x.form === '10-K');
    // One row per period end; keep the most recently filed restatement.
    const byEnd = new Map();
    for (const x of rows) {
        const prev = byEnd.get(x.end);
        if (!prev || x.filed > prev.filed) byEnd.set(x.end, x);
    }
    return [...byEnd.values()]
        .sort((a, b) => a.end.localeCompare(b.end))
        .map(x => ({ end: x.end, ts: Date.parse(x.end + 'T00:00:00Z'), shares: x.val, form: x.form }));
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
    const shares = await fetchShares(c.cik);
    const last = shares[shares.length - 1];
    console.log(`  shares: ${shares.length} quarters`
        + (last ? `, latest ${last.end} = ${(last.shares / 1e6).toFixed(1)}M` : ' (none)'));

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
    note: 'BTC holdings from CoinGecko public_treasury; diluted shares outstanding from SEC EDGAR XBRL (quarterly 10-Q/10-K); daily prices from Yahoo Finance (fetched server-side — the endpoint sends no CORS headers).',
    companies: out,
}));
console.log(`\nWrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
