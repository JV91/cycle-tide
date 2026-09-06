// ── Cycle Tide — explanations for the treasury-company metrics ──────────────
//
// Same disclosure pattern as the BTC signal breakdown: what it tracks, why it
// matters, how to read it, how it interacts with the OTHER metrics, and the
// caveat. The interaction field matters most here — mNAV, dilution and cost
// basis only mean something in combination, and reading any one alone is how
// people misjudge these companies.

const ASSET_METRIC_INFO = {
    valuationRead: {
        label: 'this read',
        tracks: 'A weighted 0-100 read on whether the company is cheap or expensive RELATIVE TO THE BITCOIN IT HOLDS. Three inputs: valuation vs holdings (mNAV, 55), treasury position vs cost (25), and whether the equity has actually beaten holding Bitcoin (20).',
        why: 'A treasury company has something Bitcoin itself does not: a fair-value anchor. You can price it against the coins on its balance sheet. That makes a valuation call possible here even though the Bitcoin tab deliberately refuses to make a price call — the two are answering different questions.',
        scale: [
            ['70-100', 'cheap vs its Bitcoin', 'good'],
            ['45-70', 'fairly priced', 'warn'],
            ['25-45', 'rich vs its Bitcoin', 'bad'],
            ['0-25', 'expensive vs its Bitcoin', 'bad'],
        ],
        interacts: 'This is emphatically NOT a view on Bitcoin. A company can read cheap here while Bitcoin itself is at a cycle top — the two questions are separate, and you need both. Check the Bitcoin tab for cycle position, then this for whether the wrapper is a sensible way to express it.',
        caveat: 'The thresholds are reasoned judgements about the economics, NOT levels fitted to historical data. Only current BTC holdings are available (no history), so mNAV cannot be percentile-ranked against each company’s own past the way the Bitcoin signals are. It also ignores debt, convertibles, operating businesses and management risk — a leveraged company at 0.8x is not the same bet as an unleveraged one.',
        source: 'Computed from mNAV, CoinGecko cost basis, and performance vs BTC.',
    },

    mnav: {
        label: 'mNAV',
        tracks: 'What the stock market charges you for the Bitcoin the company already owns. 1.0x means the company is valued at exactly its Bitcoin; 0.8x means you buy $1 of BTC exposure for 80 cents; 1.5x means you pay $1.50 for it.',
        why: 'This is the single most important number for a treasury company, because it separates two very different things: how Bitcoin is doing, and how the market is pricing the wrapper around it. A company can be up while its mNAV collapses, or down while its mNAV improves.',
        scale: [
            ['below 1.0x', 'discount — market values the company below its BTC', 'good'],
            ['1.0x to 1.5x', 'modest premium', 'warn'],
            ['above 2.0x', 'steep premium — much to justify', 'bad'],
        ],
        interacts: 'A premium is what lets these companies issue shares and buy more Bitcoin per share — issuing above mNAV 1.0x is accretive. At a discount the mechanism reverses: issuing stock destroys BTC per share, so the flywheel that justifies the whole model stops turning. Read mNAV together with BTC per share to see which regime the company is in.',
        caveat: 'Computed from quarterly SEC share counts, so it lags recent issuance. It also ignores debt, convertibles and any operating business — a leveraged company at 1.0x is not the same risk as an unleveraged one.',
        source: 'Market cap from Yahoo price x SEC diluted shares; BTC value from CoinGecko holdings x live BTC price.',
    },

    btcPerShare: {
        label: 'BTC per share',
        tracks: 'How much Bitcoin one share represents. The cleanest measure of whether management is creating or destroying value for existing holders.',
        why: 'Share count is not fixed — these companies issue stock continuously to buy Bitcoin. Total holdings can grow impressively while BTC per share falls, which means existing shareholders own less Bitcoin than before despite the headline number growing. Rising BTC per share is the only unambiguous evidence the strategy is working for you rather than around you.',
        scale: [
            ['rising over time', 'accretive issuance — holders gain BTC', 'good'],
            ['flat', 'treading water', 'warn'],
            ['falling', 'dilutive — holders lose BTC per share', 'bad'],
        ],
        interacts: 'Directly coupled to mNAV. Issuing shares at a premium raises BTC per share; issuing at a discount lowers it. Compare against total BTC held: if holdings rise while BTC per share falls, the growth came out of your ownership stake rather than out of strategy.',
        caveat: 'Uses quarterly diluted share counts, so recent issuance may not be reflected. Diluted includes convertibles, which is conservative and appropriate — but means the figure can look worse than a basic share count would suggest.',
        source: 'CoinGecko holdings / SEC diluted shares outstanding.',
    },

    costBasis: {
        label: 'cost basis',
        tracks: 'What the company paid for its Bitcoin in total, its average price per coin, and how that compares to today.',
        why: 'It sets the pressure the company is under. A treasury deep in profit has room to absorb a drawdown; one underwater on an average price above spot has creditors, covenants and shareholders asking harder questions — and may be forced to issue equity at bad prices or, in extremis, sell coins.',
        scale: [
            ['spot well above avg cost', 'comfortable buffer', 'good'],
            ['spot near avg cost', 'thin margin', 'warn'],
            ['spot below avg cost', 'underwater — financing pressure', 'bad'],
        ],
        interacts: 'Combines with mNAV to describe the real situation. Underwater AND at a discount is the pressured case: the market doubts the wrapper exactly when the balance sheet is weakest. Underwater but at a premium suggests the market is pricing in something beyond the coins.',
        caveat: 'Average cost is aggregate across all purchases and hides the timing — a company that bought steadily has a very different risk profile from one that bought heavily near a top, even with an identical average.',
        source: 'CoinGecko public_treasury entry values.',
    },

    drawdown: {
        label: 'drawdown',
        tracks: 'How far the share price sits below its highest close since becoming a Bitcoin treasury company.',
        why: 'These equities are leveraged expressions of Bitcoin, so their drawdowns are typically far deeper than BTC’s own. Comparing the two shows how much amplification you are actually taking on.',
        scale: [
            ['0% to -30%', 'normal equity volatility', 'good'],
            ['-30% to -60%', 'significant drawdown', 'warn'],
            ['below -70%', 'severe — check whether the thesis still holds', 'bad'],
        ],
        interacts: 'Compare against Bitcoin’s own drawdown on the Bitcoin tab. If the stock is down far more than BTC, the gap is mNAV compression and dilution rather than Bitcoin itself — a different problem, with a different resolution.',
        caveat: 'Measured only from the treasury pivot onward. For a company that changed business, earlier highs belong to a different entity and are deliberately excluded.',
        source: 'Self-computed from daily closes.',
    },

    perfVsBtc: {
        label: 'performance vs BTC',
        tracks: 'Total return over matched windows, against Bitcoin over the identical period.',
        why: 'The reason to hold one of these rather than Bitcoin itself is the expectation of outperformance. This tests that claim directly. Persistent underperformance means you are carrying equity risk — dilution, leverage, management, regulation — without being paid for it.',
        scale: [
            ['positive difference', 'outperforming BTC', 'good'],
            ['near zero', 'tracking BTC', 'warn'],
            ['negative difference', 'underperforming — equity risk unrewarded', 'bad'],
        ],
        interacts: 'Interpret alongside mNAV. Outperformance driven by an expanding premium can unwind quickly; outperformance driven by rising BTC per share is durable. The indexed chart below shows which pattern is at work.',
        caveat: 'Short windows are noisy and these stocks move violently. Windows longer than the treasury era are omitted rather than reaching back into a predecessor company.',
        source: 'Self-computed from daily closes; BTC from Binance.',
    },

    indexedChart: {
        label: 'this chart',
        tracks: 'Both the stock and Bitcoin rebased to 100 at the start of the window, drawn on one logarithmic axis.',
        why: 'Indexing puts two very different price levels on a common footing, so their shapes are directly comparable. The log scale means equal vertical distances are equal percentage moves — essential when one series can move many times more than the other.',
        scale: [
            ['stock line above BTC', 'outperforming since the start date', 'good'],
            ['lines together', 'tracking', 'warn'],
            ['stock line below BTC', 'underperforming since the start date', 'bad'],
        ],
        interacts: 'The visual counterpart to the performance table. Widening gaps usually reflect mNAV re-rating rather than Bitcoin; watch whether a divergence coincides with share issuance.',
        caveat: 'Everything depends on the start date. It is anchored to the treasury pivot where one applies, so the chart shows the treasury company only — but any single start date still flatters or penalises depending on where it lands.',
        source: 'Self-computed; deliberately one axis, never dual-axis.',
    },
};

