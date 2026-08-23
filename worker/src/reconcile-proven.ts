/**
 * Rewrites a window's candles to the prices Attestcoin actually proved.
 *
 *   pnpm reconcile-proven <windowId> [...]
 *   pnpm reconcile-proven --failed          # read ids from /tmp/failed-windows.txt
 *
 * WHY THIS IS NEEDED
 * A candle is folded from every swap in its bucket, and foldBuckets() takes the LAST one —
 * highest block, then highest logIndex — keeping that swap's price and its txHash. ChartVerifier
 * then proves that transaction and takes the FIRST swap matching the pool:
 *
 *     if (swaps[i].address_ != pool) continue;
 *     sqrtPriceX96 = _readSqrtPriceX96(swaps[i].data);
 *     break;
 *
 * When the closing transaction touches the pool more than once — a split route, a multi-hop, an
 * arbitrage — those are different swaps, a few parts per million apart. Measured across the
 * corpus it hits ~0.5% of candles, which is ~12% of 40-candle windows.
 *
 * Both prices are real swaps from the right pool in the right block. Only one of them is
 * attested, so that is the one the game should serve; ChartRegistry now refuses the other. This
 * script adopts the proven price and rebuilds everything downstream of it.
 *
 * No re-proving happens here: the candles are already on-chain. This only makes the local corpus
 * agree with them.
 */
import {readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {Contract} from 'ethers';
import {cfg, DEFAULT_POOL} from './lib/config.js';
import {cc3Provider} from './lib/contracts.js';
import {priceFromSqrtX96} from './lib/uniswap.js';
import {
    GRID_LEAD_STEPS,
    GRID_PRICE_BANDS,
    GRID_TIME_STEPS,
    VISIBLE_FRAC,
    bandOf,
    buildGrid,
    buildMerkle,
    candleLeaf,
    realisedSigma,
} from './lib/window.js';

const DIR = new URL('../data/windows/', import.meta.url).pathname;
const VERIFIER_ABI = ['function provenPrice(address,uint64) view returns (uint160)'];

async function main() {
    let ids = process.argv.slice(2);
    if (ids[0] === '--failed') {
        ids = readFileSync('/tmp/failed-windows.txt', 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    }
    if (!ids.length) {
        ids = readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
    }

    const verifier = new Contract(cfg.chartVerifier!, VERIFIER_ABI, cc3Provider());
    const pool = DEFAULT_POOL;

    console.log('='.repeat(70));
    console.log(`RECONCILE TO PROVEN PRICES — ${ids.length} windows`);
    console.log('='.repeat(70) + '\n');

    let totalChanged = 0;
    for (const id of ids) {
        const path = `${DIR}${id}.json`;
        const w = JSON.parse(readFileSync(path, 'utf8'));

        let changed = 0;
        for (const c of w.candles) {
            const proven: bigint = await verifier.provenPrice(pool.address, c.blockNumber);
            if (proven === 0n) throw new Error(`${id} candle ${c.index} block ${c.blockNumber} was never proven`);
            if (proven === BigInt(c.sqrtPriceX96)) continue;

            c.sqrtPriceX96 = proven.toString();
            c.price = priceFromSqrtX96(proven, pool);
            c.close = c.price;
            // open/high/low come from the whole bucket; keep the close inside the range it claims
            c.high = Math.max(c.high, c.close);
            c.low = Math.min(c.low, c.close);
            changed++;
        }

        if (changed === 0) {
            console.log(`  ${id.padEnd(24)} already agrees`);
            continue;
        }

        // Everything below is derived from candle prices, so it all has to be rebuilt: a changed
        // visible candle moves the anchor and sigma, which moves the grid, which moves the bands
        // the outcome lands in. Mirrors buildWindow() in lib/window.ts.
        const candles = w.candles.map((c: any) => ({...c, sqrtPriceX96: BigInt(c.sqrtPriceX96)}));
        const visibleCount = Math.max(3, Math.floor(candles.length * VISIBLE_FRAC));
        const visible = candles.slice(0, visibleCount);
        const sigma = realisedSigma(visible);
        const anchorPrice = visible[visible.length - 1].close;
        const {grid, bandHeight} = buildGrid(anchorPrice, sigma);
        const {root} = buildMerkle(candles.map(candleLeaf));

        const firstOutcome = visibleCount + GRID_LEAD_STEPS;
        w.visibleCount = visibleCount;
        w.sigma = sigma;
        w.anchorPrice = anchorPrice;
        w.bandHeight = bandHeight;
        w.grid = grid;
        w.merkleRoot = root;
        w.outcome = candles.slice(firstOutcome, firstOutcome + GRID_TIME_STEPS).map((c: any, t: number) => ({
            t,
            p: bandOf(c.close, anchorPrice, bandHeight, GRID_PRICE_BANDS),
        }));

        writeFileSync(path, JSON.stringify(w, null, 2));
        totalChanged += changed;
        console.log(`  ${id.padEnd(24)} ${String(changed).padStart(2)} candle(s) adopted  root -> ${root.slice(0, 18)}…`);
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`candles adopted: ${totalChanged}`);
    console.log('next: pnpm export-public && pnpm register-bulk');
    console.log('='.repeat(70));
}

main().catch((e) => {
    console.error('❌', e.shortMessage ?? e.message ?? e);
    process.exit(1);
});
