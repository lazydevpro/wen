/**
 * Registers every generated window into ChartRegistry.
 *
 *   pnpm register-bulk           # everything not already on-chain
 *   pnpm register-bulk --dry     # show what would happen, send nothing
 *
 * Reads worker/data/windows/ directly rather than going via test fixtures — 120 windows should
 * not land in contracts/test/fixtures/.
 *
 * Registration is a commitment, not a proof: it stores the Merkle root, the grid multipliers and
 * the anchor. GridGame.resolveRound() later verifies each revealed candle against that root, so a
 * window whose data changed after registration simply stops resolving.
 *
 * Resumable — anything already on-chain is skipped, so a partial run just gets re-run.
 */
import {readdirSync, readFileSync} from 'node:fs';
import {formatEther} from 'ethers';
import {chartRegistry, cc3Provider, signer} from './lib/contracts.js';
import {registrationParams} from './lib/registration.js';

const DIR = new URL('../data/windows/', import.meta.url).pathname;

async function main() {
    const dry = process.argv.includes('--dry');
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

    const provider = cc3Provider();
    const wallet = signer(provider);
    const registry = chartRegistry(wallet);

    console.log('='.repeat(72));
    console.log(`REGISTER ${files.length} WINDOWS${dry ? '  (dry run)' : ''}`);
    console.log('='.repeat(72));
    console.log(`  registry : ${await registry.getAddress()}`);
    console.log(`  signer   : ${wallet.address}`);
    console.log(`  balance  : ${formatEther(await provider.getBalance(wallet.address))} CTC`);
    console.log(`  on-chain : ${await registry.windowCount()} already\n`);

    let sent = 0;
    let already = 0;
    let failed = 0;
    let gasTotal = 0n;

    // Sequential with an explicit nonce: the RPC's pending-nonce view lags behind a fast loop,
    // and two transactions sharing a nonce means one is silently dropped.
    let nonce = await provider.getTransactionCount(wallet.address, 'pending');

    for (const f of files) {
        const win = JSON.parse(readFileSync(DIR + f, 'utf8'));
        let p;
        try {
            p = registrationParams(win);
        } catch (e: any) {
            console.log(`  ❌ ${win.id.padEnd(24)} ${e.message}`);
            failed++;
            continue;
        }

        if (await registry.exists(p.windowId)) {
            already++;
            continue;
        }
        if (dry) {
            console.log(`  · ${win.id.padEnd(24)} would register ${p.windowId.slice(0, 12)}…  ${p.eraLabel}`);
            sent++;
            continue;
        }

        try {
            const tx = await registry.registerWindow(
                {
                    windowId: p.windowId,
                    merkleRoot: p.merkleRoot,
                    anchorSqrtPriceX96: BigInt(p.anchorSqrtPriceX96),
                    bandHeight: BigInt(p.bandHeightScaled),
                    totalCandles: p.totalCandles,
                    visibleCount: p.visibleCount,
                    timeSteps: p.timeSteps,
                    priceBands: p.priceBands,
                    invert: p.invert,
                    eraLabel: p.eraLabel,
                    riddleHash: p.riddleHash,
                    multipliers: p.multipliers,
                    visible: p.visibleSqrtPrices.map((s) => BigInt(s)),
                },
                {nonce: nonce++},
            );
            const rcpt = await tx.wait();
            gasTotal += rcpt?.gasUsed ?? 0n;
            sent++;
            console.log(`  ✅ ${win.id.padEnd(24)} block ${rcpt?.blockNumber}  gas ${rcpt?.gasUsed}  ${p.eraLabel}`);
        } catch (e: any) {
            failed++;
            console.log(`  ❌ ${win.id.padEnd(24)} ${(e.shortMessage ?? e.message ?? e).toString().slice(0, 70)}`);
            // resync — a revert leaves the nonce unconsumed
            nonce = await provider.getTransactionCount(wallet.address, 'pending');
        }
    }

    console.log(`\n${'='.repeat(72)}`);
    console.log(`✅ ${sent} registered, ${already} already on-chain, ${failed} failed`);
    if (gasTotal > 0n) console.log(`   gas used: ${gasTotal.toLocaleString()}`);
    if (!dry) console.log(`   registry now holds ${await registry.windowCount()} windows`);
    console.log('='.repeat(72) + '\n');
}

main().catch((e) => {
    console.error('❌', e.shortMessage ?? e.message ?? e);
    process.exit(1);
});
