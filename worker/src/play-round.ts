/**
 * Plays a complete round against the deployed contracts — the whole loop end to end.
 *
 *   pnpm play-round
 *
 * deposit → startRound (window assigned on-chain, unknown until the receipt) → settleRound
 * → resolveRound. Proves the deal/settle/resolve flow works on CC3 Testnet.
 */
import {readFileSync} from 'node:fs';
import {formatEther, parseEther} from 'ethers';
import {cc3Provider, signer, gridGame, chartRegistry} from './lib/contracts.js';

// windows are public and keyed by windowId; reveals live outside web/ and are never served
const WINDOW_DIR = new URL('../../web/data/w/', import.meta.url).pathname;
const REVEAL_DIR = new URL('../data/reveals/', import.meta.url).pathname;

const ANTE = parseEther('1');

async function main() {
    const provider = cc3Provider();
    const wallet = signer(provider);
    const game = gridGame(wallet);
    const registry = chartRegistry(provider);

    console.log('='.repeat(72));
    console.log('PLAYING A FULL ROUND ON CC3 TESTNET');
    console.log('='.repeat(72));
    console.log(`player   : ${wallet.address}`);
    console.log(`game     : ${await game.getAddress()}`);
    console.log(`windows  : ${await registry.windowCount()}`);
    console.log(`bankroll : ${formatEther(await game.bankroll())} CTC`);
    console.log(`maxBet   : ${formatEther(await game.maxBet())} CTC\n`);

    // ---- 1. table credit ----
    let credit: bigint = await game.balances(wallet.address);
    console.log(`[1] credit: ${formatEther(credit)} CTC`);
    if (credit < ANTE * 3n) {
        console.log('    depositing 10 CTC...');
        await (await game.deposit({value: parseEther('10')})).wait();
        credit = await game.balances(wallet.address);
        console.log(`    credit now ${formatEther(credit)} CTC`);
    }

    // ---- 2. deal ----
    console.log(`\n[2] startRound(ante=${formatEther(ANTE)} CTC) — the window is unknown until this lands`);
    const dealTx = await game.startRound(ANTE);
    const dealRcpt = await dealTx.wait();

    const dealt = dealRcpt.logs
        .map((l: any) => { try { return game.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p && p.name === 'RoundDealt');
    if (!dealt) throw new Error('RoundDealt not emitted');

    const roundId: bigint = dealt.args.roundId;
    const windowId: string = dealt.args.windowId;
    const deadlineBlock: bigint = dealt.args.deadlineBlock;
    console.log(`    roundId       : ${roundId}`);
    console.log(`    windowId      : ${windowId}`);
    console.log(`    deadlineBlock : ${deadlineBlock}  (current ${await provider.getBlockNumber()})`);

    // which window did we get? exactly what the client does — fetch the one, by id
    const key = windowId.toLowerCase();
    const win = JSON.parse(readFileSync(`${WINDOW_DIR}${key}.json`, 'utf8'));
    console.log(`    dealt         : "${win.riddle}"`);
    console.log(`    (era withheld from the client until reveal)`);

    // ---- 3. bet ----
    const reveal = JSON.parse(readFileSync(`${REVEAL_DIR}${key}.json`, 'utf8'));
    const winningBand = reveal.outcome[0].p;
    const losingBand = winningBand === 0 ? 1 : 0;

    // one bet that hits, one that misses — proves both paths
    const multWin = await registry.multiplierAt(windowId, 0, winningBand);
    const multLose = await registry.multiplierAt(windowId, 1, losingBand);
    const cap: bigint = await game.maxRoundExposure();

    // Worst case is EVERY cell hitting, so the cap must be checked across all of them, not
    // just the one we expect to win. Edge bands routinely carry the 250x clamp, so a small
    // stake there can breach the cap on its own.
    let anteUse = ANTE;
    let loseStake = parseEther('0.5');
    const worst = () => (anteUse * BigInt(multWin) + loseStake * BigInt(multLose)) / 10000n;
    while (worst() > cap && loseStake > parseEther('0.001')) loseStake /= 2n;
    while (worst() > cap && anteUse > parseEther('0.02')) anteUse /= 2n;

    const ts = [0, 1];
    const ps = [winningBand, losingBand];
    const amts = [anteUse, loseStake];
    const staked = amts.reduce((a, b) => a + b, 0n);
    console.log(`    t0/band${winningBand} @ ${Number(multWin) / 1e4}x   t1/band${losingBand} @ ${Number(multLose) / 1e4}x`);
    console.log(`    worst-case payout ${formatEther(worst())} CTC vs cap ${formatEther(cap)} CTC`);

    if (staked < ANTE) throw new Error(`sized stake ${formatEther(staked)} fell below ante ${formatEther(ANTE)}`);
    console.log(`\n[3] settleRound — betting t0/band${winningBand} (hits) and t1/band${losingBand} (misses)`);
    console.log(`    staked: ${formatEther(staked)} CTC`);
    const settleRcpt = await (await game.settleRound(roundId, ts, ps, amts)).wait();
    console.log(`    settled in block ${settleRcpt.blockNumber}`);

    // ---- 4. resolve ----
    console.log(`\n[4] resolveRound — revealing hidden candles with Merkle proofs`);
    const h = reveal.hidden;
    const resolveRcpt = await (
        await game.resolveRound(
            roundId,
            h.map((c: any) => c.index),
            h.map((c: any) => c.b),
            h.map((c: any) => BigInt(c.sqrtPriceX96)),
            h.map((c: any) => c.proof),
        )
    ).wait();

    const resolved = resolveRcpt.logs
        .map((l: any) => { try { return game.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p && p.name === 'RoundResolved');
    const payout: bigint = resolved ? resolved.args.payout : 0n;

    const mult = multWin;
    const expected = (anteUse * BigInt(mult)) / 10000n;

    console.log(`    multiplier at t0/band${winningBand} : ${Number(mult) / 1e4}x`);
    console.log(`    expected payout : ${formatEther(expected)} CTC`);
    console.log(`    actual payout   : ${formatEther(payout)} CTC`);
    console.log(`    match           : ${payout === expected ? '✅' : '❌'}`);

    const after: bigint = await game.balances(wallet.address);
    console.log(`\n[5] credit after: ${formatEther(after)} CTC`);
    console.log(`    net this round : ${formatEther(payout - staked)} CTC`);
    console.log(`    era was        : ${reveal.eraLabel}`);

    console.log('\n' + '='.repeat(72));
    console.log(payout === expected ? '✅ FULL ROUND OK — deal, settle, resolve all on-chain' : '❌ payout mismatch');
    console.log('='.repeat(72) + '\n');
}

main().catch((e) => {
    console.error('❌', e.shortMessage ?? e.message ?? e);
    process.exit(1);
});
