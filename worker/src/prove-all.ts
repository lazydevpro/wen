/**
 * Proves the whole candle corpus on-chain through Attestcoin, concurrently.
 *
 *   pnpm prove-all                 # every candle in every window
 *   pnpm prove-all --used          # only the 18/window a player can ever see or be paid on
 *   pnpm prove-all --limit 50      # smoke test
 *
 * WHY THIS EXISTS
 * prove-candles.ts walks one window serially and awaits `tx.wait()` before starting the next
 * proof. Measured on CC3: ~4.0s to fetch a proof, ~7.5s for a block. Awaiting each receipt
 * therefore idles ~7.5s per candle for no reason, and the full 4,706-candle corpus takes ~16
 * hours. The chain is nowhere near the constraint — the block gas limit is 75M and a candle
 * costs 462k-1.3M, so 57-162 candles fit in a single block. The prover API is the only real
 * bottleneck, and it is latency-bound rather than rate-limited (six sequential requests drew no
 * 429s). So: fetch proofs on N workers, and submit transactions by pre-assigned nonce without
 * waiting for confirmation. That turns ~16 hours into ~40 minutes.
 *
 * NONCE DISCIPLINE — the part that has bitten this project twice
 * Every transaction here takes an explicit, locally-incremented nonce handed out by ONE counter.
 * Do not run any other script from the deployer wallet while this is in flight; a second sender
 * reading `getTransactionCount` mid-run will collide and both runs will stall.
 *
 * Gas is estimated per candle, deliberately, and deliberately BEFORE a nonce is drawn. A flat
 * limit is tempting — it saves a round trip — but proof size varies enough that no constant is
 * safe: shallow candles cost ~530k while a 732-root candle needs 6.8M. Estimating first also
 * turns an unprovable candle into a clean skip instead of a consumed nonce and a stalled queue.
 *
 * Resumable: the journal is keyed by txHash and written through on every checkpoint, so a
 * restart re-proves nothing.
 */
import {readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync} from 'node:fs';
import {proofProvider} from '@gluwa/usc-sdk';
import {cfg, DEFAULT_POOL} from './lib/config.js';
import {chartVerifier, cc3Provider, signer} from './lib/contracts.js';
import {GRID_LEAD_STEPS, GRID_TIME_STEPS} from './lib/window.js';

const WINDOW_DIR = new URL('../data/windows/', import.meta.url).pathname;
const STATE_DIR = new URL('../data/proofs/', import.meta.url).pathname;
const JOURNAL = `${STATE_DIR}_corpus.json`;

const CONCURRENCY = Number(process.env.PROVE_CONCURRENCY ?? 8);
/** Unconfirmed transactions allowed outstanding. A block holds 57-162 candles, so this never
 *  backs up the mempool; it exists to bound memory and to keep failures surfacing promptly. */
const MAX_INFLIGHT = Number(process.env.PROVE_INFLIGHT ?? 40);
/* Gas is estimated per candle rather than fixed — see the note at the estimateGas call. */