// Which explainers are open. Kept outside the render so a re-render (tab
// switch, live price tick) does not slam them shut mid-read.
const expandedMetrics = new Set();

function metricInfoHtml(key) {
    const m = ASSET_METRIC_INFO[key];
    if (!m) return '';
    const isOpen = expandedMetrics.has(key);
    return `
        <div class="metric-explain">
            <button class="metric-toggle" data-metric="${key}" aria-expanded="${isOpen}"
                    aria-controls="minfo-${key}">
                <span class="disclosure" aria-hidden="true">${isOpen ? '▾' : '▸'}</span>
                What ${escapeHtml(m.label)} means
            </button>
            <div class="signal-info" id="minfo-${key}" ${isOpen ? '' : 'hidden'}>
                <div class="info-block">
                    <span class="info-label">What it tracks</span>
                    <p>${escapeHtml(m.tracks)}</p>
                </div>
                <div class="info-block">
                    <span class="info-label">Why it matters</span>
                    <p>${escapeHtml(m.why)}</p>
                </div>
                <div class="info-block">
                    <span class="info-label">How it reads</span>
                    <ul class="info-scale">
                        ${m.scale.map(([r, mean, tone]) => `
                            <li class="tone-${tone}">
                                <span class="scale-range">${escapeHtml(r)}</span>
                                <span class="scale-meaning">${escapeHtml(mean)}</span>
                            </li>`).join('')}
                    </ul>
                </div>
                <div class="info-block info-interacts">
                    <span class="info-label">How it works with the others</span>
                    <p>${escapeHtml(m.interacts)}</p>
                </div>
                <div class="info-block info-caveat">
                    <span class="info-label">Caveat</span>
                    <p>${escapeHtml(m.caveat)}</p>
                </div>
                <div class="info-source">${escapeHtml(m.source)}</div>
            </div>
        </div>`;
}

// Delegated, and bound once — the asset view is re-rendered wholesale on every
// toggle, so per-button listeners would be lost.
function bindMetricToggles() {
    const root = document.getElementById('assetView');
    if (!root || root._metricBound) return;
    root._metricBound = true;
    root.addEventListener('click', e => {
        const btn = e.target.closest('.metric-toggle');
        if (!btn) return;
        const key = btn.dataset.metric;
        if (expandedMetrics.has(key)) expandedMetrics.delete(key);
        else expandedMetrics.add(key);
        renderAssetView(activeTab);
    });
}
