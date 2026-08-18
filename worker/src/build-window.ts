/**
 * Builds a playable wen window from real Ethereum history.
 *
 *   pnpm build-window <eraId> [totalCandles]
 *   pnpm build-window luna-2022 40
 *   pnpm build-window all
 *
 * Scans Uniswap V3 swaps for the era, folds them into OHLC candles, computes the
 * grid multipliers from VISIBLE candles only, commits a Merkle root, and writes the
 * window to worker/data/windows/.
 */
import {JsonRpcProvider} from 'ethers';
import {mkdirSync, writeFileSync} from 'node:fs';
import {cfg, DEFAULT_POOL, ERAS} from './lib/config.js';
import {sampleStratified} from './lib/uniswap.js';
import {buildWindow, gridEdgeStats, GRID_PRICE_BANDS, GRID_TIME_STEPS, HOUSE_EDGE} from './lib/window.js';

const OUT_DIR = new URL('../data/windows/', import.meta.url).pathname;

async function buildOne(eth: JsonRpcProvider, eraId: string, totalCandles: number) {
    const era = ERAS.find((e) => e.id === eraId);
    if (!era) throw new Error(`unknown era "${eraId}". known: ${ERAS.map((e) => e.id).join(', ')}`);

    const pool = DEFAULT_POOL;
    console.log(`\n${'='.repeat(70)}`);
    console.log(`▶ ${era.label}`);
    console.log(`  era id     : ${era.id}`);
    console.log(`  pool       : ${pool.label}`);
    console.log(`  from block : ${era.startBlock.toLocaleString()}`);

    // Span ~10 days so the chart shows the era's actual price action, not 30 minutes of noise.
    const SPAN_BLOCKS = 72_000; // ~10 days at 12s blocks
    console.log(`  span       : ${SPAN_BLOCKS.toLocaleString()} blocks (~${(SPAN_BLOCKS * 12 / 86400).toFixed(0)} days)`);
    process.stdout.write(`  sampling   : `);
    const buckets = await sampleStratified(eth, pool, era.startBlock, SPAN_BLOCKS, totalCandles, (done, total, swaps) => {
        if (done % 5 === 0 || done === total) process.stdout.write(`${done}/${total} `);
    });
    const swapCount = buckets.reduce((a, b) => a + b.swaps.length, 0);
    console.log(`\n  buckets    : ${buckets.length}/${totalCandles} populated, ${swapCount} swaps total`);

    const win = buildWindow(`${era.id}`, era, pool, buckets);

    const prices = win.candles.map((c) => c.close);
    const lo = Math.min(...prices);
    const hi = Math.max(...prices);
    const drift = ((win.candles[win.candles.length - 1].close / win.candles[0].close - 1) * 100).toFixed(1);

    console.log(`  candles    : ${win.candles.length} (${win.visibleCount} visible / ${win.candles.length - win.visibleCount} hidden)`);
    console.log(`  blocks     : ${win.candles[0].blockNumber.toLocaleString()} .. ${win.candles[win.candles.length - 1].blockNumber.toLocaleString()}`);
    console.log(`  price range: $${lo.toFixed(2)} .. $${hi.toFixed(2)}  (net ${drift}%)`);
    console.log(`  anchor     : $${win.anchorPrice.toFixed(2)}`);
    console.log(`  sigma/step : ${(win.sigma * 100).toFixed(3)}%   (from visible only)`);
    console.log(`  band height: ${(win.bandHeight * 100).toFixed(3)}%`);
    console.log(`  merkle root: ${win.merkleRoot}`);
    console.log(`  grid       : ${GRID_TIME_STEPS} x ${GRID_PRICE_BANDS} = ${win.grid.length} cells`);

    const mults = win.grid.map((c) => c.multiplier);
    console.log(`  multipliers: ${Math.min(...mults).toFixed(2)}x .. ${Math.max(...mults).toFixed(2)}x`);
    const st = gridEdgeStats(win.grid);
    console.log(`  edge check : unclamped cells EV ${(st.evUnclamped * 100).toFixed(2)}%  (target ${((1 - HOUSE_EDGE) * 100).toFixed(1)}%)`);
    console.log(`               ${st.clampedCells} clamped at ${'250'}x, ${st.deadCells} dead tail cells of ${st.cells}`);

    const inGrid = win.outcome.filter((o) => o.p >= 0).length;
    console.log(`  outcome    : ${inGrid}/${win.outcome.length} steps land inside the grid`);
    console.log(`  riddle     : "${era.riddle}"`);

    mkdirSync(OUT_DIR, {recursive: true});
    const path = `${OUT_DIR}${win.id}.json`;
    writeFileSync(
        path,
        JSON.stringify(win, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    );
    console.log(`  ✅ written : data/windows/${win.id}.json`);
    return win;
}

async function main() {
    const [eraArg, candlesArg] = process.argv.slice(2);
    if (!eraArg) {
        console.log('usage: pnpm build-window <eraId|all> [totalCandles]');
        console.log('eras :', ERAS.map((e) => e.id).join(', '));
        process.exit(1);
    }
    const totalCandles = Number(candlesArg ?? 40);
    const eth = new JsonRpcProvider(cfg.ethRpc);

    const ids = eraArg === 'all' ? ERAS.map((e) => e.id) : [eraArg];
    const built = [];
    for (const id of ids) {
        try {
            built.push(await buildOne(eth, id, totalCandles));
        } catch (e: any) {
            console.error(`  ❌ ${id}: ${e.message ?? e}`);
        }
    }

    console.log(`\n${'='.repeat(70)}`);
    console.log(`✅ built ${built.length}/${ids.length} windows`);
    console.log('='.repeat(70) + '\n');
}

main().catch((e) => {
    console.error('❌', e.message ?? e);
    process.exit(1);
});
