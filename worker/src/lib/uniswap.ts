import {JsonRpcProvider, Interface, type Log} from 'ethers';
import {LOG_CHUNK, SWAP_TOPIC, type PoolSpec} from './config.js';
import {mapLimit} from './blocks.js';

export const swapIface = new Interface([
    'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);

const Q96 = 2n ** 96n;
const SCALE = 1_000_000n;

/**
 * Price of token1 denominated in token0 (e.g. ETH in USDC) from sqrtPriceX96.
 *
 * raw = (sqrtPriceX96 / 2^96)^2  -> token1-smallest-units per token0-smallest-unit
 * For USDC(6)/WETH(18): 1 ETH = 1e18 wei, costing 1e18/raw USDC-micro => 1e12/raw USDC.
 */
export function priceFromSqrtX96(sqrtPriceX96: bigint, pool: PoolSpec): number {
    const decDiff = BigInt(pool.token1Decimals - pool.token0Decimals);
    if (pool.invert) {
        // token0 per token1
        const num = Q96 * Q96 * 10n ** decDiff * SCALE;
        return Number(num / (sqrtPriceX96 * sqrtPriceX96)) / Number(SCALE);
    }
    const num = sqrtPriceX96 * sqrtPriceX96 * SCALE;
    return Number(num / (Q96 * Q96 * 10n ** decDiff)) / Number(SCALE);
}

export interface SwapPoint {
    blockNumber: number;
    txHash: string;
    logIndex: number;
    sqrtPriceX96: bigint;
    price: number;
    tick: number;
}

/** Decode a raw Swap log into a price point. */
export function decodeSwap(log: Log, pool: PoolSpec): SwapPoint {
    const parsed = swapIface.parseLog({topics: [...log.topics], data: log.data})!;
    const sqrtPriceX96: bigint = parsed.args.sqrtPriceX96;
    return {
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.index,
        sqrtPriceX96,
        price: priceFromSqrtX96(sqrtPriceX96, pool),
        tick: Number(parsed.args.tick),
    };
}

/**
 * Scan `pool` for Swap events over [fromBlock, toBlock], chunked to satisfy the
 * 10-block eth_getLogs cap on free-tier RPCs. Retries transient failures.
 */
export async function scanSwaps(
    eth: JsonRpcProvider,
    pool: PoolSpec,
    fromBlock: number,
    toBlock: number,
    opts: {onProgress?: (done: number, total: number, found: number) => void} = {},
): Promise<SwapPoint[]> {
    const out: SwapPoint[] = [];
    const total = Math.ceil((toBlock - fromBlock + 1) / LOG_CHUNK);
    let chunk = 0;

    for (let a = fromBlock; a <= toBlock; a += LOG_CHUNK) {
        const b = Math.min(a + LOG_CHUNK - 1, toBlock);
        let logs: Log[] = [];
        for (let attempt = 0; ; attempt++) {
            try {
                logs = (await eth.getLogs({
                    address: pool.address,
                    topics: [SWAP_TOPIC],
                    fromBlock: a,
                    toBlock: b,
                })) as Log[];
                break;
            } catch (e: any) {
                if (attempt >= 4) throw new Error(`getLogs ${a}..${b} failed: ${e.message ?? e}`);
                await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
            }
        }
        for (const l of logs) out.push(decodeSwap(l, pool));
        chunk++;
        opts.onProgress?.(chunk, total, out.length);
    }
    return out;
}

export interface Bucket {
    index: number;
    fromBlock: number;
    toBlock: number;
    swaps: SwapPoint[];
}

/**
 * Stratified sample across a wide era, one bucket per candle.
 *
 * Consecutive scanning is wrong for this: a deep pool produces hundreds of swaps in a few
 * hundred blocks, so a "window" ends up spanning ~30 minutes of noise instead of the days
 * of price action that make an era recognisable. Instead we divide `spanBlocks` into
 * `buckets` slices and probe each one, which gives a chart that actually shows the era.
 */
export async function sampleStratified(
    eth: JsonRpcProvider,
    pool: PoolSpec,
    fromBlock: number,
    spanBlocks: number,
    buckets: number,
    onProgress?: (done: number, total: number, swaps: number) => void,
): Promise<Bucket[]> {
    const stride = Math.max(LOG_CHUNK, Math.floor(spanBlocks / buckets));
    const out: Bucket[] = [];
    let totalSwaps = 0;

    for (let i = 0; i < buckets; i++) {
        const base = fromBlock + i * stride;
        let swaps: SwapPoint[] = [];

        // probe outward until we find at least one swap (thin eras need more looking)
        for (let probe = 0; probe < 6 && swaps.length === 0; probe++) {
            const a = base + probe * LOG_CHUNK;
            const b = Math.min(a + LOG_CHUNK - 1, base + stride - 1);
            if (a > b) break;
            try {
                const logs = (await eth.getLogs({
                    address: pool.address,
                    topics: [SWAP_TOPIC],
                    fromBlock: a,
                    toBlock: b,
                })) as Log[];
                swaps = logs.map((l) => decodeSwap(l, pool));
            } catch {
                // transient; try the next probe
            }
        }

        if (swaps.length > 0) {
            out.push({index: i, fromBlock: base, toBlock: base + stride - 1, swaps});
            totalSwaps += swaps.length;
        }
        onProgress?.(i + 1, buckets, totalSwaps);
    }
    return out;
}

/**
 * Concurrent sibling of sampleStratified, for generating a large window pool.
 *
 * Two things about the free Alchemy tier drove this shape, both learned the hard way:
 *
 *  1. It throttles by QUEUING, not by rejecting. Sustained load produces no 429 — requests just
 *     hang, sometimes for minutes. So every call needs its own timeout; retrying is useless
 *     against a request that will eventually succeed but far too late to be worth waiting for.
 *  2. A swallowed error is indistinguishable from "no swaps in this range", which sends the
 *     probe loop hunting outward and issues up to six times more requests. Under throttling that
 *     is a feedback loop: slowness causes extra requests, which cause more slowness. Errors and
 *     empty results are therefore handled separately — only a *successful* empty read probes on.
 */
async function getLogsOrTimeout(
    eth: JsonRpcProvider,
    pool: PoolSpec,
    a: number,
    b: number,
    timeoutMs: number,
): Promise<Log[] | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return (await Promise.race([
            eth.getLogs({address: pool.address, topics: [SWAP_TOPIC], fromBlock: a, toBlock: b}),
            new Promise<never>((_, rej) => {
                timer = setTimeout(() => rej(new Error('rpc timeout')), timeoutMs);
            }),
        ])) as Log[];
    } catch {
        return null; // timed out or errored — explicitly NOT "no swaps here"
    } finally {
        clearTimeout(timer);
    }
}

