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
import {registrationParams} from './lib/registration.js';

const id = process.argv[2];
if (!id) {
    console.error('usage: pnpm export-window <windowId>');
    process.exit(1);
}

const src = new URL(`../data/windows/${id}.json`, import.meta.url).pathname;
const win = JSON.parse(readFileSync(src, 'utf8'));

// Single source of truth. register-bulk.ts sends exactly this payload on-chain, so the fixture
// the Solidity tests assert against and the window the chain actually holds cannot drift apart.
// This script used to rebuild all of it inline — a verbatim second copy of registrationParams(),
// which is the exact duplication lib/registration.ts exists to prevent.
const fixture = {
    _comment:
        'Exported from a real wen window. expectedBands come from the TypeScript bandOf(); ' +
        'the Solidity test must agree or resolution pays the wrong cells.',
    ...registrationParams(win),
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
console.log(`   candles     : ${fixture.blockNumbers.length} (pool ${fixture.pool})`);
console.log(`   grid        : ${fixture.timeSteps}x${fixture.priceBands}, ${fixture.multipliers.length} multipliers`);
console.log(`   hidden      : ${fixture.hidden.length} candles`);
console.log(`   bands (TS)  : ${fixture.hidden.map((h) => h.expectedBand).join(', ')}`);
