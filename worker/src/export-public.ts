/**
 * Splits built windows into what the client may see and what it may not.
 *
 *   web/data/windows.json      — index: era label, riddle, visible candles, grid multipliers
 *   web/data/<id>.reveal.json  — hidden candles, fetched only after bets are committed
 *
 * The split is UX, not security: GridGame is the real enforcement, since resolution requires
 * Merkle inclusion proofs against the root committed at registration. A client that peeks at
 * the reveal file early gains nothing on-chain.
 */
import {readFileSync, readdirSync, writeFileSync, mkdirSync} from 'node:fs';
import {keccak256, toUtf8Bytes} from 'ethers';
import {GRID_TIME_STEPS, buildMerkle, candleLeaf, merkleProof} from './lib/window.js';

const SRC = new URL('../data/windows/', import.meta.url).pathname;
const OUT = new URL('../../web/data/', import.meta.url).pathname;

mkdirSync(OUT, {recursive: true});

const files = readdirSync(SRC).filter((f) => f.endsWith('.json'));
const index: any[] = [];

for (const f of files) {
    const w = JSON.parse(readFileSync(SRC + f, 'utf8'));
    const visible = w.candles.slice(0, w.visibleCount);
    const hidden = w.candles.slice(w.visibleCount, w.visibleCount + GRID_TIME_STEPS);

    index.push({
        id: w.id,
        windowId: keccak256(toUtf8Bytes(w.id)),
        riddle: w.era.riddle,
        poolLabel: w.pool.label,
        anchorPrice: w.anchorPrice,
        bandHeight: w.bandHeight,
        sigma: w.sigma,
        timeSteps: GRID_TIME_STEPS,
        priceBands: w.grid.reduce((m: number, c: any) => Math.max(m, c.p + 1), 0),
        visible: visible.map((c: any) => ({
            b: c.blockNumber,
            o: c.open,
            h: c.high,
            l: c.low,
            c: c.close,
        })),
        grid: w.grid.map((c: any) => ({t: c.t, p: c.p, m: c.multiplier})),
    });

    // Merkle proofs so the client can resolve the round on-chain itself.
    const candles = w.candles.map((c: any) => ({...c, sqrtPriceX96: BigInt(c.sqrtPriceX96)}));
    const {layers} = buildMerkle(candles.map(candleLeaf));

    writeFileSync(
        `${OUT}${w.id}.reveal.json`,
        JSON.stringify(
            {
                id: w.id,
                eraLabel: w.era.label,
                answers: w.era.answers,
                hidden: hidden.map((c: any, t: number) => ({
                    t,
                    index: c.index,
                    b: c.blockNumber,
                    o: c.open,
                    h: c.high,
                    l: c.low,
                    c: c.close,
                    sqrtPriceX96: String(c.sqrtPriceX96),
                    proof: merkleProof(layers, c.index),
                })),
                outcome: w.outcome,
            },
            null,
            2,
        ),
    );
}

writeFileSync(`${OUT}windows.json`, JSON.stringify(index, null, 2));

console.log(`✅ ${index.length} windows exported to web/data/`);
for (const w of index) {
    console.log(`   ${w.id.padEnd(18)} ${w.visible.length} visible candles, ${w.grid.length} cells — "${w.riddle.slice(0, 50)}..."`);
}
