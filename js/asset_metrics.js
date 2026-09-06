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
            ['65-100', 'cheap vs its Bitcoin (requires an actual discount)', 'good'],
            ['45-65', 'fairly priced', 'warn'],
            ['25-45', 'rich vs its Bitcoin', 'bad'],
            ['0-25', 'expensive vs its Bitcoin', 'bad'],
        ],
        interacts: 'This is emphatically NOT a view on Bitcoin. A company can read cheap here while Bitcoin itself is at a cycle top — the two questions are separate, and you need both. Check the Bitcoin tab for cycle position, then this for whether the wrapper is a sensible way to express it.',
        caveat: 'The thresholds are reasoned judgements about the economics, NOT levels fitted to historical data. Only current BTC holdings are available (no history), so mNAV cannot be percentile-ranked against each company’s own past the way the Bitcoin signals are. It also ignores debt, convertibles, operating businesses and management risk — a leveraged company at 0.8x is not the same bet as an unleveraged one.',
        source: 'Computed from mNAV, CoinGecko cost basis, and performance vs BTC.',
    },

    mnavHistory: {
        label: 'this range',
        tracks: 'Every historical mNAV that can be reconstructed from official filings: SEC-tagged Bitcoin holdings at each quarter end, valued at the BTC price that day, against market cap from the share count filed at the time.',
        why: 'It is the only empirical check available on the valuation thresholds. Every other signal in this dashboard is scored against its own history; mNAV could not be, because no holdings series was available. This supplies one — thin, but real and authoritative.',
        scale: [
            ['below the observed low', 'cheaper than anything on record here', 'good'],
            ['inside the range', 'within what has occurred', 'warn'],
            ['above the observed high', 'richer than anything on record here', 'bad'],
        ],
        interacts: 'Use it to sanity-check the valuation read rather than to override it. If today sits near the observed low while the read says ACCUMULATE, the two agree. If they disagree, the minor factors are driving the score and it is worth opening them to see why.',
        caveat: 'Only about six observations exist, annual until 2025, so this is a RANGE not a distribution — a percentile over six points would be noise dressed as precision. It also only covers this company’s own short history: a range that has never included a crisis says nothing about how low mNAV can go. Companies that do not tag holdings in XBRL (Strive among them) cannot be reconstructed at all.',
        source: 'SEC XBRL us-gaap:CryptoAssetNumberOfUnits and WeightedAverageNumberOfDilutedSharesOutstanding, with Binance BTC prices.',
    },

    trendStructure: {
        label: 'trend structure',
        tracks: 'A line fitted through successively lower pivot highs (descending resistance) or higher pivot lows (rising support) over a 120-day window, and whether price has broken through it. Pivots are bars unmatched by any bar within 5 days either side; only those continuing the sequence are kept, discarding ones that break it.',
        why: 'It is the classic chart setup: successive lower highs forming a ceiling, then price punching through. Worth showing because knowing where price sits relative to its recent trend is genuinely useful context. Note that drawing such a line requires CHOOSING which pivots to connect and which to skip — that discretion is where chart patterns get their subjectivity, and different reasonable choices produce different lines.',
        scale: [
            ['broken upward', 'above descending resistance', 'good'],
            ['intact', 'still inside the trend', 'warn'],
            ['broken downward', 'below rising support', 'bad'],
        ],
        interacts: 'Deliberately isolated from everything else. It is not scored, does not feed the cycle score, and should not be read as confirming any signal that is. If it agrees with the cycle score that is coincidence, not corroboration.',
        caveat: 'It failed its own backtest. Over 3,308 daily bars an upside break returned +2.8% at 30 days versus a +4.9% baseline, and +8.1% at 90 days versus +17.0% — negative edge at every horizon. A cruder earlier pivot rule scored worse still (-5.8pp / -17.4pp) and was negative across all 22 parameter sets swept, so better detection did not rescue the edge. The mechanism is that breakouts fire after declines, selecting entries that lag simply holding. Treat it as descriptive geometry, not a trade signal.',
        source: 'Self-computed from Binance daily highs/lows.',
    },

    holdings: {
        label: 'the treasury',
        tracks: 'How much Bitcoin the company owns outright, what share of all Bitcoin that represents, what it paid, and what it is worth now.',
        why: 'This is the asset the whole thesis rests on. Scale matters in both directions: Strategy holds over 4% of all Bitcoin that will ever exist, which makes it a systemically significant holder — and means any forced selling would move the market against itself. A small holder has more room to manoeuvre but less of a moat.',
        scale: [
            ['large and in profit', 'strong position, room to absorb drawdowns', 'good'],
            ['large but near cost', 'scale without cushion', 'warn'],
            ['underwater', 'financing pressure regardless of size', 'bad'],
        ],
        interacts: 'Holdings alone can mislead. Compare against BTC per share: a company can grow its stack impressively while each share represents less Bitcoin than before, because the growth was funded by issuing stock. Total holdings is the company’s story; BTC per share is yours.',
        caveat: 'A point-in-time figure from CoinGecko, refreshed when the snapshot script runs — recent purchases may not appear. It also says nothing about how the coins were financed: debt-funded and equity-funded stacks of identical size carry very different risk.',
        source: 'CoinGecko public_treasury.',
    },

    priceAndAth: {
        label: 'these figures',
        tracks: 'Current share price with its daily move, the highest close reached during the treasury era, and how long ago that peak was.',
        why: 'Days since the all-time high is the quietly useful one — it distinguishes a stock consolidating after a recent peak from one that has been grinding down for years. Combined with drawdown depth, it sketches whether the market is digesting or abandoning the thesis.',
        scale: [
            ['near highs, recent ATH', 'momentum intact', 'good'],
            ['deep drawdown, distant ATH', 'prolonged de-rating', 'bad'],
        ],
        interacts: 'Read against Bitcoin’s own drawdown on the Bitcoin tab. If the stock is far below its high while Bitcoin is not, the difference is mNAV compression and dilution rather than Bitcoin — which the valuation read then prices.',
        caveat: 'For a company that changed business, only the treasury era counts. Strive’s pre-merger highs belong to Asset Entities and are excluded, so this ATH is lower than a naive chart would show.',
        source: 'Self-computed from daily closes.',
    },

    // ── The three factors inside the valuation read ───────────────────────
    factorMnav: {
        label: 'this factor',
        tracks: 'mNAV scored against the 1.0x anchor. 0.7x or below scores 100; 1.0x scores 70; 1.5x scores 25; 2.0x or above scores 0.',
        why: 'It carries 55 of the 100 points because it is the only factor with a genuine fair-value reference. The other two adjust that read; they do not replace it. If mNAV is unavailable the whole read shows NO CALL rather than scoring on the minor factors alone.',
        scale: [
            ['0.7x or below', 'deep discount to holdings', 'good'],
            ['around 1.0x', 'priced at its Bitcoin', 'warn'],
            ['1.5x', 'substantial premium', 'bad'],
            ['2.0x or above', 'steep premium', 'bad'],
        ],
        interacts: 'Sets the direction the other two factors then modify — but below 1.0x it progressively OVERRIDES them. A price crash drags all three factors down at once, yet an underwater treasury and recent underperformance are largely consequences of that same fall, so counting them fully would punish one event three times. Below 1.0x the other two are pulled toward neutral; by 0.4x the discount speaks almost alone. A discount below 0.95x is also REQUIRED before the read can say "cheap" at all, so strong minor factors can never call something cheap while you pay more than the coins are worth. Note the asymmetry too: a discount is good for a buyer today, but bad for the company’s ability to issue shares accretively.',
        caveat: 'The thresholds are reasoned judgements about the economics, not levels fitted to data. No historical holdings series exists, so mNAV cannot be percentile-ranked against this company’s own past. A very deep discount may also be the market pricing in something the coins do not capture — debt, dilution plans, or doubt the company survives to realise them.',
        source: 'Market cap / (BTC held x BTC price).',
    },

    factorTreasury: {
        label: 'this factor',
        tracks: 'Unrealised profit or loss on the Bitcoin stack, scored from -40% (0 points) through breakeven (50) to +100% (100 points).',
        why: 'It is a solvency and pressure gauge, worth 25 points. A treasury deep in profit can absorb a drawdown; one underwater faces harder conversations with creditors and may be forced to issue equity at bad prices or sell coins — exactly when doing so is most damaging.',
        scale: [
            ['+100% or more', 'large buffer', 'good'],
            ['around breakeven', 'no cushion', 'warn'],
            ['-40% or worse', 'severe pressure', 'bad'],
        ],
        interacts: 'Most informative combined with mNAV, and deliberately DAMPED whenever mNAV falls below 1.0x. Being underwater is largely a consequence of the price fall that created the discount, so at a deep discount this factor is pulled toward neutral rather than compounding the same bad news. At or above 1.0x it counts in full: underwater at a premium means the market is pricing something other than the coins.',
        caveat: 'Aggregate average cost hides purchase timing, and this ignores debt entirely — a company underwater with no leverage is in a very different position from one underwater with convertibles maturing.',
        source: 'CoinGecko entry value vs current value.',
    },

    factorRelPerf: {
        label: 'this factor',
        tracks: 'Total return versus simply holding Bitcoin over the same 3-month window, scored from -50% (0 points) through parity (50) to +50% (100).',
        why: 'Worth 20 points, it is the reality check on the other two. The entire reason to own one of these instead of Bitcoin is expected outperformance; if the equity persistently lags, the extra risks — dilution, leverage, management, regulation — are not being paid for, no matter how cheap the wrapper looks.',
        scale: [
            ['+50% or more vs BTC', 'strongly outperforming', 'good'],
            ['near parity', 'tracking Bitcoin', 'warn'],
            ['-50% or worse vs BTC', 'badly lagging', 'bad'],
        ],
        interacts: 'A fixed 3-month window is used for both companies so the factor stays comparable across tabs — Strive’s treasury era is too short for a year. Like the treasury factor it is damped below 1.0x mNAV, since recent underperformance is largely what produced the discount. Outperformance driven by an expanding premium can unwind; outperformance driven by rising BTC per share is durable.',
        caveat: 'Three months is short and these stocks are volatile, so this factor is noisy. It is weighted lowest for that reason.',
        source: 'Self-computed from daily closes vs Binance BTC.',
    },

    backingPerShare: {
        label: 'this projection',
        tracks: 'Two independent estimates of where the shares could go. The BACKING columns are arithmetic: BTC held x BTC price / shares, under the Bitcoin scenarios set on the Bitcoin tab and a dilution rate you control. The BETA column is empirical: how much this stock has actually amplified Bitcoin moves during its treasury era.',
        why: 'A direct share-price forecast would need three guesses stacked on the Bitcoin band — future mNAV, dilution and holdings — and mNAV alone swings the answer about 2.9x. Splitting it apart keeps the knowable part (the arithmetic) separate from the unknowable part (what multiple the market grants), instead of hiding both inside one confident-looking line.',
        scale: [
            ['backing per share', 'intrinsic floor — what the coins are worth', 'good'],
            ['after dilution', 'the same, spread over more shares', 'warn'],
            ['beta-implied', 'observed amplification, contains past mNAV swings', 'warn'],
        ],
        interacts: 'The gap between the backing columns and the beta column is informative: beta embeds historical dilution and premium changes, the arithmetic embeds neither. If beta-implied sits far above backing, the market has historically paid a premium that may not persist. Read alongside mNAV to see what premium is being paid today.',
        caveat: 'Neither estimate is a forecast. Dilution dominates: MSTR has issued shares at roughly 40%/yr, and at that rate a near-3x rise in Bitcoin barely moves the backing per share. Beta is measured over a short and unusual window (Strive’s is only ~250 days at correlation 0.55), assumes the relationship holds, and ignores that these companies can change strategy, raise debt or be forced to sell.',
        source: 'Backing from CoinGecko holdings and SEC share counts; beta from daily log returns vs Binance BTC.',
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
