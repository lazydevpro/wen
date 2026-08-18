/**
 * Rewrites the label, riddle and accepted answers on every generated window.
 *
 *   pnpm relabel-windows
 *
 * Slices inherit their era, and past about three weeks from the anchor event that inheritance
 * becomes a lie: a window eight weeks after the Luna collapse is not the Luna collapse, and the
 * riddle is the player's clue, so a false one is worse than a vague one. This dates each window
 * from its own first candle and applies `sliceMeta()`, which keeps the headline only while the
 * slice still covers it.
 *
 * Must run BEFORE export/register — riddleHash is committed on-chain, so editing a riddle after
 * registration would leave the stored hash pointing at text that no longer exists.
 *
 * Idempotent: safe to run repeatedly.
 */
import {JsonRpcProvider} from 'ethers';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {cfg} from './lib/config.js';
import {ERAS, sliceMeta} from './lib/eras.js';
import {mapLimit} from './lib/blocks.js';

const DIR = new URL('../data/windows/', import.meta.url).pathname;

async function main() {
    const eth = new JsonRpcProvider(cfg.ethRpc, undefined, {batchMaxCount: 1, staticNetwork: true});
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

    console.log('='.repeat(72));
    console.log(`RELABEL — ${files.length} windows`);
    console.log('='.repeat(72) + '\n');

    let onEra = 0;
    let quiet = 0;

    await mapLimit(files, 6, async (f) => {
        const win = JSON.parse(readFileSync(DIR + f, 'utf8'));
        // strip the -sN suffix to find the era this slice came from
        const eraId = String(win.id).replace(/-s\d+$/, '');
        const era = ERAS.find((e) => e.id === eraId);
        if (!era) {
            console.log(`  ⏭  ${win.id.padEnd(24)} no era named ${eraId}`);
            return;
        }

        const firstBlock = win.candles?.[0]?.blockNumber;
        if (!firstBlock) {
            console.log(`  ⏭  ${win.id.padEnd(24)} no candles`);
            return;
        }
        const ts = (await eth.getBlock(Number(firstBlock)))?.timestamp ?? 0;
        const when = new Date(ts * 1000);

        const meta = sliceMeta(era, win.id, when);
        win.era = {...win.era, label: meta.label, riddle: meta.riddle, answers: meta.answers};
        writeFileSync(DIR + f, JSON.stringify(win, null, 2));

        meta.onEra ? onEra++ : quiet++;
        console.log(`  ${meta.onEra ? '★' : '·'} ${String(win.id).padEnd(24)} ${meta.label}`);
    });

    console.log(`\n${'='.repeat(72)}`);
    console.log(`✅ ${onEra} keep their era headline, ${quiet} are unnamed stretches`);
    console.log('='.repeat(72) + '\n');
}

main().catch((e) => {
    console.error('❌', e.message ?? e);
    process.exit(1);
});
