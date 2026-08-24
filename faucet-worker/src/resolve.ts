/**
 * Keeper: settles a round's payout so the player never has to sign for it.
 *
 * resolveRound is permissionless — it validates Merkle proofs, not callers — so there was never
 * a reason to make the player sign it. Doing so cost a third wallet prompt at the least
 * interesting moment in the game: after the chart has already played out and they know whether
 * they won. The result is drawn from the gated reveal, so from the player's side the outcome is
 * already on screen; this only moves the money.
 *
 * It is a best-effort accelerator, never the only path. If this fails, the client falls back to
 * letting the player resolve the round themselves — the money is theirs either way and the round
 * stays claimable by anyone until it is closed.
 *
 * Side benefit: an abandoned round (player closes the tab after settling) used to sit Settled
 * forever, holding its slice of outstandingExposure against the pool-wide cap. The keeper clears
 * those as a matter of course.
 */
import {Contract, JsonRpcProvider, Wallet} from 'ethers';
import type {Env} from './index';
import {REVEALS} from './reveals.generated';

const GAME_ABI = [
    // Mirrors the current Round struct exactly. It previously omitted maxPayout and still read
    // `state` correctly only because state sits at index 2 — luck, not design.
    'function rounds(uint256) view returns (address player, bytes32 windowId, uint8 state, uint64 startBlock, uint64 settledBlock, uint128 ante, uint128 staked, uint128 maxPayout, uint128 paidOut)',
    'function resolveRound(uint256 roundId,uint256[] indices,uint64[] blockNumbers,uint160[] sqrtPrices,bytes32[][] proofs) external',
    'error TooSoonToResolve(uint64 settledBlock,uint256 currentBlock)',
    'error WrongRoundState(uint256 roundId)',
];

const STATE_SETTLED = 2;
const STATE_RESOLVED = 3;

export async function handleResolve(env: Env, roundIdRaw: string | null) {
    if (!roundIdRaw || !/^\d+$/.test(roundIdRaw) || roundIdRaw === '0') {
        return {status: 400, body: {error: 'roundId required'}};
    }
    if (!env.KEEPER_PRIVATE_KEY) {
        return {status: 503, body: {error: 'keeper not configured'}};
    }

    const provider = new JsonRpcProvider(
        env.CC3_RPC_URL,
        {chainId: Number(env.CC3_CHAIN_ID ?? 102031), name: 'cc3-testnet'},
        {staticNetwork: true, batchMaxCount: 1},
    );
    const wallet = new Wallet(env.KEEPER_PRIVATE_KEY, provider);
    const game = new Contract(env.GRID_GAME_ADDRESS, GAME_ABI, wallet);

    let round: any;
    try {
        round = await game.rounds(BigInt(roundIdRaw));
    } catch {
        return {status: 502, body: {error: 'could not read the round'}};
    }

    if (Number(round.state) === STATE_RESOLVED) {
        return {status: 200, body: {ok: true, already: true}};
    }
    if (Number(round.state) !== STATE_SETTLED) {
        return {status: 409, body: {error: 'round is not settled'}};
    }

    const reveal: any = REVEALS[String(round.windowId).toLowerCase()];
    if (!reveal) {
        return {status: 404, body: {error: 'no reveal for that window'}};
    }

    // Resolution must land strictly after the settling block, so the same transaction can never
    // deal, bet and collect. Wait it out rather than burning gas on a certain revert.
    const deadline = Date.now() + 40_000;
    while ((await provider.getBlockNumber()) <= Number(round.settledBlock)) {
        if (Date.now() > deadline) {
            return {status: 504, body: {error: 'timed out waiting for the next block'}};
        }
        await new Promise((r) => setTimeout(r, 1500));
    }

    const h = reveal.hidden;
    try {
        const tx = await game.resolveRound(
            BigInt(roundIdRaw),
            h.map((c: any) => BigInt(c.index)),
            h.map((c: any) => BigInt(c.b)),
            h.map((c: any) => BigInt(c.sqrtPriceX96)),
            h.map((c: any) => c.proof),
        );
        const rcpt = await tx.wait();
        return {status: 200, body: {ok: true, tx: rcpt?.hash}};
    } catch (e: any) {
        // The player can always resolve it themselves; say so rather than pretending it worked.
        return {status: 502, body: {error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 140)}};
    }
}
