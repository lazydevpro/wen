/**
 * Gated reveal data.
 *
 * The reveal files hold `eraLabel`, the accepted `answers`, and `hidden` — the future price path,
 * which is to say the winning band. Served as static assets they were one fetch away: `windows.json`
 * lists every window id, so `data/<id>.reveal.json` handed over the answer before a single bet was
 * placed. That is worse than the reverse-image-search the decision timer exists to prevent.
 *
 * So they are bundled into the Worker instead of uploaded (see web/.assetsignore) and released only
 * once the round that asked for them is `Settled` on-chain — meaning the bets are already committed
 * and can no longer be changed.
 *
 * KNOWN RESIDUAL: there are only six windows. Settling six minimum rounds harvests the entire
 * catalogue, after which every future hand is known. The gate raises the cost from "free and
 * instant" to "six antes", but the actual fix is many more windows, not a cleverer gate.
 */
import {Contract, JsonRpcProvider} from 'ethers';
import type {Env} from './index';

import windows from '../../web/data/windows.json';
import etf2024 from '../../web/data/etf-2024.reveal.json';
import ftx2022 from '../../web/data/ftx-2022.reveal.json';
import gasCrisis2021 from '../../web/data/gas-crisis-2021.reveal.json';
import luna2022 from '../../web/data/luna-2022.reveal.json';
import merge2022 from '../../web/data/merge-2022.reveal.json';
import preAth2021 from '../../web/data/pre-ath-2021.reveal.json';

const REVEALS: Record<string, unknown> = {
    'etf-2024': etf2024,
    'ftx-2022': ftx2022,
    'gas-crisis-2021': gasCrisis2021,
    'luna-2022': luna2022,
    'merge-2022': merge2022,
    'pre-ath-2021': preAth2021,
};

/** id -> the windowId the registry knows it by. */
const WINDOW_IDS = new Map<string, string>(
    (windows as Array<{id: string; windowId: string}>).map((w) => [w.id, w.windowId.toLowerCase()]),
);

const GAME_ABI = [
    'function rounds(uint256) view returns (address player, bytes32 windowId, uint8 state, uint64 startBlock, uint64 settledAt, uint128 ante, uint128 staked, uint128 paidOut)',
];

/** Round.state in GridGame.sol — bets are locked from Settled onward. */
const STATE_SETTLED = 2;

export async function handleReveal(env: Env, id: string, roundIdRaw: string | null) {
    const reveal = REVEALS[id];
    const windowId = WINDOW_IDS.get(id);
    if (!reveal || !windowId) {
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
    } catch (e: any) {
        return {status: 502, body: {error: 'could not read the round on-chain'}};
    }

    if (Number(round.state) < STATE_SETTLED) {
        return {status: 403, body: {error: 'bets are not locked in yet'}};
    }
    // The round must actually be on the window whose answer is being asked for.
    if (String(round.windowId).toLowerCase() !== windowId) {
        return {status: 403, body: {error: 'that round was not dealt this window'}};
    }

    return {status: 200, body: reveal as Record<string, unknown>};
}
