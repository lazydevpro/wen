/**
 * House-edge calibration check.
 *
 * The multiplier grid prices each cell from a normal random walk fitted to the VISIBLE candles.
 * The arithmetic is exact (96.30% on unclamped cells), but that only holds if reality behaves
 * like the model. The honest question is:
 *
 *   Do REAL historical outcomes land where the model says they will?
 *
 * They did not. I expected fat tails; the opposite was true. Sigma estimated from a handful of
 * visible candles over-stated how far prices travel, so at the original 6-sigma grid width the
 * outer bands were unreachable, players bought cells that could not win, and the realised house
 * edge was 56% instead of 3.7%. Narrowing the grid to 2.55 sigma brought realised RTP to ~95%.
 *
 *   pnpm simulate
 */
import {readFileSync, readdirSync} from 'node:fs';
import {HOUSE_EDGE, MAX_MULTIPLIER} from './lib/window.js';

const DIR = new URL('../data/windows/', import.meta.url).pathname;

interface Row {
    window: string;
    t: number;
    band: number;
    modelProb: number;
    multiplier: number;
}

const rows: Row[] = [];
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

for (const f of files) {
    const w = JSON.parse(readFileSync(DIR + f, 'utf8'));
    for (const o of w.outcome) {
        // A column whose price left the grid is not a column that did not happen — the bettor
        // staked on it and lost every unit. Skipping these here silently dropped the house's
        // best columns from the denominator and overstated RTP by ~20 points.
        if (o.p < 0) {
            rows.push({window: w.id, t: o.t, band: -1, modelProb: 0, multiplier: 0});
            continue;
        }
        const cell = w.grid.find((c: any) => c.t === o.t && c.p === o.p);
        rows.push({window: w.id, t: o.t, band: o.p, modelProb: cell.probability, multiplier: cell.multiplier});
    }
}

console.log('='.repeat(74));
console.log('HINDSIGHT — house edge calibration against REAL outcomes');
console.log('='.repeat(74));
console.log(`\nwindows: ${files.length}   real outcomes observed: ${rows.length}\n`);

// ---- 1. what would a uniform bettor actually have returned? ----
// One unit on every cell of every column. Return = multiplier of the cell that actually hit.
const bandsPerColumn = JSON.parse(readFileSync(DIR + files[0], 'utf8')).grid.reduce(
    (m: number, c: any) => Math.max(m, c.p + 1),
    0,
);
const stakePerColumn = bandsPerColumn; // 1 unit x every band
const totalStaked = rows.length * stakePerColumn;
const totalReturned = rows.reduce((a, r) => a + r.multiplier, 0);

console.log('1. UNIFORM BETTOR vs REAL HISTORY');
console.log(`   staked   : ${totalStaked} units (1 per band x ${bandsPerColumn} bands x ${rows.length} columns)`);
console.log(`   returned : ${totalReturned.toFixed(2)} units`);
console.log(`   actual RTP  : ${((totalReturned / totalStaked) * 100).toFixed(2)}%`);
console.log(`   target RTP  : ${((1 - HOUSE_EDGE) * 100).toFixed(2)}%`);
console.log(`   house edge  : ${((1 - totalReturned / totalStaked) * 100).toFixed(2)}%\n`);

// ---- 2. does the grid cover where prices actually go? ----
// The width of the grid is the lever that broke the edge: too wide and the outer bands
// never hit, so players buy unwinnable cells. Band coverage measures it directly.
console.log('2. GRID COVERAGE (are the bands where prices actually go?)');
// only real bands here — the -1 sentinel means "left the grid", which is not a band
const landed = rows.filter((r) => r.band >= 0);
const escaped = rows.length - landed.length;
const visited = new Set(landed.map((r) => r.band));
const hist = new Array(bandsPerColumn).fill(0);
for (const r of landed) hist[r.band]++;
const peak = Math.max(...hist);
for (let b = bandsPerColumn - 1; b >= 0; b--) {
    const bar = '█'.repeat(Math.round((hist[b] / peak) * 26));
    console.log(`   band ${String(b).padStart(2)} ${String(hist[b]).padStart(3)}  ${bar}`);
}
console.log(`   bands visited: ${visited.size}/${bandsPerColumn}`);
console.log(`   columns where price LEFT the grid: ${escaped}/${rows.length} (a total loss for a uniform bettor)`);
if (visited.size < bandsPerColumn * 0.5) {
    console.log('   ⚠️  grid too WIDE — outer bands unreachable, players buy unwinnable cells');
} else if (visited.size === bandsPerColumn) {
    console.log('   ⚠️  grid may be too NARROW — outcomes reaching every band, incl. the edges');
} else {
    console.log('   ✅ sensible coverage');
}
console.log('');

// ---- 3. worst case exposure ----
const clamped = rows.filter((r) => r.multiplier >= MAX_MULTIPLIER);
console.log(`\n3. TAIL EXPOSURE`);
console.log(`   outcomes landing on a clamped ${MAX_MULTIPLIER}x cell: ${clamped.length}/${rows.length}`);
if (clamped.length) {
    for (const c of clamped) console.log(`     ⚠️ ${c.window} t=${c.t} band=${c.band} p=${c.modelProb}`);
}

// ---- 4. per-window breakdown ----
console.log(`\n4. PER-WINDOW`);
for (const f of files) {
    const id = f.replace('.json', '');
    const wr = rows.filter((r) => r.window === id);
    if (!wr.length) continue;
    const ret = wr.reduce((a, r) => a + r.multiplier, 0);
    const stake = wr.length * stakePerColumn;
    const rtp = (ret / stake) * 100;
    const bar = '█'.repeat(Math.min(40, Math.round(rtp / 5)));
    console.log(`   ${id.padEnd(18)} RTP ${rtp.toFixed(1).padStart(6)}%  ${bar}`);
}

console.log('\n' + '='.repeat(74));
const actualRtp = totalReturned / totalStaked;
if (actualRtp > 1.0) {
    console.log('❌ House LOSES money against real history — tail cells are underpriced.');
} else if (actualRtp > 1 - HOUSE_EDGE * 0.5) {
    console.log('⚠️  Edge is thinner against real history than the model predicts.');
} else {
    console.log('✅ House edge holds against real historical outcomes.');
}
console.log('='.repeat(74));
console.log(
    '\nNote: n is small (one real path per window), so this is a sanity check on calibration,\n' +
        'not a statistical proof. It is the honest test available — the outcomes are real history,\n' +
        'not resampled from the same model that priced the cells.\n',
);
