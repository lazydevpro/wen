/**
 * Splits built windows into what the client may see and what it may not.
 *
 *   web/data/w/<windowId>.json      — one playable window: riddle, visible candles, multipliers
 *   worker/data/reveals/<id>.json   — hidden candles + answers, bundled into the Worker
 *
 * Two deliberate changes from the six-window version:
 *
 *  1. There is no windows.json any more. A single index of 120 windows would be a ~1 MB fetch on
 *     page load, and — worse — it handed every player the complete catalogue. The client now
 *     fetches exactly the one window it was dealt, keyed by the windowId from the RoundDealt
 *     event, so it cannot enumerate the pool at all.
 *  2. Reveals are written OUTSIDE web/. They used to sit in the assets directory kept private by
 *     an .assetsignore rule, which is one editing mistake away from publishing every answer.
 *     Files that must never ship are now simply not in the directory that ships.
 *
 * The split is UX, not security: GridGame is the real enforcement, since resolution requires
 * Merkle inclusion proofs against the root committed at registration.
 */
import {readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync} from 'node:fs';
import {keccak256, toUtf8Bytes} from 'ethers';
import {GRID_LEAD_STEPS, GRID_TIME_STEPS, buildMerkle, candleLeaf, merkleProof} from './lib/window.js';

const SRC = new URL('../data/windows/', import.meta.url).pathname;
const PUBLIC_DIR = new URL('../../web/data/w/', import.meta.url).pathname;
const REVEAL_DIR = new URL('../data/reveals/', import.meta.url).pathname;

// Rebuild both from scratch so a renamed or deleted window cannot leave a stale file behind.
rmSync(PUBLIC_DIR, {recursive: true, force: true});
rmSync(REVEAL_DIR, {recursive: true, force: true});
mkdirSync(PUBLIC_DIR, {recursive: true});
mkdirSync(REVEAL_DIR, {recursive: true});

const files = readdirSync(SRC).filter((f) => f.endsWith('.json'));
const manifest: {windowId: string; id: string; label: string}[] = [];

for (const f of files) {
    const w = JSON.parse(readFileSync(SRC + f, 'utf8'));
    const windowId = keccak256(toUtf8Bytes(w.id));
    const visible = w.candles.slice(0, w.visibleCount);
    // runway candles are revealed with the outcome — they are part of the path the player
    // watches, they simply sit before the first bettable column
    const runway = w.candles.slice(w.visibleCount, w.visibleCount + GRID_LEAD_STEPS);
    const firstOutcome = w.visibleCount + GRID_LEAD_STEPS;
    const hidden = w.candles.slice(firstOutcome, firstOutcome + GRID_TIME_STEPS);

    writeFileSync(
        `${PUBLIC_DIR}${windowId}.json`,
        JSON.stringify({
            id: w.id,
            windowId,
            riddle: w.era.riddle,
            poolLabel: w.pool.label,
            anchorPrice: w.anchorPrice,
            bandHeight: w.bandHeight,
            sigma: w.sigma,
            timeSteps: GRID_TIME_STEPS,
            leadSteps: GRID_LEAD_STEPS,
            priceBands: w.grid.reduce((m: number, c: any) => Math.max(m, c.p + 1), 0),
            visible: visible.map((c: any) => ({b: c.blockNumber, o: c.open, h: c.high, l: c.low, c: c.close})),
            grid: w.grid.map((c: any) => ({t: c.t, p: c.p, m: c.multiplier})),
        }),
    );

    // Merkle proofs so the client can resolve the round on-chain itself.
    const candles = w.candles.map((c: any) => ({...c, sqrtPriceX96: BigInt(c.sqrtPriceX96)}));
    const {layers} = buildMerkle(candles.map(candleLeaf));

    writeFileSync(
        `${REVEAL_DIR}${windowId}.json`,
        JSON.stringify({
            id: w.id,
            windowId,
            eraLabel: w.era.label,
            answers: w.era.answers,
            leadSteps: GRID_LEAD_STEPS,
            // drawn before the grid, never bet on, so no proof is needed
            runway: runway.map((c: any) => ({o: c.open, h: c.high, l: c.low, c: c.close})),
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
        }),
    );

    manifest.push({windowId, id: w.id, label: w.era.label});
}

// Not shipped to the client — this is for the Worker's bundler and for humans.
writeFileSync(
    new URL('../data/manifest.json', import.meta.url).pathname,
    JSON.stringify(manifest, null, 2),
);

console.log(`✅ ${manifest.length} windows exported`);
console.log(`   web/data/w/            ${manifest.length} public window files`);
console.log(`   worker/data/reveals/   ${manifest.length} reveals (never served as assets)`);