export async function sampleStratifiedConcurrent(
    eth: JsonRpcProvider,
    pool: PoolSpec,
    fromBlock: number,
    spanBlocks: number,
    buckets: number,
    concurrency = 8,
    timeoutMs = 12_000,
): Promise<Bucket[]> {
    const stride = Math.max(LOG_CHUNK, Math.floor(spanBlocks / buckets));
    const indices = Array.from({length: buckets}, (_, i) => i);

    const results = await mapLimit(indices, concurrency, async (i) => {
        const base = fromBlock + i * stride;
        for (let probe = 0; probe < 4; probe++) {
            const a = base + probe * LOG_CHUNK;
            const b = Math.min(a + LOG_CHUNK - 1, base + stride - 1);
            if (a > b) break;

            const logs = await getLogsOrTimeout(eth, pool, a, b, timeoutMs);
            if (logs === null) return null; // give up on this bucket rather than amplify load
            if (logs.length) {
                return {index: i, fromBlock: base, toBlock: base + stride - 1, swaps: logs.map((l) => decodeSwap(l, pool))};
            }
            // genuinely empty — a thin stretch, so it is worth looking a little further along
        }
        return null;
    });

    return results.filter((b): b is Bucket => b !== null);
}

/**
 * Scan forward from `fromBlock` until at least `minSwaps` are collected.
 * Historic eras vary hugely in activity, so a fixed range is unreliable.
 */
export async function scanUntil(
    eth: JsonRpcProvider,
    pool: PoolSpec,
    fromBlock: number,
    minSwaps: number,
    maxBlocks = 6000,
    onProgress?: (blocks: number, found: number) => void,
): Promise<SwapPoint[]> {
    const out: SwapPoint[] = [];
    for (let off = 0; off < maxBlocks && out.length < minSwaps; off += LOG_CHUNK) {
        const a = fromBlock + off;
        const b = a + LOG_CHUNK - 1;
        try {
            const logs = (await eth.getLogs({
                address: pool.address,
                topics: [SWAP_TOPIC],
                fromBlock: a,
                toBlock: b,
            })) as Log[];
            for (const l of logs) out.push(decodeSwap(l, pool));
        } catch {
            // transient - skip this chunk rather than abort a long scan
        }
        onProgress?.(off + LOG_CHUNK, out.length);
    }
    return out;
}
