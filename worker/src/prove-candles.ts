/**
 * Proves a window's candles on-chain through Attestcoin.
 *
 *   pnpm prove-candles luna-2022 [limit]
 *
 * For each candle we take the Uniswap swap transaction it was folded from, generate an
 * Attestcoin inclusion proof, and submit it to ChartVerifier.recordCandle. The contract
 * re-verifies the proof against the BlockProver precompile, checks the source transaction
 * succeeded, confirms the Swap event came from an allowlisted pool, and only then records
 * the price.
 *
 * This is the load-bearing Attestcoin path: without it, "which era is this?" has no
 * answer, because nothing would stop the operator fabricating a chart.
 *
 * Progress is journalled so a restart never double-submits.
 */
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'node:fs';
import {proofProvider} from '@gluwa/usc-sdk';
import {cfg, DEFAULT_POOL} from './lib/config.js';
import {chartVerifier, cc3Provider, signer} from './lib/contracts.js';

const WINDOW_DIR = new URL('../data/windows/', import.meta.url).pathname;
const STATE_DIR = new URL('../data/proofs/', import.meta.url).pathname;

interface Journal {
    windowId: string;
    done: Record<string, {queryId: string; txHash: string; block: number}>;
    failed: Record<string, string>;
}

function loadJournal(id: string): Journal {
    mkdirSync(STATE_DIR, {recursive: true});
    const p = `${STATE_DIR}${id}.json`;
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    return {windowId: id, done: {}, failed: {}};
}

const saveJournal = (j: Journal) => writeFileSync(`${STATE_DIR}${j.windowId}.json`, JSON.stringify(j, null, 2));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const id = process.argv[2];
    const limit = Number(process.argv[3] ?? 0);
    if (!id) {
        console.error('usage: pnpm prove-candles <windowId> [limit]');
        process.exit(1);
    }

    const win = JSON.parse(readFileSync(`${WINDOW_DIR}${id}.json`, 'utf8'));
    const journal = loadJournal(id);

    const provider = cc3Provider();
    const wallet = signer(provider);
    const verifier = chartVerifier(wallet);
    // Deep-history proofs can carry ~1000 continuity roots and take well over the SDK's
    // 100s default to generate. Raise it or old candles fail intermittently.
    const builder = new proofProvider.service.ProofBuilder(cfg.chainKeyEth, cfg.proverApi, 300_000);
    const pool = DEFAULT_POOL.address;

    const candles = limit > 0 ? win.candles.slice(0, limit) : win.candles;

    console.log('='.repeat(70));
    console.log(`PROVING CANDLES — ${win.era.label}`);
    console.log('='.repeat(70));
    console.log(`verifier : ${await verifier.getAddress()}`);
    console.log(`pool     : ${pool}`);
    console.log(`candles  : ${candles.length}  (already done: ${Object.keys(journal.done).length})\n`);

    let proven = 0;
    let skipped = 0;
    let failed = 0;

    for (const c of candles) {
        const key = String(c.index);
        if (journal.done[key]) {
            skipped++;
            continue;
        }

        process.stdout.write(`  #${String(c.index).padStart(2)} block ${c.blockNumber} ... `);

        try {
            let res = await builder.getProof(c.txHash);
            if (!res.success) {
                await sleep(1500); // transient prover-API timeouts are common on deep history
                res = await builder.getProof(c.txHash);
            }
            if (!res.success || !res.data) throw new Error(res.error ?? 'proof generation failed');
            const p = res.data;

            const siblings = p.merkleProof.siblings.map((s: any) => ({hash: s.hash, isLeft: s.isLeft}));

            const tx = await verifier.recordCandle(
                pool,
                p.chainKey,
                p.headerNumber,
                p.txBytes,
                p.merkleProof.root,
                siblings,
                p.continuityProof.lowerEndpointDigest,
                p.continuityProof.roots,
            );
            const rcpt = await tx.wait();

            journal.done[key] = {queryId: '', txHash: rcpt!.hash, block: rcpt!.blockNumber};
            saveJournal(journal);
            proven++;
            console.log(`✅ roots=${p.continuityProof.roots.length} gas=${rcpt!.gasUsed}`);
        } catch (e: any) {
            const msg = (e.shortMessage ?? e.message ?? String(e)).slice(0, 90);
            journal.failed[key] = msg;
            saveJournal(journal);
            failed++;
            console.log(`❌ ${msg}`);
            await sleep(600);
        }
    }

    const onchain = await verifier.candleCount(pool);
    console.log(`\n${'='.repeat(70)}`);
    console.log(`proven this run : ${proven}`);
    console.log(`already done    : ${skipped}`);
    console.log(`failed          : ${failed}`);
    console.log(`candles on-chain for this pool: ${onchain}`);
    console.log('='.repeat(70));
}

main().catch((e) => {
    console.error('❌', e.shortMessage ?? e.message ?? e);
    process.exit(1);
});
