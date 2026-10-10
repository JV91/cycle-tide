#!/usr/bin/env node
// Build data/btc-history.json — daily BTC closes from before the app's main
// price feed begins.
//
// The live price history comes from Binance, which starts on 2017-08-17. The
// 200-week moving average needs 1,400 days of prices, and ranking it against
// its own last four years needs another 1,460 days of the average itself, so
// on Binance data alone a ranked reading only exists from late 2024 — the date
// browser and the backtest table would lose the signal for 2021 and 2022.
//
// Bitstamp has traded BTC/USD since 2011. This file holds its daily closes up
// to the day before Binance's first bar; the two are joined only for the
// 200-week average, where a few dollars' difference between venues vanishes in
// a 1,400-day mean. Prices this old never change, so this is built once and
// committed rather than fetched on every page load.
//
//   node scripts/build-btc-history.mjs

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'btc-history.json');
const FROM = Date.parse('2011-09-01T00:00:00Z');
const BEFORE = Date.parse('2017-08-17T00:00:00Z');   // Binance BTCUSDT's first daily bar

const rows = [];
let start = Math.floor(FROM / 1000);
for (let i = 0; i < 6; i++) {
    const r = await fetch(`https://www.bitstamp.net/api/v2/ohlc/btcusd/?step=86400&limit=1000&start=${start}`);
    if (!r.ok) throw new Error('Bitstamp HTTP ' + r.status);
    const ohlc = (await r.json())?.data?.ohlc || [];
    if (!ohlc.length) break;
    for (const c of ohlc) {
        const ts = +c.timestamp * 1000, close = +c.close;
        if (ts < BEFORE && close > 0) rows.push([ts, close]);
    }
    const last = +ohlc[ohlc.length - 1].timestamp;
    if (last * 1000 >= BEFORE || ohlc.length < 1000) break;
    start = last + 86400;
}
rows.sort((a, b) => a[0] - b[0]);
if (rows.length < 1500) throw new Error(`only ${rows.length} rows — refusing to write a short history`);

const day = ts => new Date(ts).toISOString().slice(0, 10);
fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    source: 'Bitstamp BTC/USD daily closes (public OHLC API)',
    note: 'Static pre-2017 history, joined to the Binance feed only to compute the 200-week moving average. Rows are [timestamp_ms, close].',
    from: day(rows[0][0]),
    to: day(rows[rows.length - 1][0]),
    series: rows,
}));
console.log(`Wrote ${OUT}: ${rows.length} days, ${day(rows[0][0])} -> ${day(rows[rows.length - 1][0])} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
