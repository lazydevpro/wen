/**
 * Regenerates LADDER_BY_COLUMN in lib/window.ts from the real outcomes of the whole pool.
 *
 *   pnpm calibrate-ladder        # prints the table to paste back
 *
 * Multipliers here are AUTHORED, not derived. MULT_SHAPE fixes the ratios — bet the anchor row
 * and you get your stake back, bet the far edge and it pays big — and this solves the SCALE per
 * column so every column carries the same house edge.
 *
 * Calibrating against the random-walk model is the trap: real paths trend, so they travel
 * further than the model expects, and most so in the opening columns. Priced on the model,
 * columns 0 and 1 measured 123% and 110% against real history — betting only the opening
 * columns beat the house. Priced on the history, every column lands on target.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {GRID_PRICE_BANDS, GRID_TIME_STEPS, HOUSE_EDGE, MAX_MULTIPLIER, MULT_SHAPE, bandDistance} from './lib/window.js';

const DIR = new URL('../data/windows/', import.meta.url).pathname;
const TARGET = (1 - HOUSE_EDGE) * GRID_PRICE_BANDS;

const counts = Array.from({length: GRID_TIME_STEPS}, () => new Array(MULT_SHAPE.length).fill(0));
const columns = new Array(GRID_TIME_STEPS).fill(0);

for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json'))) {
    const w = JSON.parse(readFileSync(DIR + f, 'utf8'));
    w.outcome.forEach((o: any, t: number) => {
        if (t >= GRID_TIME_STEPS) return;
        columns[t]++;
        // a column that left the grid pays nothing and still counts in the denominator
        if (o.p >= 0) counts[t][Math.min(bandDistance(o.p), MULT_SHAPE.length - 1)]++;
    });
}

console.log('='.repeat(72));
console.log(`LADDER CALIBRATION — target ${(TARGET / GRID_PRICE_BANDS * 100).toFixed(0)}% RTP per column`);
console.log('='.repeat(72) + '\n');
console.log('    t' + MULT_SHAPE.map((_, d) => `     d${d}`).join('') + '     RTP');

const table: number[][] = [];
for (let t = 0; t < GRID_TIME_STEPS; t++) {
    const p = counts[t].map((c) => c / columns[t]);
    const inGrid = p.reduce((a, b) => a + b, 0);
    const spread = p.reduce((a, pd, d) => a + pd * (MULT_SHAPE[d] - 1), 0);
    const k = spread > 1e-9 ? Math.max(0, (TARGET - inGrid) / spread) : 1;
    const ladder = MULT_SHAPE.map(
        (sh) => Math.round(Math.min(MAX_MULTIPLIER, Math.max(1, 1 + (sh - 1) * k)) * 100) / 100,
    );
    table.push(ladder);
    const rtp = (p.reduce((a, pd, d) => a + pd * ladder[d], 0) / GRID_PRICE_BANDS) * 100;
    console.log(`    ${t}  ` + ladder.map((v) => v.toFixed(1).padStart(6)).join(' ') + `  ${rtp.toFixed(1).padStart(6)}%`);
}

console.log('\nPaste into lib/window.ts:\n');
console.log('export const LADDER_BY_COLUMN = [');
for (const l of table) console.log(`    [${l.join(', ')}],`);
console.log('];\n');
