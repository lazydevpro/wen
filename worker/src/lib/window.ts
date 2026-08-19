import {AbiCoder, keccak256, concat} from 'ethers';
import type {Bucket, SwapPoint} from './uniswap.js';
import type {EraSpec, PoolSpec} from './config.js';

const abi = AbiCoder.defaultAbiCoder();

/** Fraction of the window shown to the player before betting opens. */
export const VISIBLE_FRAC = 0.2;

/** Grid dimensions. */
export const GRID_TIME_STEPS = 8;

/**
 * Price bands per column.
 *
 * Briefly 5, to chase a ~1.4x cheapest cell. Restored to 12 — the finer grid is the game, and a
 * coarse 5-row board reads as a different, blunter product.
 *
 * The cost of that choice, measured rather than assumed (`pnpm sweep-grid`): multiplier is
 * (1 - edge) / probability, so a cheap cell has to be a LIKELY cell. Twelve bands split the
 * distribution twelve ways, so the likeliest cell sits near 20% and its fair price is ~4x. No
 * edge setting moves that without either paying pennies on a fair bet or widening the bands so
 * far that a third of the grid is unwinnable — at 12 bands and 9-sigma the cheapest cell only
 * reaches 2.04x and the house loses 67%. The floor stands at (1 - edge).
 */
export const GRID_PRICE_BANDS = 12;

/**
 * Hidden candles of runway before the first bettable column.
 *
 * The path is already travelling when it reaches the grid instead of starting pinned to the
 * anchor. That also spreads the first column, which used to be concentrated enough that a couple
 * of cells carried nearly all the probability.
 *
 * Load-bearing on-chain: GridGame pins each revealed candle to visibleCount + LEAD + t, so this
 * must match GridGame.GRID_LEAD_STEPS exactly or nothing resolves.
 */
export const GRID_LEAD_STEPS = Number(process.env.GRID_LEAD_STEPS ?? 2);

/**
 * House edge baked into every multiplier.
 *
 * Retuned three times, each against measured outcomes rather than intuition:
 *
 *   0.037  ->  covering five likely cells returned something 94% of rounds. Fair on paper,
 *              felt like the house never won.
 *   0.110  ->  90.3% realised at 12 bands. Better, but the likeliest cell still paid ~3x, so a
 *              single hit covered four misses.
 *   0.162  ->  the 5-band grid concentrates probability into wider cells, and reality ran 5.5
 *              points hotter than the model there (vs ~1.3 at 12 bands). This is the design
 *              target that lands ~89% realised, and it drags the cheapest cell under 1.5x.
 *
 * The gap between designed and realised is why the design number always overshoots — re-measure
 * with `pnpm simulate` after any change to grid shape, never assume it carries over.
 */
export const HOUSE_EDGE = 0.162;

/** Hard cap — the top multiplier dominates bankroll variance. */
export const MAX_MULTIPLIER = 250;

/** Never quote a multiplier below this. The anchor row is deliberately pinned here. */
export const MIN_MULTIPLIER = 1.0;

/**
 * The payout ladder, by distance from the anchor row — AUTHORED, not derived.
 *
 * Everything before this priced each cell at its fair odds, (1 - edge) / probability, which
 * gives every cell identical expected value. That is one convention, not a law, and it carries
 * a consequence: with twelve bands the likeliest cell sits near 20%, so its fair price is ~4x
 * and no edge setting brings it to 1x without paying pennies on a fair bet.
 *
 * Roulette does not work that way. A straight-up number pays 35:1 flat; some bets are simply
 * worse value than others and the house edge falls out in aggregate. So these are chosen round
 * numbers — bet the anchor row and you get your stake back, bet the far edge and it pays big —
 * and the EDGE is what gets solved for, per column, rather than the prices.
 *
 * Ratios only. calibrateLadder() scales the spread per column so every column carries the same
 * edge, which matters: a single flat ladder made columns 5-7 positive-EV (107%, 111%, 137%),
 * and betting only the late columns beat the house outright.
 */
export const MULT_SHAPE = [1, 4, 10, 25, 60, 150];

