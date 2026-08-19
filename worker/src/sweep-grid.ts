/**
 * Sweeps grid SHAPE — band count and sigma span — with the runway applied.
 *
 *   pnpm sweep-grid
 *
 * sweep-span tuned width alone at a fixed 12 bands. Two new requirements need the wider search:
 *
 *  1. GRID_LEAD_STEPS of runway before the first bettable column, so the path is already moving
 *     when it reaches the cells.
 *  2. Multipliers that START low. Today the likeliest cell pays ~3x, so one lucky cell covers
 *     four wrong ones — hitting anything feels like winning. Lower multipliers force a player to
 *     cover several cells, which costs more and makes a single hit unremarkable.
 *
 * These pull against each other, and the sweep is here to show by how much. Runway SPREADS the
 * first column (more diffusion), which RAISES multipliers; lowering multipliers needs bands wide
 * relative to that spread, i.e. fewer bands or a wider span — and a wider span pushes the outer
 * bands out of reach, which is exactly the bug that produced a 56% house edge the first time.
 *
 * There is also a hard floor worth stating: multiplier = (1 - edge) / probability, so with an 11%
 * edge the lowest multiplier physically possible is 0.89x, and only for a cell that is CERTAIN.
 * A 0.5x cell cannot exist at any honest price.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {GRID_TIME_STEPS, HOUSE_EDGE, MAX_MULTIPLIER, MIN_MULTIPLIER, bandOf} from './lib/window.js';

const DIR = new URL('../data/windows/', import.meta.url).pathname;
const LEAD = Number(process.env.GRID_LEAD_STEPS ?? 2);

/** buildGrid() with shape passed in, and the runway included in the walk. */
function gridFor(sigma: number, span: number, bands: number, sims = 60_000) {
    const total = LEAD + GRID_TIME_STEPS;
    const bandHeight = (span * sigma * Math.sqrt(total)) / bands;
    const hits: number[][] = Array.from({length: GRID_TIME_STEPS}, () => new Array(bands).fill(0));

    for (let s = 0; s < sims; s++) {
        let logP = 0;
        for (let step = 0; step < total; step++) {
            const u1 = Math.random() || 1e-12;
            const u2 = Math.random();
            logP += sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            const t = step - LEAD;                       // runway steps are not bettable
            if (t < 0) continue;
            const b = bandOf(Math.exp(logP), 1, bandHeight, bands);
            if (b >= 0) hits[t][b]++;
        }
    }

    const mult: number[][] = Array.from({length: GRID_TIME_STEPS}, () => new Array(bands).fill(0));
    for (let t = 0; t < GRID_TIME_STEPS; t++) {
        for (let p = 0; p < bands; p++) {
            const prob = hits[t][p] / sims;
            mult[t][p] = prob <= 0
                ? MAX_MULTIPLIER
                : Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, (1 - HOUSE_EDGE) / prob));
        }
    }
    return {bandHeight, mult};
}

function main() {
    const wins = readdirSync(DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(DIR + f, 'utf8')))
        .filter((w: any) => w.candles.length >= w.visibleCount + LEAD + GRID_TIME_STEPS);

    console.log('='.repeat(84));
    console.log(`GRID SHAPE SWEEP — ${wins.length} windows, ${LEAD} steps of runway`);
    console.log('='.repeat(84));
    console.log(`  floor: multiplier cannot go below ${(1 - HOUSE_EDGE).toFixed(2)}x at an ${(HOUSE_EDGE * 100).toFixed(0)}% edge\n`);
    console.log('  bands  span   min@t0   min all    RTP    escaped   dead cells   verdict');
    console.log('  ' + '-'.repeat(78));

    for (const bands of [5, 6, 8, 10, 12]) {
        for (const span of [3.4, 4.5, 5.5, 7.0, 9.0]) {
            let staked = 0;
            let returned = 0;
            let escaped = 0;
            let columns = 0;
            let dead = 0;
            let cells = 0;
            let minT0 = Infinity;
            let minAll = Infinity;

            for (const w of wins) {
                const {bandHeight, mult} = gridFor(w.sigma, span, bands);
                for (let p = 0; p < bands; p++) minT0 = Math.min(minT0, mult[0][p]);
                for (let t = 0; t < GRID_TIME_STEPS; t++) {
                    for (let p = 0; p < bands; p++) {
                        minAll = Math.min(minAll, mult[t][p]);
                        cells++;
                        if (mult[t][p] >= MAX_MULTIPLIER) dead++;
                    }
                }

                const first = w.visibleCount + LEAD;
                const outcome = w.candles.slice(first, first + GRID_TIME_STEPS);
                for (let t = 0; t < outcome.length; t++) {
                    const band = bandOf(outcome[t].close, w.anchorPrice, bandHeight, bands);
                    staked += bands;              // one unit on every band of the column
                    columns++;
                    if (band >= 0) returned += mult[t][band];
                    else escaped++;
                }
            }

            const rtp = (returned / staked) * 100;
            const onTarget = Math.abs(rtp - (1 - HOUSE_EDGE) * 100) < 3;
            const lowStart = minT0 <= 1.6;
            const verdict = rtp > 100 ? 'house loses'
                : lowStart && onTarget ? '<-- both'
                : lowStart ? 'low start'
                : onTarget ? 'edge ok'
                : '';
            console.log(
                `  ${String(bands).padStart(5)}  ${span.toFixed(1).padStart(4)}  ` +
                `${minT0.toFixed(2).padStart(6)}x  ${minAll.toFixed(2).padStart(6)}x  ` +
                `${rtp.toFixed(1).padStart(6)}%  ${((escaped / columns) * 100).toFixed(1).padStart(6)}%  ` +
                `${((dead / cells) * 100).toFixed(1).padStart(9)}%   ${verdict}`,
            );
        }
    }
    console.log('\n' + '='.repeat(84));
    console.log('min@t0 is what a player reads first. Lower = a single hit is unremarkable and');
    console.log('covering several cells is the only way to a real return. Watch dead cells: those');
    console.log('are unwinnable, and paying for them is what caused the original 56% edge.');
    console.log('='.repeat(84) + '\n');
}

main();
