/**
 * Generates the full window pool.
 *
 *   pnpm bulk-windows            # every era, every slice
 *   pnpm bulk-windows 3          # cap at 3 slices per era (quick run)
 *
 * Six windows made the game harvestable: settle six minimum rounds and every future hand is
 * known. This slices each era in lib/eras.ts into several NON-OVERLAPPING windows, so no two
 * share a candle and learning one teaches you nothing about the next.
 *
 * The bottleneck is Alchemy's free tier, which caps eth_getLogs at a 10-block range — one
 * request per candle, unbatchable. Concurrency is the only lever, so buckets are probed in
 * parallel (see sampleStratifiedConcurrent).
 */
import {JsonRpcProvider} from 'ethers';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {cfg, DEFAULT_POOL} from './lib/config.js';
import {ERAS, sliceMeta, type EraSpec} from './lib/eras.js';
import {blockForDate, mapLimit} from './lib/blocks.js';
import {sampleStratifiedConcurrent} from './lib/uniswap.js';
import {buildWindow, GRID_TIME_STEPS} from './lib/window.js';

const OUT_DIR = new URL('../data/windows/', import.meta.url).pathname;

/** ~10 days at 12s blocks — enough chart for an era to be recognisable. */
const WINDOW_BLOCKS = 72_000;
const CANDLES = 40;
/**
 * Concurrent getLogs. A burst of 40 benchmarks beautifully and is a trap: the free tier allows
 * a spike, then throttles by queuing, and a long run degrades to minutes per window. 8 sustains.
 */
const CONCURRENCY = 8;

async function main() {
    const maxSlices = Number(process.argv[2] ?? 8);
    const eth = new JsonRpcProvider(cfg.ethRpc, undefined, {batchMaxCount: 1, staticNetwork: true});
    const head = await eth.getBlockNumber();

    console.log('='.repeat(72));
    console.log('BULK WINDOW GENERATION');
    console.log('='.repeat(72));
    console.log(`  eras       : ${ERAS.length}`);
    console.log(`  head block : ${head.toLocaleString()}`);
    console.log(`  window     : ${WINDOW_BLOCKS.toLocaleString()} blocks (~10 days), ${CANDLES} candles`);
    console.log(`  max slices : ${maxSlices} per era\n`);

    process.stdout.write('  resolving era dates to blocks ');
    const resolved = await mapLimit(ERAS, 6, async (era) => {
        const startBlock = await blockForDate(eth, era.date, head);
        process.stdout.write('.');
        return {...era, startBlock};
    });
    resolved.sort((a, b) => a.startBlock - b.startBlock);
    console.log(' done\n');

    // Each era's band stops where the next era begins, so slices can never overlap.
    type Slice = {era: EraSpec; index: number; startBlock: number};
    const slices: Slice[] = [];
    for (let i = 0; i < resolved.length; i++) {
        const era = resolved[i];
        const nextStart = resolved[i + 1]?.startBlock ?? head;
        const room = Math.floor((nextStart - era.startBlock) / WINDOW_BLOCKS);
        const n = Math.max(0, Math.min(maxSlices, room));
        for (let s = 0; s < n; s++) {
            slices.push({era, index: s, startBlock: era.startBlock + s * WINDOW_BLOCKS});
        }
        console.log(`  ${era.id.padEnd(20)} block ${era.startBlock.toLocaleString().padStart(11)}  ${n} slice(s)`);
    }

    console.log(`\n  total slices to build: ${slices.length}\n`);
    mkdirSync(OUT_DIR, {recursive: true});

    const t0 = Date.now();
    let built = 0;
    let skipped = 0;
    let resumed = 0;

    // Windows are built one at a time; the parallelism that matters is inside each one.
    for (const slice of slices) {
        const id = `${slice.era.id}-s${slice.index}`;

        // Resumable. The free RPC tier stalls unpredictably under sustained load, so a long run
        // will be interrupted — re-running must not throw away what already succeeded.
        if (existsSync(`${OUT_DIR}${id}.json`)) {
            resumed++;
            continue;
        }

        try {
            const buckets = await sampleStratifiedConcurrent(
                eth, DEFAULT_POOL, slice.startBlock, WINDOW_BLOCKS, CANDLES, CONCURRENCY,
            );
            const when = new Date(((await eth.getBlock(slice.startBlock))?.timestamp ?? 0) * 1000);
            const meta = sliceMeta(slice.era, id, when);
            const era: EraSpec = {...slice.era, startBlock: slice.startBlock,
                                  label: meta.label, riddle: meta.riddle, answers: meta.answers};

            const win = buildWindow(id, era, DEFAULT_POOL, buckets);
            const inGrid = win.outcome.filter((o) => o.p >= 0).length;

            writeFileSync(
                `${OUT_DIR}${id}.json`,
                JSON.stringify(win, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
            );
            built++;
            console.log(
                `  ✅ ${id.padEnd(24)} ${String(win.candles.length).padStart(3)} candles  ` +
                `$${win.anchorPrice.toFixed(0).padStart(5)}  σ ${(win.sigma * 100).toFixed(2)}%  ` +
                `${inGrid}/${GRID_TIME_STEPS} in grid  ${meta.label}`,
            );
        } catch (e: any) {
            skipped++;
            console.log(`  ⏭  ${id.padEnd(24)} ${(e.message ?? e).toString().slice(0, 60)}`);
        }
    }

    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`\n${'='.repeat(72)}`);
    console.log(`✅ built ${built} new, ${resumed} already present, ${skipped} skipped, in ${secs}s`);
    console.log(`   written to worker/data/windows/`);
    console.log('='.repeat(72) + '\n');
}

main().catch((e) => {
    console.error('❌', e.message ?? e);
    process.exit(1);
});
