import type {JsonRpcProvider} from 'ethers';

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * Alchemy's free tier caps eth_getLogs at a 10-block range, so a 10-day window costs one request
 * per candle and there is no way to batch it away. Measured throughput: 1 concurrent request is
 * 2.5/s, 40 concurrent is ~87/s with no failures. Concurrency is the only lever that makes
 * generating a large pool practical.
 */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await fn(items[i], i);
        }
    });
    await Promise.all(workers);
    return out;
}

/**
 * Binary-search the first block at or after `isoDate`.
 *
 * Necessary because block time is not constant: ~13.2s before the Merge and exactly 12s after,
 * so estimating a block from a date arithmetically drifts by weeks across the 2021-2024 range.
 * Roughly 25 getBlock calls per era, which is nothing next to the log scanning.
 */
export async function blockForDate(eth: JsonRpcProvider, isoDate: string, headBlock: number): Promise<number> {
    const target = Math.floor(new Date(`${isoDate}T00:00:00Z`).getTime() / 1000);
    let lo = 1;
    let hi = headBlock;

    while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const b = await eth.getBlock(mid);
        if (!b) {
            lo = mid + 1;
            continue;
        }
        if (b.timestamp < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

export async function dateOfBlock(eth: JsonRpcProvider, block: number): Promise<string> {
    const b = await eth.getBlock(block);
    return new Date((b?.timestamp ?? 0) * 1000).toISOString().slice(0, 10);
}
