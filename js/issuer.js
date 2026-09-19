// ── Cycle Tide — issuer-published live figures ──────────────────────────────
//
// Strategy publishes the data behind its own charts at api.strategy.com, with
// `Access-Control-Allow-Origin: *`, so the browser can read it directly — no
// snapshot, no daily job, no stale share count. Two endpoints:
//
//   /btc/bitcoinKpis   mNav, satsPerShare, netSatsPerShare, btcHoldings,
//                      btcNav, netBtcReserve, totalReserve, live BTC price
//   /btc/mstrKpiData   MSTR price, market cap, enterprise value, debt, pref
//
// This matters because every figure we previously derived was a reconstruction
// that drifted: quarterly SEC share counts went stale between filings (9.4%
// low by Sept), and the mNAV definition did not match the one the company
// publishes. Reading the issuer's own numbers removes both problems for MSTR.
//
// WHICH mNAV. Strategy's published 1.21x is NOT market cap over gross BTC
// value. Solving against a single consistent snapshot:
//
//     mNav (1.2118) === price / netBtcPerShareUsd (127.3951)
//
// i.e. the share price over the BTC backing per share AFTER senior claims —
// debt and preferred are subtracted from the reserve first. Gross equity mNAV
// on the same snapshot is 0.94x. Both are legitimate and they answer different
// questions, so the dashboard shows both rather than silently picking one:
//
//     0.94x  what you pay per dollar of Bitcoin the company holds
//     1.21x  what you pay per dollar of Bitcoin that is actually yours
//
// The second is the more honest number for a buyer, which is presumably why
// the company leads with it.
//
// Only MSTR is covered — the endpoints serve the MSTR family (STRK/STRF/STRD/
// STRC) and benchmarks, not ASST — so Strive keeps the filing-derived figures.

const ISSUER_API = 'https://api.strategy.com/btc';

// Live figures are refetched on the normal refresh cycle; a failure is not
// fatal, it just falls back to the filing-derived path.
const ISSUER = {};

function issuerNum(v) {
    if (typeof v === 'number') return v;
    if (typeof v !== 'string') return null;
    const n = parseFloat(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
}

async function fetchIssuerFigures() {
    try {
        const [kpis, mstr] = await Promise.all([
            fetch(`${ISSUER_API}/bitcoinKpis`).then(r => r.ok ? r.json() : null),
            fetch(`${ISSUER_API}/mstrKpiData`).then(r => r.ok ? r.json() : null),
        ]);
        const b = kpis?.results;
        const m = mstr && Object.values(mstr).find(x => x?.company === 'MSTR');
        if (!b || !m) return null;

        const price = issuerNum(m.ufPrice);
        const marketCap = issuerNum(m.marketCap) * 1e6;   // reported in millions
        const entVal = issuerNum(m.entVal) * 1e6;
        const debt = issuerNum(m.debt) * 1e6;
        const pref = issuerNum(m.pref) * 1e6;
        const btcHoldings = issuerNum(b.btcHoldings);
        const btcPrice = issuerNum(b.ufPrice);
        if (!price || !marketCap || !btcHoldings || !btcPrice) return null;

        // Share count implied by the company's own market cap. This is shares
        // OUTSTANDING as of today — not the `fdso` field, which assumes
        // conversion of notes, preferred and unvested awards and runs ~2%
        // higher than this.
        const shares = marketCap / price;

        ISSUER.MSTR = {
            asOf: m.timeStampUtc || null,          // equity mark (prior close)
            btcAsOf: b.msTimestamp ? new Date(b.msTimestamp).toISOString() : null,
            price, marketCap, entVal, debt, pref, shares,
            btcHoldings, btcPrice,
            btcNav: issuerNum(b.btcNavNumber) * 1e6,
            netBtcReserve: issuerNum(b.netBtcReserve),
            totalReserve: issuerNum(b.totalReserve),
            satsPerShare: issuerNum(b.satsPerShare),
            netSatsPerShare: issuerNum(b.netSatsPerShare),
            btcPerShareUsd: issuerNum(b.btcPerShareUsd),
            netBtcPerShareUsd: issuerNum(b.netBtcPerShareUsd),
            mnavPublished: issuerNum(b.mNav),
            mnavGross: marketCap / (btcHoldings * btcPrice),
            amplification: issuerNum(b.amplification),
        };
        return ISSUER.MSTR;
    } catch {
        return null;   // offline, blocked, or shape changed — use filings
    }
}
