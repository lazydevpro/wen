/**
 * Registers exported windows into ChartRegistry on CC3 Testnet.
 *
 *   pnpm register-windows            # all exported fixtures
 *   pnpm register-windows luna-2022
 */
import {readFileSync, readdirSync} from 'node:fs';
import {chartRegistry, cc3Provider, signer} from './lib/contracts.js';

const FIXTURE_DIR = new URL('../../contracts/test/fixtures/', import.meta.url).pathname;

async function main() {
    const only = process.argv[2];
    const files = readdirSync(FIXTURE_DIR)
        .filter((f) => f.startsWith('window-') && f.endsWith('.json'))
        .filter((f) => !only || f === `window-${only}.json`);

    if (files.length === 0) {
        console.error('no window fixtures found — run `pnpm export-window <id>` first');
        process.exit(1);
    }

    const provider = cc3Provider();
    const wallet = signer(provider);
    const registry = chartRegistry(wallet);

    console.log(`registry : ${await registry.getAddress()}`);
    console.log(`signer   : ${wallet.address}`);
    console.log(`windows  : ${files.length}\n`);

    for (const f of files) {
        const w = JSON.parse(readFileSync(FIXTURE_DIR + f, 'utf8'));

        if (await registry.exists(w.windowId)) {
            console.log(`⏭  ${w.eraLabel} — already registered`);
            continue;
        }

        const params = {
            windowId: w.windowId,
            merkleRoot: w.merkleRoot,
            anchorSqrtPriceX96: BigInt(w.anchorSqrtPriceX96),
            bandHeight: BigInt(w.bandHeightScaled),
            totalCandles: w.totalCandles,
            visibleCount: w.visibleCount,
            timeSteps: w.timeSteps,
            priceBands: w.priceBands,
            invert: w.invert,
            eraLabel: w.eraLabel,
            riddleHash: w.riddleHash,
            multipliers: w.multipliers,
            visible: w.visibleSqrtPrices.map((s: string) => BigInt(s)),
        };

        process.stdout.write(`▶  ${w.eraLabel} ... `);
        const tx = await registry.registerWindow(params);
        const rcpt = await tx.wait();
        console.log(`✅ block ${rcpt?.blockNumber}  gas ${rcpt?.gasUsed}`);
    }

    const count = await registry.windowCount();
    console.log(`\n✅ registry now holds ${count} window(s)`);
}

main().catch((e) => {
    console.error('❌', e.shortMessage ?? e.message ?? e);
    process.exit(1);
});