/**
 * The ladder per column, calibrated against REAL outcomes rather than the random-walk model.
 *
 * Calibrating on the model looked right and was not: the model expects the price to sit near the
 * anchor early on, but real paths trend, so they travel further than a random walk predicts —
 * and most so in the first columns. Priced on the model, columns 0 and 1 came out at 123% and
 * 110% against real history, so betting only the opening columns beat the house. Priced on the
 * history itself, every column sits on target.
 *
 * Distance is measured in the window's OWN band heights, and band height scales with that
 * window's sigma, so one pooled table is valid across windows of different volatility.
 *
 * Regenerate with `pnpm calibrate-ladder` whenever the pool changes materially.
 */
export const LADDER_BY_COLUMN = [
    [1, 5.62, 14.86, 37.97, 91.88, 230.5],
    [1, 5, 13.01, 33.02, 79.72, 199.8],
    [1, 5.01, 13.04, 33.12, 79.95, 200.38],
    [1, 5.46, 14.37, 36.65, 88.64, 222.33],
    [1, 4.23, 10.68, 26.81, 64.45, 161.24],
    [1, 3.36, 8.08, 19.87, 47.38, 118.13],
    [1, 3.28, 7.83, 19.22, 45.79, 114.11],
    [1, 2.82, 6.45, 15.55, 36.76, 91.31],
];

/** Rows either side of centre count as the same distance: 12 bands -> d = 0..5. */
export function bandDistance(p: number, bands = GRID_PRICE_BANDS): number {
    return Math.floor(Math.abs(p - (bands - 1) / 2));
}

/**
 * Scale the ladder for one column so its modelled RTP equals the target, with d=0 pinned at 1x.
 *
 * ladder[d] = 1 + (shape[d] - 1) * k, and k is solved from the column's own probabilities. Late
 * columns (where the price has had time to travel far) therefore pay LESS for distance than
 * early ones — which is exactly right, and is what removes the positive-EV columns.
 */
export function calibrateLadder(probsByDistance: number[], bands = GRID_PRICE_BANDS): number[] {
    const target = (1 - HOUSE_EDGE) * bands;
    const inGrid = probsByDistance.reduce((a, b) => a + b, 0);
    const spread = probsByDistance.reduce((a, pd, d) => a + pd * (MULT_SHAPE[Math.min(d, MULT_SHAPE.length - 1)] - 1), 0);
    // a column with no spread at all cannot be calibrated; fall back to the flat shape
    const k = spread > 1e-9 ? (target - inGrid) / spread : 1;
    return MULT_SHAPE.map((sh) => {
        const m = 1 + (sh - 1) * Math.max(0, k);
        return Math.round(Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, m)) * 100) / 100;
    });
}

/**
 * Total grid height in standard deviations of the horizon.
 *
 * Calibrated against real outcomes, not chosen a priori — and calibrated TWICE, because the
 * first attempt did not generalise:
 *
 *   6.00  ->  44% RTP   grid twice as wide as prices ever travel; outer bands unwinnable
 *   2.55  ->  87% RTP   fitted to six windows, looked right, took 13% instead of 3.7%
 *   3.40  ->  97% RTP   fitted to 120 windows, 960 real outcomes
 *
 * Six price paths could not pin a distribution. The 2.55 fit corrected an obvious 56% edge and
 * stopped there, which is the trap: a number that fits the sample you happen to have is not a
 * calibration. Re-check with `pnpm sweep-span` whenever the pool changes materially.
 */
export const GRID_SIGMA_SPAN = Number(process.env.GRID_SIGMA_SPAN ?? 4.5);

export interface Candle {
    index: number;
    blockNumber: number;
    sqrtPriceX96: bigint;
    price: number;
    /** the swap chosen to be proven on-chain for this candle */
    txHash: string;
    open: number;
    high: number;
    low: number;
    close: number;
}

export interface GridCell {
    t: number;
    p: number;
    /** empirical probability from the visible-data-only model */
    probability: number;
    multiplier: number;
}

export interface Window {
    id: string;
    era: EraSpec;
    pool: PoolSpec;
    candles: Candle[];
    visibleCount: number;
    merkleRoot: string;
    /** price at the last visible candle — the grid is centred here */
    anchorPrice: number;
    /** realised volatility per step, estimated from VISIBLE candles only */
    sigma: number;
    bandHeight: number;
    grid: GridCell[];
    /** which (t,p) cells the hidden path actually visits — the answer, never sent to the client */
    outcome: {t: number; p: number}[];
}

