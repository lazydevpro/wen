import {AbiCoder, keccak256, concat} from 'ethers';
import type {Bucket, SwapPoint} from './uniswap.js';
import type {EraSpec, PoolSpec} from './config.js';

const abi = AbiCoder.defaultAbiCoder();

/** Fraction of the window shown to the player before betting opens. */
export const VISIBLE_FRAC = 0.2;

/** Grid dimensions. */
export const GRID_TIME_STEPS = 8;
export const GRID_PRICE_BANDS = 12;

/**
 * House edge baked into every multiplier.
 *
 * Was 0.037 (casino-slot territory). Retuned after real play: with per-cell EV at 96.3%, covering
 * the top five cells of an early column returned something 94% of rounds — the house won on paper
 * and lost the feel. At 0.11 the designed RTP is 89%, which measures ~90% realised against the
 * pool (real paths run slightly hotter than the model, same ~1.3pt gap seen at every calibration).
 * Sessions now bleed visibly; the game stays winnable on a read, not on coverage.
 */
export const HOUSE_EDGE = 0.11;

/** Hard cap — the top multiplier dominates bankroll variance. */
export const MAX_MULTIPLIER = 250;

/** Never quote a multiplier below this; sub-1x cells still return something. */
export const MIN_MULTIPLIER = 0.3;

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
export const GRID_SIGMA_SPAN = Number(process.env.GRID_SIGMA_SPAN ?? 3.4);

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
    // grid spans roughly +/-3 sigma over the full horizon
    const horizonSigma = sigma * Math.sqrt(timeSteps);
    const bandHeight = (GRID_SIGMA_SPAN * horizonSigma) / bands;

    const hits: number[][] = Array.from({length: timeSteps}, () => new Array(bands).fill(0));

    for (let s = 0; s < sims; s++) {
        let logP = 0;
        for (let t = 0; t < timeSteps; t++) {
            // Box-Muller
            const u1 = Math.random() || 1e-12;
            const u2 = Math.random();
            const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            logP += sigma * z;
            const b = bandOf(anchorPrice * Math.exp(logP), anchorPrice, bandHeight, bands);
            if (b >= 0) hits[t][b]++;
        }
    }

    const grid: GridCell[] = [];
    for (let t = 0; t < timeSteps; t++) {
        for (let p = 0; p < bands; p++) {
            const prob = hits[t][p] / sims;
            let mult: number;
            if (prob <= 0) {
                mult = MAX_MULTIPLIER;
            } else {
                mult = Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, ((1 - HOUSE_EDGE) / prob)));
            }
            grid.push({t, p, probability: prob, multiplier: Math.round(mult * 100) / 100});
        }
    }
    return {grid, bandHeight};
}

// ----------------------------------------------------------- assembly

export function buildWindow(id: string, era: EraSpec, pool: PoolSpec, buckets: Bucket[]): Window {
    const candles = foldBuckets(buckets);
    if (candles.length < GRID_TIME_STEPS + 5) {
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
    const outcome = hidden.slice(0, GRID_TIME_STEPS).map((c, t) => ({
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
