/**
 * The exact payload ChartRegistry.registerWindow() expects.
 *
 * Shared by export-window (test fixtures) and register-bulk (on-chain), because these two must
 * agree byte for byte. `riddleHash` and `merkleRoot` are committed on-chain, so a second
 * implementation that drifted even slightly would register windows the tests do not describe.
 */
import {parseUnits, keccak256, toUtf8Bytes} from 'ethers';
import {GRID_PRICE_BANDS, GRID_TIME_STEPS, bandOf, buildMerkle, candleLeaf, merkleProof} from './window.js';

export interface RegistrationParams {
    windowId: string;
    eraLabel: string;
    riddleHash: string;
    merkleRoot: string;
    anchorSqrtPriceX96: string;
    bandHeightScaled: string;
    totalCandles: number;
    visibleCount: number;
    timeSteps: number;
    priceBands: number;
    invert: boolean;
    multipliers: number[];
    visibleSqrtPrices: string[];
    hidden: {
        t: number;
        index: number;
        blockNumber: number;
        sqrtPriceX96: string;
        price: number;
        expectedBand: number;
        proof: string[];
    }[];
}

/** `win` is a parsed worker/data/windows/<id>.json. */
export function registrationParams(win: any): RegistrationParams {
    const candles = win.candles.map((c: any) => ({...c, sqrtPriceX96: BigInt(c.sqrtPriceX96)}));
    const visibleCount: number = win.visibleCount;
    const anchor = candles[visibleCount - 1];

    const {root, layers} = buildMerkle(candles.map(candleLeaf));
    if (root !== win.merkleRoot) {
        throw new Error(`merkle mismatch for ${win.id}: rebuilt ${root} vs stored ${win.merkleRoot}`);
    }

    const hidden = candles.slice(visibleCount, visibleCount + GRID_TIME_STEPS);

    return {
        windowId: keccak256(toUtf8Bytes(win.id)),
        eraLabel: win.era.label,
        riddleHash: keccak256(toUtf8Bytes(win.era.riddle)),
        merkleRoot: root,
        anchorSqrtPriceX96: anchor.sqrtPriceX96.toString(),
        // bandHeight is a fraction of anchor price; scaled to 1e18 for on-chain fixed point
        bandHeightScaled: parseUnits(win.bandHeight.toFixed(18), 18).toString(),
        totalCandles: candles.length,
        visibleCount,
        timeSteps: GRID_TIME_STEPS,
        priceBands: GRID_PRICE_BANDS,
        invert: win.pool.invert,
        // scaled by 1e4, flattened as t * priceBands + p
        multipliers: win.grid.map((c: any) => Math.round(c.multiplier * 1e4)),
        visibleSqrtPrices: candles.slice(0, visibleCount).map((c: any) => c.sqrtPriceX96.toString()),
        hidden: hidden.map((c: any, t: number) => ({
            t,
            index: c.index,
            blockNumber: c.blockNumber,
            sqrtPriceX96: c.sqrtPriceX96.toString(),
            price: c.close,
            expectedBand: bandOf(c.close, win.anchorPrice, win.bandHeight, GRID_PRICE_BANDS),
            proof: merkleProof(layers, c.index),
        })),
    };
}