// --------------------------------------------------------------- candles

/**
 * Fold stratified buckets into OHLC candles — one candle per bucket. Each candle keeps one
 * representative swap (its close) which is the transaction we prove on-chain.
 */
export function foldBuckets(buckets: Bucket[]): Candle[] {
    return buckets
        .filter((b) => b.swaps.length > 0)
        .map((b, i) => {
            const sorted = [...b.swaps].sort((x, y) => x.blockNumber - y.blockNumber || x.logIndex - y.logIndex);
            const prices = sorted.map((s) => s.price);
            const close = sorted[sorted.length - 1];
            return {
                index: i,
                blockNumber: close.blockNumber,
                sqrtPriceX96: close.sqrtPriceX96,
                price: close.price,
                txHash: close.txHash,
                open: prices[0],
                high: Math.max(...prices),
                low: Math.min(...prices),
                close: close.price,
            };
        });
}

// ---------------------------------------------------------------- merkle

/** leaf = keccak256(abi.encode(index, blockNumber, sqrtPriceX96)) */
export function candleLeaf(c: Candle): string {
    return keccak256(abi.encode(['uint256', 'uint64', 'uint160'], [c.index, c.blockNumber, c.sqrtPriceX96]));
}

const sortPair = (a: string, b: string) => (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]);
const hashPair = (a: string, b: string) => {
    const [x, y] = sortPair(a, b);
    return keccak256(concat([x, y]));
};

/** OpenZeppelin-compatible sorted-pair Merkle tree. */
export function buildMerkle(leaves: string[]): {root: string; layers: string[][]} {
    if (leaves.length === 0) throw new Error('no leaves');
    const layers: string[][] = [leaves];
    while (layers[layers.length - 1].length > 1) {
        const prev = layers[layers.length - 1];
        const next: string[] = [];
        for (let i = 0; i < prev.length; i += 2) {
            next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
        }
        layers.push(next);
    }
    return {root: layers[layers.length - 1][0], layers};
}

export function merkleProof(layers: string[][], index: number): string[] {
    const proof: string[] = [];
    let idx = index;
    for (let l = 0; l < layers.length - 1; l++) {
        const layer = layers[l];
        const pair = idx ^ 1;
        if (pair < layer.length) proof.push(layer[pair]);
        idx = Math.floor(idx / 2);
    }
    return proof;
}

// ----------------------------------------------------------- multipliers

/**
 * Per-step realised volatility of log returns.
 *
 * ⚠️ MUST be fed VISIBLE candles only. Deriving volatility from the hidden path would leak
 * the answer through the multipliers — a player could read the grid and infer where the
 * chart goes. See docs/plans/spec.md.
 */
export function realisedSigma(visible: Candle[]): number {
    if (visible.length < 3) return 0.01;
    const rets: number[] = [];
    for (let i = 1; i < visible.length; i++) {
        rets.push(Math.log(visible[i].close / visible[i - 1].close));
    }
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, rets.length - 1);
    return Math.max(Math.sqrt(varr), 1e-4);
}

/** Which price band a price falls into, or -1 if outside the grid. */
export function bandOf(price: number, anchor: number, bandHeight: number, bands: number): number {
    const half = bands / 2;
    const offset = (price - anchor) / (anchor * bandHeight);
    const b = Math.floor(offset + half);
    return b < 0 || b >= bands ? -1 : b;
}

/**
 * Monte-Carlo the cell probabilities under a random walk calibrated to `sigma`.
 * Simulation (rather than a closed-form normal CDF) keeps this readable and avoids
 * implementing erf, and it generalises if we later add drift or fat tails.
 */
