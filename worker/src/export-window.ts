/**
 * Exports a built window into a Foundry-readable fixture with integer-scaled fields,
 * plus the band each hidden candle lands in according to the TypeScript implementation.
 *
 * The test cross-checks Solidity's bandOf() against these values. If the two disagree,
 * resolution would pay the wrong cells — so this is the highest-value test in the repo.
 *
 *   pnpm export-window luna-2022
 */
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {parseUnits, keccak256, toUtf8Bytes} from 'ethers';
import {GRID_PRICE_BANDS, GRID_TIME_STEPS, bandOf, buildMerkle, candleLeaf, merkleProof} from './lib/window.js';

const id = process.argv[2];
if (!id) {
    console.error('usage: pnpm export-window <windowId>');
    process.exit(1);
}

const src = new URL(`../data/windows/${id}.json`, import.meta.url).pathname;
const win = JSON.parse(readFileSync(src, 'utf8'));

// rehydrate bigints
const candles = win.candles.map((c: any) => ({...c, sqrtPriceX96: BigInt(c.sqrtPriceX96)}));
const visibleCount: number = win.visibleCount;
const anchor = candles[visibleCount - 1];

// Merkle tree over all candles, so we can emit real inclusion proofs
const leaves = candles.map(candleLeaf);
const {root, layers} = buildMerkle(leaves);
if (root !== win.merkleRoot) throw new Error(`merkle mismatch: rebuilt ${root} vs stored ${win.merkleRoot}`);

// hidden candles that the grid actually covers
const hidden = candles.slice(visibleCount, visibleCount + GRID_TIME_STEPS);

const expectedBands = hidden.map((c: any) =>
    bandOf(c.close, win.anchorPrice, win.bandHeight, GRID_PRICE_BANDS),
);

const fixture = {
    _comment:
        'Exported from a real Hindsight window. expectedBands come from the TypeScript bandOf(); ' +
        'the Solidity test must agree or resolution pays the wrong cells.',
    windowId: keccak256(toUtf8Bytes(win.id)),
    eraLabel: win.era.label,
    riddleHash: keccak256(toUtf8Bytes(win.era.riddle)),
    merkleRoot: root,
    anchorSqrtPriceX96: anchor.sqrtPriceX96.toString(),
    // bandHeight is a fraction of anchor price; scale to 1e18 for on-chain fixed point
    bandHeightScaled: parseUnits(win.bandHeight.toFixed(18), 18).toString(),
    totalCandles: candles.length,
    visibleCount,
    timeSteps: GRID_TIME_STEPS,
    priceBands: GRID_PRICE_BANDS,
    invert: win.pool.invert,
    // multipliers scaled by 1e4, flattened as t * priceBands + p
    multipliers: win.grid.map((c: any) => Math.round(c.multiplier * 1e4)),
    visibleSqrtPrices: candles.slice(0, visibleCount).map((c: any) => c.sqrtPriceX96.toString()),
    hidden: hidden.map((c: any, t: number) => ({
        t,
        index: c.index,
        blockNumber: c.blockNumber,
        sqrtPriceX96: c.sqrtPriceX96.toString(),
        price: c.close,
        expectedBand: expectedBands[t],
        proof: merkleProof(layers, c.index),
    })),
};

const dir = new URL('../../contracts/test/fixtures/', import.meta.url).pathname;
mkdirSync(dir, {recursive: true});
const out = `${dir}window-${id}.json`;
writeFileSync(out, JSON.stringify(fixture, null, 2));

console.log(`✅ exported ${out}`);
console.log(`   window id   : ${fixture.windowId}`);
console.log(`   era         : ${fixture.eraLabel}`);
console.log(`   merkle root : ${fixture.merkleRoot}`);
console.log(`   anchor sqrt : ${fixture.anchorSqrtPriceX96}`);
console.log(`   bandHeight  : ${win.bandHeight} -> ${fixture.bandHeightScaled}`);
console.log(`   grid        : ${fixture.timeSteps}x${fixture.priceBands}, ${fixture.multipliers.length} multipliers`);
console.log(`   hidden      : ${fixture.hidden.length} candles`);
console.log(`   bands (TS)  : ${expectedBands.join(', ')}`);
