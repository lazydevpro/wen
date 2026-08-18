/**
 * Confirms the frontend's ABI actually decodes real contract reverts.
 *
 *   pnpm test-reverts
 *
 * The web client had no `error` entries in its ABI, so every failed bet surfaced as
 * "unknown custom error". This triggers real reverts against the deployed contract using the
 * SAME ABI strings the frontend uses, and checks ethers populates `e.revert.name`.
 */
import {Contract, parseEther} from 'ethers';
import {cc3Provider, signer} from './lib/contracts.js';

const GRID_GAME = process.env.GRID_GAME_ADDRESS!;

/** Copied verbatim from web/app.js — if this decodes, the frontend decodes. */
const GAME_ABI = [
    'function deposit() external payable',
    'function balances(address) external view returns (uint256)',
    'function maxBet() external view returns (uint256)',
    'function maxRoundExposure() external view returns (uint256)',
    'function startRound(uint128 ante) external payable returns (uint256,bytes32)',
    'function settleRound(uint256 roundId,uint8[] ts,uint8[] ps,uint128[] amounts) external payable',
    'event RoundDealt(uint256 indexed roundId,address indexed player,bytes32 indexed windowId,uint128 ante,uint64 deadlineBlock)',
    'error InsufficientBalance(uint256 needed,uint256 have)',
    'error BetTooLarge(uint256 amount,uint256 maxBet)',
    'error StakeBelowAnte(uint256 staked,uint128 ante)',
    'error ExposureTooHigh(uint256 maxPayout,uint256 cap)',
    'error WrongRoundState(uint256 roundId)',
    'error DecisionWindowClosed(uint64 deadlineBlock,uint256 current)',
    'error AnteTooSmall()',
];

async function expectRevert(label: string, fn: () => Promise<any>) {
    try {
        await fn();
        console.log(`  ❌ ${label.padEnd(26)} did NOT revert`);
        return;
    } catch (e: any) {
        const name = e?.revert?.name ?? e?.info?.error?.data?.name;
        if (name) {
            const args = e.revert?.args ? `(${e.revert.args.map(String).join(', ').slice(0, 48)})` : '';
            console.log(`  ✅ ${label.padEnd(26)} → ${name}${args}`);
        } else {
            console.log(`  ⚠️  ${label.padEnd(26)} → UNDECODED: ${(e.shortMessage ?? e.message).slice(0, 60)}`);
        }
    }
}

async function main() {
    const wallet = signer(cc3Provider());
    const game = new Contract(GRID_GAME, GAME_ABI, wallet);

    console.log('='.repeat(70));
    console.log('REVERT DECODING — using the frontend ABI verbatim');
    console.log('='.repeat(70));
    console.log(`game: ${GRID_GAME}\n`);

    const maxBet: bigint = await game.maxBet();

    await expectRevert('ante = 0', () => game.startRound.staticCall(0));
    await expectRevert('ante over per-bet limit', () => game.startRound.staticCall(maxBet + parseEther('1')));
    await expectRevert('ante over credit', async () => {
        const bal: bigint = await game.balances(wallet.address);
        return game.startRound.staticCall(bal + parseEther('1000'));
    });
    await expectRevert('settle a non-existent round', () =>
        game.settleRound.staticCall(999999, [0], [0], [parseEther('1')]),
    );

    console.log('\n' + '='.repeat(70));
    console.log('If every line above is ✅, the frontend can explain failures to players.');
    console.log('='.repeat(70) + '\n');
}

main().catch((e) => {
    console.error('❌', e.shortMessage ?? e.message ?? e);
    process.exit(1);
});