export function buildGrid(
    anchorPrice: number,
    sigma: number,
    timeSteps = GRID_TIME_STEPS,
    bands = GRID_PRICE_BANDS,
    sims = 40_000,
): {grid: GridCell[]; bandHeight: number} {
    // The horizon includes the runway: the last bettable column sits LEAD steps further out
    // than it used to, so the grid has to be sized for where the path can actually be by then.
    const total = GRID_LEAD_STEPS + timeSteps;
    const horizonSigma = sigma * Math.sqrt(total);
    const bandHeight = (GRID_SIGMA_SPAN * horizonSigma) / bands;

    const hits: number[][] = Array.from({length: timeSteps}, () => new Array(bands).fill(0));

    for (let s = 0; s < sims; s++) {
        let logP = 0;
        for (let step = 0; step < total; step++) {
            // Box-Muller
            const u1 = Math.random() || 1e-12;
            const u2 = Math.random();
            const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            logP += sigma * z;
            const t = step - GRID_LEAD_STEPS;   // runway steps are travelled, not bet on
            if (t < 0) continue;
            const b = bandOf(anchorPrice * Math.exp(logP), anchorPrice, bandHeight, bands);
            if (b >= 0) hits[t][b]++;
        }
    }

    const grid: GridCell[] = [];
    for (let t = 0; t < timeSteps; t++) {
        // Prices come from the calibrated table, not from this window's modelled probabilities.
        // The Monte Carlo above still runs — `probability` is kept for the diagnostics in
        // simulate.ts — but it no longer decides what anything costs.
        const ladder = LADDER_BY_COLUMN[Math.min(t, LADDER_BY_COLUMN.length - 1)];
        for (let p = 0; p < bands; p++) {
            const d = Math.min(bandDistance(p, bands), ladder.length - 1);
            grid.push({t, p, probability: hits[t][p] / sims, multiplier: ladder[d]});
        }
    }
    return {grid, bandHeight};
}

// ----------------------------------------------------------- assembly

export function buildWindow(id: string, era: EraSpec, pool: PoolSpec, buckets: Bucket[]): Window {
    const candles = foldBuckets(buckets);
    if (candles.length < GRID_LEAD_STEPS + GRID_TIME_STEPS + 5) {
        throw new Error(`too few candles (${candles.length}) - era too thin or span too narrow`);
    }
    const visibleCount = Math.max(3, Math.floor(candles.length * VISIBLE_FRAC));
    const visible = candles.slice(0, visibleCount);
    const hidden = candles.slice(visibleCount);

    const sigma = realisedSigma(visible);
    const anchorPrice = visible[visible.length - 1].close;
    const {grid, bandHeight} = buildGrid(anchorPrice, sigma);

    const {root} = buildMerkle(candles.map(candleLeaf));

    // The answer. Kept server-side; revealed candle-by-candle with Merkle proofs.
    // Starts past the runway — those candles happen, they just aren't bet on.
    const outcome = hidden.slice(GRID_LEAD_STEPS, GRID_LEAD_STEPS + GRID_TIME_STEPS).map((c, t) => ({
        t,
        p: bandOf(c.close, anchorPrice, bandHeight, GRID_PRICE_BANDS),
    }));

    return {
        id,
        era,
        pool,
        candles,
        visibleCount,
        merkleRoot: root,
        anchorPrice,
        sigma,
        bandHeight,
        grid,
        outcome,
    };
}

/**
 * Per-cell house-edge diagnostics.
 *
 * For an unclamped cell, multiplier = (1-edge)/p, so p*multiplier == 1-edge exactly. Cells
 * clamped at MAX_MULTIPLIER carry a *worse* edge than target — that is standard for extreme
 * long-shot cells (the 250x bucket is a bad bet in real Plinko too) and is disclosed to the
 * player by the printed multiplier.
 */
export function gridEdgeStats(grid: GridCell[]) {
    const live = grid.filter((c) => c.probability > 0);
    const clamped = live.filter((c) => c.multiplier >= MAX_MULTIPLIER);
    const unclamped = live.filter((c) => c.multiplier < MAX_MULTIPLIER);
    const evOf = (cs: GridCell[]) => (cs.length ? cs.reduce((a, c) => a + c.probability * c.multiplier, 0) / cs.length : 0);
    return {
        cells: grid.length,
        deadCells: grid.length - live.length,
        clampedCells: clamped.length,
        evUnclamped: evOf(unclamped),
        evClamped: evOf(clamped),
        /** what a player betting one unit on every live cell would return per unit staked */
        evUniformLive: live.length ? live.reduce((a, c) => a + c.probability * c.multiplier, 0) / live.length : 0,
    };
}
