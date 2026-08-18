/**
 * Gated reveal data.
 *
 * A reveal holds `eraLabel`, the accepted `answers`, and `hidden` — the future price path, which
 * is to say the winning band. These are bundled into the Worker (see reveals.generated.ts) and
 * released only once the round asking for one is `Settled` on-chain, meaning the bets are
 * committed and can no longer change.
 *
 * They deliberately live outside web/, so they are not in the directory that gets published at
 * all. The previous arrangement kept them in the assets folder behind an .assetsignore rule,
 * which was one editing mistake away from serving every answer as a static file.
 *
 * The old six-window pool made harvesting trivial: six minimum rounds bought the entire
 * catalogue. At 120 non-overlapping windows that costs 120 settled rounds, and because the
 * client is now served one window at a time by id, the pool cannot be enumerated to know what
 * to harvest.
 */
import {Contract, JsonRpcProvider} from 'ethers';
import type {Env} from './index';
import {REVEALS, REVEAL_COUNT} from './reveals.generated';

const GAME_ABI = [
    'function rounds(uint256) view returns (address player, bytes32 windowId, uint8 state, uint64 startBlock, uint64 settledAt, uint128 ante, uint128 staked, uint128 paidOut)',
];

/** Round.state in GridGame.sol — bets are locked from Settled onward. */
const STATE_SETTLED = 2;

export {REVEAL_COUNT};

export async function handleReveal(env: Env, windowId: string, roundIdRaw: string | null) {
    const key = windowId.toLowerCase();
    const reveal = REVEALS[key];
    if (!reveal) {
        return {status: 404, body: {error: 'unknown window'}};
    }

    if (!roundIdRaw || !/^\d+$/.test(roundIdRaw) || roundIdRaw === '0') {
        return {status: 400, body: {error: 'roundId required'}};
    }

    const provider = new JsonRpcProvider(
        env.CC3_RPC_URL,
        {chainId: Number(env.CC3_CHAIN_ID ?? 102031), name: 'cc3-testnet'},
        {staticNetwork: true, batchMaxCount: 1},
    );
    const game = new Contract(env.GRID_GAME_ADDRESS, GAME_ABI, provider);

    let round: any;
    try {
        round = await game.rounds(BigInt(roundIdRaw));
    } catch {
        return {status: 502, body: {error: 'could not read the round on-chain'}};
    }

    if (Number(round.state) < STATE_SETTLED) {
        return {status: 403, body: {error: 'bets are not locked in yet'}};
    }
    // The round must actually be on the window whose answer is being asked for.
    if (String(round.windowId).toLowerCase() !== key) {
        return {status: 403, body: {error: 'that round was not dealt this window'}};
    }

    return {status: 200, body: reveal as Record<string, unknown>};
}
