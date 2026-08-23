/**
 * Plays a complete round against the deployed contracts — the whole loop end to end.
 *
 *   pnpm play-round
 *
 * startRound (window assigned on-chain, unknown until the receipt) → settleRound → resolveRound.
 *
 * Deliberately NEVER calls deposit(): both round entry points are payable and any stake the
 * table credit does not cover rides along as value, which is the whole point — a fresh faucet
 * wallet plays with no separate funding step. This script is the proof of that flow.
 */
import {readFileSync} from 'node:fs';
import {formatEther, parseEther} from 'ethers';
import {cc3Provider, signer, gridGame, chartRegistry} from './lib/contracts.js';

// windows are public and keyed by windowId; reveals live outside web/ and are never served
const WINDOW_DIR = new URL('../../web/data/w/', import.meta.url).pathname;
const REVEAL_DIR = new URL('../data/reveals/', import.meta.url).pathname;

const ANTE = parseEther('1');

/** windowOf() reverts until the block after the deal is strictly in the past — the draw derives
 *  from that block's hash, which is exactly why a dealing transaction cannot peek at it. */
async function awaitWindow(game: any, roundId: bigint, timeoutMs = 90_000): Promise<string> {
    const started = Date.now();
    for (;;) {
        try {
            return await game.windowOf(roundId);
        } catch (e) {
            if (Date.now() - started > timeoutMs) throw new Error('draw did not settle in time');
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
}

/** Resolution must land strictly after the settling block, so one transaction can never deal,
 *  bet and collect. Wait for the chain to move on before revealing. */
async function nextBlock(provider: any, after: number) {
    for (;;) {
        if ((await provider.getBlockNumber()) > after) return;
        await new Promise((r) => setTimeout(r, 2000));
    }
}

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

    // ---- 1. table credit (informational only — we never deposit) ----
    let credit: bigint = await game.balances(wallet.address);
    console.log(`[1] credit: ${formatEther(credit)} CTC — no deposit will be made`);

    // ---- 2. deal, attaching whatever credit does not cover ----
    const anteShort = ANTE > credit ? ANTE - credit : 0n;
    console.log(`\n[2] startRound(ante=${formatEther(ANTE)} CTC) with ${formatEther(anteShort)} CTC attached`);
    const dealTx = await game.startRound(ANTE, {value: anteShort});
    const dealRcpt = await dealTx.wait();

    const dealt = dealRcpt.logs
        .map((l: any) => { try { return game.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p && p.name === 'RoundDealt');
    if (!dealt) throw new Error('RoundDealt not emitted');

    const roundId: bigint = dealt.args.roundId;
    const deadlineBlock: bigint = dealt.args.deadlineBlock;
    process.stdout.write('    waiting for the draw (window derives from the NEXT block) ... ');
    const windowId: string = await awaitWindow(game, roundId);
    console.log('ok');
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
    // A column whose price left the grid has p = -1 and no cell to bet; pick the first column
    // that actually landed somewhere, or there is nothing to demonstrate.
    const winIdx = reveal.outcome.findIndex((o: any) => o.p >= 0);
    if (winIdx < 0) throw new Error('this window never lands inside the grid — try again');
    const winningBand = reveal.outcome[winIdx].p;
    const loseIdx = winIdx === 0 ? 1 : 0;
    const losingBand = winningBand === 0 ? 1 : 0;

    // one bet that hits, one that misses — proves both paths
    const multWin = await registry.multiplierAt(windowId, winIdx, winningBand);
    const multLose = await registry.multiplierAt(windowId, loseIdx, losingBand);
    const cap: bigint = await game.maxRoundExposure();

    // Worst case is EVERY cell hitting, so the cap must be checked across all of them, not
    // just the one we expect to win. Edge bands routinely carry the 250x clamp, so a small
    // stake there can breach the cap on its own.
    let anteUse = ANTE;
    let loseStake = parseEther('0.5');
    const worst = () => (anteUse * BigInt(multWin) + loseStake * BigInt(multLose)) / 10000n;
    while (worst() > cap && loseStake > parseEther('0.001')) loseStake /= 2n;
    while (worst() > cap && anteUse > parseEther('0.02')) anteUse /= 2n;

    const ts = [winIdx, loseIdx];
    const ps = [winningBand, losingBand];
    const amts = [anteUse, loseStake];
    const staked = amts.reduce((a, b) => a + b, 0n);
    console.log(`    t${winIdx}/band${winningBand} @ ${Number(multWin) / 1e4}x   t${loseIdx}/band${losingBand} @ ${Number(multLose) / 1e4}x`);
    console.log(`    worst-case payout ${formatEther(worst())} CTC vs cap ${formatEther(cap)} CTC`);

    if (staked < ANTE) throw new Error(`sized stake ${formatEther(staked)} fell below ante ${formatEther(ANTE)}`);
    console.log(`\n[3] settleRound — betting t${winIdx}/band${winningBand} (hits) and t${loseIdx}/band${losingBand} (misses)`);
    console.log(`    staked: ${formatEther(staked)} CTC`);
    // the ante is already held by the round; attach only what credit misses of the difference
    credit = await game.balances(wallet.address);
    const extra = staked > ANTE ? staked - ANTE : 0n;
    const settleShort = extra > credit ? extra - credit : 0n;
    console.log(`    attaching ${formatEther(settleShort)} CTC (credit covers the rest)`);
    const settleRcpt = await (await game.settleRound(roundId, ts, ps, amts, {value: settleShort})).wait();
    console.log(`    settled in block ${settleRcpt.blockNumber}`);

    // ---- 4. resolve ----
    await nextBlock(provider, settleRcpt.blockNumber);
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
