/**
 * Re-calibrates GRID_SIGMA_SPAN against the whole window pool.
 *
 *   pnpm sweep-span
 *
 * The 2.55 previously in lib/window.ts was fitted against SIX windows and did not generalise:
 * measured over 120 it returns 87% to a uniform bettor, a 13% house edge rather than the
 * intended 3.7%. Six real price paths were not enough to pin a distribution — the first
 * calibration corrected an obvious 56% edge and stopped, which felt like enough and was not.
 *
 * This recomputes each window's grid at candidate widths and replays the REAL outcome against
 * it. Pure arithmetic over candles already on disk: no RPC, no chain, nothing to re-fetch.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {GRID_PRICE_BANDS, GRID_TIME_STEPS, HOUSE_EDGE, MAX_MULTIPLIER, MIN_MULTIPLIER, bandOf} from './lib/window.js';

const DIR = new URL('../data/windows/', import.meta.url).pathname;

/** buildGrid(), but with the span passed in rather than read from the module constant. */
function gridFor(sigma: number, span: number, sims = 80_000) {
    const horizonSigma = sigma * Math.sqrt(GRID_TIME_STEPS);
    const bandHeight = (span * horizonSigma) / GRID_PRICE_BANDS;
    const hits: number[][] = Array.from({length: GRID_TIME_STEPS}, () => new Array(GRID_PRICE_BANDS).fill(0));

    for (let s = 0; s < sims; s++) {
        let logP = 0;
        for (let t = 0; t < GRID_TIME_STEPS; t++) {
            const u1 = Math.random() || 1e-12;
            const u2 = Math.random();
            logP += sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            const b = bandOf(Math.exp(logP), 1, bandHeight, GRID_PRICE_BANDS);
            if (b >= 0) hits[t][b]++;
        }
    }

    const mult: number[][] = Array.from({length: GRID_TIME_STEPS}, () => new Array(GRID_PRICE_BANDS).fill(0));
    for (let t = 0; t < GRID_TIME_STEPS; t++) {
        for (let p = 0; p < GRID_PRICE_BANDS; p++) {
            const prob = hits[t][p] / sims;
            mult[t][p] = prob <= 0 ? MAX_MULTIPLIER : Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, (1 - HOUSE_EDGE) / prob));
        }
    }
    return {bandHeight, mult};
}

function main() {
    const wins = readdirSync(DIR)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(readFileSync(DIR + f, 'utf8')));

    console.log('='.repeat(74));
    console.log(`GRID WIDTH SWEEP — ${wins.length} windows, replayed against real outcomes`);
    console.log('='.repeat(74));
    console.log('  target RTP 96.3%  (house edge 3.7%)\n');
    console.log('   span    RTP     edge    clamped hits   verdict');
    console.log('   ' + '-'.repeat(60));

    for (const span of [2.55, 3.0, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7]) {
        let staked = 0;
        let returned = 0;
        let clampedHits = 0;

        for (const w of wins) {
            const {bandHeight, mult} = gridFor(w.sigma, span);
            const hidden = w.candles.slice(w.visibleCount, w.visibleCount + GRID_TIME_STEPS);
            for (let t = 0; t < hidden.length; t++) {
                const band = bandOf(hidden[t].close, w.anchorPrice, bandHeight, GRID_PRICE_BANDS);
                // a uniform bettor puts one unit on every band of this column
                staked += GRID_PRICE_BANDS;
                if (band >= 0) {
                    returned += mult[t][band];
                    if (mult[t][band] >= MAX_MULTIPLIER) clampedHits++;
                }
            }
        }

        const rtp = (returned / staked) * 100;
        const edge = 100 - rtp;
        const good = Math.abs(rtp - 96.3) < 2.5;
        const verdict = rtp > 100 ? '❌ house loses' : good ? '✅ on target' : rtp < 90 ? '⚠️  too harsh' : '~ close';
        console.log(
            `   ${span.toFixed(2).padStart(4)}  ${rtp.toFixed(1).padStart(6)}%  ${edge.toFixed(1).padStart(6)}%  ` +
            `${String(clampedHits).padStart(9)}      ${verdict}`,
        );
    }

    console.log('\n' + '='.repeat(74));
    console.log('Pick the narrowest span that clears the target — a wider grid means more dead');
    console.log('cells the player can never win, which is what caused the original 56% edge.');
    console.log('='.repeat(74) + '\n');
}

main();
