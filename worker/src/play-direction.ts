/**
 * Plays a full round in SIMPLE (up/down) mode against the deployed contracts.
 *
 *   pnpm play-direction        # bets the way the window actually went
 *   pnpm play-direction wrong  # bets the other way, to prove a loss pays nothing
 *
 * The counterpart to play-round.ts. Same blind deal, same forfeit clock — only the settle
 * differs. Deliberately never calls deposit(): the stake rides along as value.
 */
import {readFileSync} from 'node:fs';
import {formatEther, parseEther} from 'ethers';
import {cc3Provider, signer, gridGame, chartRegistry} from './lib/contracts.js';

const WINDOW_DIR = new URL('../../web/data/w/', import.meta.url).pathname;
const REVEAL_DIR = new URL('../data/reveals/', import.meta.url).pathname;
const ANTE = parseEther('1');

async function main() {
    const betWrong = process.argv[2] === 'wrong';
    const provider = cc3Provider();
    const wallet = signer(provider);
    const game = gridGame(wallet);
    const registry = chartRegistry(provider);

    console.log('='.repeat(72));
    console.log(`SIMPLE MODE — betting ${betWrong ? 'the WRONG way on purpose' : 'the way it actually went'}`);
    console.log('='.repeat(72));
    console.log(`up pays ${Number(await game.DIRECTION_UP_MULT()) / 1e4}x   down pays ${Number(await game.DIRECTION_DOWN_MULT()) / 1e4}x\n`);

    const credit: bigint = await game.balances(wallet.address);
    const short = ANTE > credit ? ANTE - credit : 0n;
    console.log(`[1] startRound(${formatEther(ANTE)} CTC) attaching ${formatEther(short)}`);
    const rcpt = await (await game.startRound(ANTE, {value: short})).wait();
    const dealt = rcpt.logs
        .map((l: any) => { try { return game.interface.parseLog(l); } catch { return null; } })
        .find((p: any) => p && p.name === 'RoundDealt');
    const roundId: bigint = dealt.args.roundId;
    const windowId: string = dealt.args.windowId;
    const key = windowId.toLowerCase();
    const win = JSON.parse(readFileSync(`${WINDOW_DIR}${key}.json`, 'utf8'));
    console.log(`    round ${roundId} — "${win.riddle}"`);

    // which way did it really go? the reveal is server-side truth; the contract decides for itself
    const reveal = JSON.parse(readFileSync(`${REVEAL_DIR}${key}.json`, 'utf8'));
    const closed = reveal.hidden[reveal.hidden.length - 1].c;
    const reallyUp = closed > win.anchorPrice;
    const bet = betWrong ? !reallyUp : reallyUp;
    console.log(`    anchor $${win.anchorPrice.toFixed(2)} -> closed $${closed.toFixed(2)}  (really ${reallyUp ? 'UP' : 'DOWN'})`);

    console.log(`\n[2] settleDirection(${bet ? 'UP' : 'DOWN'}, ${formatEther(ANTE)} CTC)`);
    await (await game.settleDirection(roundId, bet, ANTE, {value: 0n})).wait();

    console.log(`\n[3] resolveRound — the contract works the direction out from the proven candles`);
    const h = reveal.hidden;
    const before: bigint = await game.balances(wallet.address);
    await (
        await game.resolveRound(
            roundId,
            h.map((c: any) => c.index),
            h.map((c: any) => c.b),
            h.map((c: any) => BigInt(c.sqrtPriceX96)),
            h.map((c: any) => c.proof),
        )
    ).wait();
    const after: bigint = await game.balances(wallet.address);
    const payout = after - before;

    const mult = bet ? await game.DIRECTION_UP_MULT() : await game.DIRECTION_DOWN_MULT();
    const expected = bet === reallyUp ? (ANTE * BigInt(mult)) / 10000n : 0n;
    console.log(`    payout   : ${formatEther(payout)} CTC`);
    console.log(`    expected : ${formatEther(expected)} CTC`);
    console.log(`    match    : ${payout === expected ? '✅' : '❌'}`);
    console.log(`\n    era was  : ${reveal.eraLabel}`);
    console.log('\n' + '='.repeat(72));
    console.log(payout === expected ? '✅ SIMPLE MODE OK' : '❌ MISMATCH');
    console.log('='.repeat(72) + '\n');
    if (payout !== expected) process.exit(1);
}

main().catch((e) => { console.error('❌', e.shortMessage ?? e.message ?? e); process.exit(1); });