interface Task {
    window: string;
    index: number;
    txHash: string;
    blockNumber: number;
}
interface Journal {
    done: Record<string, {tx: string; block: number; gas: string}>;
    failed: Record<string, string>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadJournal(): Journal {
    mkdirSync(STATE_DIR, {recursive: true});
    if (existsSync(JOURNAL)) return JSON.parse(readFileSync(JOURNAL, 'utf8'));
    return {done: {}, failed: {}};
}

function collectTasks(usedOnly: boolean): Task[] {
    const out: Task[] = [];
    for (const f of readdirSync(WINDOW_DIR).filter((x) => x.endsWith('.json'))) {
        const w = JSON.parse(readFileSync(WINDOW_DIR + f, 'utf8'));
        // A player sees candles 0..visibleCount-1, watches the runway, and is paid on the
        // outcome columns. Everything past that is inert padding inside the merkle tree.
        const lastUsed = w.visibleCount + GRID_LEAD_STEPS + GRID_TIME_STEPS;
        const candles = usedOnly ? w.candles.slice(0, lastUsed) : w.candles;
        for (const c of candles) {
            out.push({window: w.id, index: c.index, txHash: c.txHash, blockNumber: c.blockNumber});
        }
    }
    return out;
}

async function main() {
    const usedOnly = process.argv.includes('--used');
    const limIdx = process.argv.indexOf('--limit');
    const limit = limIdx > -1 ? Number(process.argv[limIdx + 1]) : 0;

    const journal = loadJournal();
    let tasks = collectTasks(usedOnly).filter((t) => !journal.done[t.txHash]);
    if (limit > 0) tasks = tasks.slice(0, limit);

    const provider = cc3Provider();
    const wallet = signer(provider);
    const verifier = chartVerifier(wallet);
    const builder = new proofProvider.service.ProofBuilder(cfg.chainKeyEth, cfg.proverApi, 300_000);
    const pool = DEFAULT_POOL.address;

    // ONE authoritative nonce read, then never again from the chain.
    let nonce = await provider.getTransactionCount(await wallet.getAddress(), 'pending');
    const startedAt = Date.now();

    console.log('='.repeat(74));
    console.log(`PROVE CORPUS — ${tasks.length} candles, concurrency ${CONCURRENCY}`);
    console.log('='.repeat(74));
    console.log(`verifier   : ${await verifier.getAddress()}`);
    console.log(`pool       : ${pool}`);
    console.log(`already    : ${Object.keys(journal.done).length} done, ${Object.keys(journal.failed).length} failed`);
    console.log(`start nonce: ${nonce}\n`);
    if (!tasks.length) return console.log('nothing to do.');

    let proven = 0;
    let failed = 0;
    let cursor = 0;
    let sinceSave = 0;

    const inflight = new Set<Promise<unknown>>();
    const track = (p: Promise<unknown>) => {
        const q = p.finally(() => inflight.delete(q));
        inflight.add(q);
        return q;
    };
    const drainTo = async (n: number) => {
        while (inflight.size >= n) await Promise.race(inflight);
    };

    const checkpoint = (force = false) => {
        if (!force && ++sinceSave < 25) return;
        sinceSave = 0;
        writeFileSync(JOURNAL, JSON.stringify(journal, null, 2));
    };

    async function worker(id: number) {
        for (;;) {
            const t = tasks[cursor++];
            if (!t) return;

            // 1. proof fetch — the slow, latency-bound half. One retry: deep-history proofs
            //    time out transiently and a second attempt almost always lands.
            let p: any;
            try {
                let res = await builder.getProof(t.txHash);
                if (!res.success) {
                    await sleep(1500);
                    res = await builder.getProof(t.txHash);
                }
                if (!res.success || !res.data) throw new Error(res.error ?? 'proof failed');
                p = res.data;
            } catch (e: any) {
                journal.failed[t.txHash] = `proof: ${(e.message ?? String(e)).slice(0, 100)}`;
                failed++;
                checkpoint();
                continue;
            }

            const siblings = p.merkleProof.siblings.map((s: any) => ({hash: s.hash, isLeft: s.isLeft}));

            // 2. size the transaction BEFORE drawing a nonce.
            //    Gas scales with proof size and cannot be safely guessed in advance: this script
            //    first shipped a flat 2.5M cap chosen from the 1.3M worst case seen on shallow
            //    candles, and a 732-root candle then needed 6.8M and silently ran out. Estimating
            //    also means a candle that can never be proven (wrong pool, failed source tx) is
            //    rejected here — before it consumes a nonce and leaves a gap that would stall
            //    every transaction queued behind it.
            let gasLimit: bigint;
            try {
                const est: bigint = await verifier.recordCandle.estimateGas(
                    pool,
                    p.chainKey,
                    p.headerNumber,
                    p.txBytes,
                    p.merkleProof.root,
                    siblings,
                    p.continuityProof.lowerEndpointDigest,
                    p.continuityProof.roots,
                );
                gasLimit = (est * 5n) / 4n; // 25% headroom
            } catch (e: any) {
                const msg = (e.shortMessage ?? e.message ?? String(e)).slice(0, 120);
                if (/QueryAlreadyProcessed/.test(msg)) {
                    journal.done[t.txHash] = {tx: '(pre-existing)', block: 0, gas: '0'};
                    proven++;
                } else {
                    journal.failed[t.txHash] = msg;
                    failed++;
                }
                checkpoint();
                continue;
            }

            // 3. submit — nonce assigned here and nowhere else. Synchronous between the read
            //    and the increment, so two workers can never draw the same number.
            await drainTo(MAX_INFLIGHT);
            const myNonce = nonce++;

            track(
                verifier
                    .recordCandle(
                        pool,
                        p.chainKey,
                        p.headerNumber,
                        p.txBytes,
                        p.merkleProof.root,
                        siblings,
                        p.continuityProof.lowerEndpointDigest,
                        p.continuityProof.roots,
                        {nonce: myNonce, gasLimit},
                    )
                    .then((tx: any) => tx.wait())
                    .then((rcpt: any) => {
                        journal.done[t.txHash] = {tx: rcpt.hash, block: rcpt.blockNumber, gas: String(rcpt.gasUsed)};
                        proven++;
                        checkpoint();
                    })
                    .catch(async (e: any) => {
                        let msg = (e.shortMessage ?? e.message ?? String(e)).slice(0, 120);
                        // An explicit gasLimit means ethers never simulated the call, so a revert
                        // arrives as the undifferentiated "transaction execution reverted" with no
                        // custom-error data. Replay it as a staticCall purely to recover the reason —
                        // otherwise a candle that is merely already-recorded is indistinguishable
                        // from one that genuinely cannot be proven.
                        try {
                            await verifier.recordCandle.staticCall(
                                pool,
                                p.chainKey,
                                p.headerNumber,
                                p.txBytes,
                                p.merkleProof.root,
                                siblings,
                                p.continuityProof.lowerEndpointDigest,
                                p.continuityProof.roots,
                            );
                            // The simulation passes, so the on-chain revert was transient
                            // (mempool contention, a dropped nonce). Leave it for the next pass.
                            msg = 'transient: staticCall succeeds, retry';
                        } catch (sim: any) {
                            msg = (sim.shortMessage ?? sim.message ?? msg).slice(0, 120);
                        }
                        if (/QueryAlreadyProcessed/.test(msg)) {
                            journal.done[t.txHash] = {tx: '(pre-existing)', block: 0, gas: '0'};
                            proven++;
                        } else {
                            journal.failed[t.txHash] = msg;
                            failed++;
                        }
                        checkpoint();
                    }),
            );

            const seen = proven + failed;
            if (seen && seen % 50 === 0) {
                const rate = seen / ((Date.now() - startedAt) / 1000);
                const left = (tasks.length - seen) / Math.max(rate, 0.01);
                console.log(
                    `  ${seen}/${tasks.length}  ok=${proven} fail=${failed}  ` +
                        `${rate.toFixed(2)}/s  eta ${(left / 60).toFixed(0)}m  inflight=${inflight.size}`,
                );
            }
        }
    }

    await Promise.all(Array.from({length: CONCURRENCY}, (_, i) => worker(i)));
    await drainTo(1);
    checkpoint(true);

    const onchain = await verifier.candleCount(pool);
    const mins = (Date.now() - startedAt) / 60000;
    console.log(`\n${'='.repeat(74)}`);
    console.log(`proven this run : ${proven}`);
    console.log(`failed          : ${failed}`);
    console.log(`elapsed         : ${mins.toFixed(1)} min`);
    console.log(`candles on-chain: ${onchain}`);
    console.log('='.repeat(74));
}

main().catch((e) => {
    console.error('❌', e.shortMessage ?? e.message ?? e);
    process.exit(1);
});
