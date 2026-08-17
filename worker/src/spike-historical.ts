/**
 * SPIKE 3 — THE CRITICAL ONE.
 *
 * Can Attestcoin prove a transaction from YEARS ago? The docs claim no lookback limit
 * (provable back to block 1) and a cost that only rises past ~90 days. Hindsight lives
 * or dies on this: if we can't prove 2021, there is no game.
 *
 * Probes several eras and reports proof size, continuity length, cost and verification.
 * Still view calls — no CTC spent.
 */
import 'dotenv/config';
import {JsonRpcProvider, Interface} from 'ethers';
import {proofProvider, blockProver, chainInfo} from '@gluwa/usc-sdk';

const ETH_RPC = process.env.ETH_MAINNET_RPC_URL!;
const CC3_RPC = process.env.CC3_RPC_URL!;
const PROVER_API = process.env.PROVER_API_URL!;
const CHAINKEY_ETH = Number(process.env.CHAINKEY_ETH_MAINNET ?? 3);

const POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640'; // Uniswap V3 USDC/WETH 0.05%
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const swapIface = new Interface([
    'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);
const Q96 = 2n ** 96n;
const price = (s: bigint) => Number(((Q96 * Q96 * 10n ** 12n) * 1_000_000n) / (s * s)) / 1_000_000;

/** Eras worth playing, with an anchor block for each. */
const ERAS = [
    {name: 'Oct 2021 — pre-ATH run-up', block: 13_314_560},
    {name: 'May 2022 — Luna collapse', block: 14_770_000},
    {name: 'Sep 2022 — the Merge', block: 15_537_400},
    {name: 'Nov 2022 — FTX collapse', block: 15_950_000},
    {name: 'Mar 2024 — ETF era', block: 19_400_000},
];

/** Find a swap at/after `from`, scanning in 10-block chunks (free-tier getLogs limit). */
async function findSwap(eth: JsonRpcProvider, from: number, maxChunks = 40) {
    for (let i = 0; i < maxChunks; i++) {
        const a = from + i * 10;
        const logs = await eth.getLogs({address: POOL, topics: [SWAP_TOPIC], fromBlock: a, toBlock: a + 9});
        if (logs.length) return logs[0];
    }
    return null;
}

async function main() {
    console.log('='.repeat(76));
    console.log('HINDSIGHT SPIKE 3 — can we prove HISTORY? (the whole game depends on this)');
    console.log('='.repeat(76));

    const eth = new JsonRpcProvider(ETH_RPC);
    const cc3 = new JsonRpcProvider(CC3_RPC);
    const builder = new proofProvider.service.ProofBuilder(CHAINKEY_ETH, PROVER_API);
    const prover = new blockProver.PrecompileBlockProver(cc3);
    const info = new chainInfo.PrecompileChainInfoProvider(cc3);

    const {height} = await info.getLatestAttestedHeightAndHash(CHAINKEY_ETH);
    const attested = Number(height);
    const genesis = await info.getAttestationGenesisHeight(CHAINKEY_ETH);
    console.log(`\nattested height        : ${attested}`);
    console.log(`attestation genesis    : ${genesis}   ${genesis === 0 ? '← claims full history' : ''}`);

    const rows: string[] = [];
    for (const era of ERAS) {
        console.log(`\n${'─'.repeat(76)}`);
        console.log(`▶ ${era.name}  (block ~${era.block.toLocaleString()})`);

        const log = await findSwap(eth, era.block);
        if (!log) {
            console.log('  ⚠️  no swap found in scan range — skipping');
            continue;
        }
        const parsed = swapIface.parseLog({topics: [...log.topics], data: log.data})!;
        const p = price(parsed.args.sqrtPriceX96);
        console.log(`  swap tx     : ${log.transactionHash}`);
        console.log(`  block       : ${log.blockNumber.toLocaleString()}   ETH $${p.toLocaleString(undefined, {maximumFractionDigits: 2})}`);

        const ageBlocks = attested - log.blockNumber;
        console.log(`  age         : ${ageBlocks.toLocaleString()} blocks (~${(ageBlocks * 12 / 86400).toFixed(0)} days)`);

        const t0 = Date.now();
        const res = await builder.getProof(log.transactionHash);
        const ms = Date.now() - t0;

        if (!res.success || !res.data) {
            console.log(`  ❌ PROOF FAILED after ${ms}ms: ${res.error}`);
            rows.push(`| ${era.name} | ${log.blockNumber.toLocaleString()} | — | — | ❌ FAILED |`);
            continue;
        }
        const d = res.data;
        const roots = d.continuityProof.roots.length;
        const cost = 2.3e-5 + 2.9e-7 * roots;
        console.log(`  proof gen   : ${ms} ms (cached: ${d.cached})`);
        console.log(`  continuity  : ${roots} roots`);
        console.log(`  merkle sibs : ${d.merkleProof.siblings.length}`);
        console.log(`  txBytes     : ${(d.txBytes.length - 2) / 2} bytes`);
        console.log(`  est. cost   : ${cost.toExponential(3)} CTC`);

        let ok = false;
        try {
            ok = await prover.verifySingle(d.chainKey, d.headerNumber, d.txBytes, d.merkleProof, d.continuityProof);
        } catch (e: any) {
            console.log(`  ⚠️  verify threw: ${e.shortMessage ?? e.message?.slice(0, 80)}`);
        }
        console.log(`  VERIFIED    : ${ok ? '✅ TRUE' : '❌ FALSE'}`);
        rows.push(
            `| ${era.name} | ${log.blockNumber.toLocaleString()} | $${p.toFixed(0)} | ${roots} | ${cost.toExponential(2)} CTC | ${ok ? '✅' : '❌'} |`,
        );
    }

    console.log('\n' + '='.repeat(76));
    console.log('SUMMARY');
    console.log('='.repeat(76));
    console.log('| era | block | ETH | continuity roots | cost | verified |');
    console.log('|---|---|---|---|---|---|');
    rows.forEach((r) => console.log(r));
    console.log('');
}

main().catch((e) => {
    console.error('\n❌ ERROR:', e.message ?? e);
    process.exit(1);
});
