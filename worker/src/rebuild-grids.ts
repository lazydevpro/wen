/**
 * Recomputes every window's multiplier grid at the current GRID_SIGMA_SPAN.
 *
 *   pnpm rebuild-grids
 *
 * Recalibrating the grid width does not need any Ethereum data — the candles are already on
 * disk, and only the grid, bandHeight and outcome bands derive from the span. This keeps the
 * ~15 minutes of RPC scanning out of the loop when tuning the edge.
 *
 * The Merkle root is over candles, so it is unchanged, and so is the windowId. What changes is
 * exactly what a player is quoted — which is why anything already registered on-chain must be
 * re-registered rather than left alone.
 */
import {readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {GRID_LEAD_STEPS, GRID_PRICE_BANDS, GRID_SIGMA_SPAN, GRID_TIME_STEPS, bandOf, buildGrid} from './lib/window.js';

const DIR = new URL('../data/windows/', import.meta.url).pathname;
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

console.log('='.repeat(70));
console.log(`REBUILD GRIDS — ${files.length} windows, ${GRID_PRICE_BANDS} bands, span ${GRID_SIGMA_SPAN}, lead ${GRID_LEAD_STEPS}`);
console.log('='.repeat(70) + '\n');

let changed = 0;
for (const f of files) {
    const w = JSON.parse(readFileSync(DIR + f, 'utf8'));
    const before = w.bandHeight;

    const {grid, bandHeight} = buildGrid(w.anchorPrice, w.sigma);
    const first = w.visibleCount + GRID_LEAD_STEPS;   // past the runway
    const hidden = w.candles.slice(first, first + GRID_TIME_STEPS);

    w.grid = grid;
    w.bandHeight = bandHeight;
    w.outcome = hidden.map((c: any, t: number) => ({
        t,
        p: bandOf(c.close, w.anchorPrice, bandHeight, GRID_PRICE_BANDS),
    }));

    writeFileSync(DIR + f, JSON.stringify(w, null, 2));
    if (before !== bandHeight) changed++;
}

console.log(`✅ rebuilt ${files.length} grids (${changed} band heights changed)`);
console.log('   merkle roots and windowIds are untouched — only what the player is quoted\n');
