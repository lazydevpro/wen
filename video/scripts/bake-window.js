/**
 * Lifts a window out of the worker's generated pool into a TS module the video can import.
 *
 * The video renders offline, so the data has to be baked rather than fetched — but it is lifted
 * verbatim, never retyped. If a number on screen is wrong, it is wrong in the pool too.
 *
 *   node scripts/bake-window.js [windowId]
 */
const fs = require('fs');
const path = require('path');

const id = process.argv[2] ?? 'luna-2022';
const src = path.join(__dirname, '..', '..', 'worker', 'data', 'windows', `${id}.json`);
const dest = path.join(__dirname, '..', 'src', 'data', 'luna.ts');

const d = JSON.parse(fs.readFileSync(src, 'utf8'));

const out = {
    id: d.id,
    era: d.era.label,
    riddle: d.era.riddle,
    pool: d.pool.label,
    poolAddress: d.pool.address,
    firstBlock: d.candles[0].blockNumber,
    firstTxHash: d.candles[0].txHash,
    // close is what the game resolves on; open/high/low are only ever drawn as a line
    closes: d.candles.map((c) => Number(c.close.toFixed(4))),
    visibleCount: d.visibleCount,
    lead: 2, // GRID_LEAD_STEPS — the runway the path travels before the grid starts
    timeSteps: 8,
    bands: 12,
    anchorPrice: Number(d.anchorPrice.toFixed(5)),
    bandHeight: d.bandHeight,
    grid: d.grid.map((c) => ({t: c.t, p: c.p, m: c.multiplier})),
    outcome: d.outcome,
};

const header = `/**
 * The real ${id} window, lifted verbatim from worker/data/windows/${id}.json.
 *
 * Baked in rather than fetched so the video renders offline and identically every time. Every
 * number on screen — the candles, the multipliers, which cells land — is the same data the game
 * serves and the same data proven on-chain. Nothing here was invented for the camera.
 *
 * Regenerate with: node scripts/bake-window.js ${id}
 */
`;

fs.mkdirSync(path.dirname(dest), {recursive: true});
fs.writeFileSync(dest, `${header}export const LUNA = ${JSON.stringify(out, null, 4)} as const;\n`);
console.log(`baked ${id}: ${out.closes.length} candles, ${out.grid.length} cells → ${dest}`);
