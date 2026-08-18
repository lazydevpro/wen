/**
 * SPIKE 2: batch-prove many Uniswap V3 swaps with ONE shared continuity proof.
 *
 * This is the economics of wen — a chart needs many candles, and each candle
 * needs a proven swap. If batching works, a window costs ~1 continuity proof instead of N.
 *
 * Constraints from the docs: MAX_BATCH_SIZE = 10, MAX_BATCH_RANGE = 1000 blocks.
 * Still a view call, so no CTC required.
 */
import 'dotenv/config';
import {JsonRpcProvider, Interface} from 'ethers';
import {proofProvider, blockProver, chainInfo} from '@gluwa/usc-sdk';

const ETH_RPC = process.env.ETH_MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const CC3_RPC = process.env.CC3_RPC_URL!;
const PROVER_API = process.env.PROVER_API_URL!;
const CHAINKEY_ETH = Number(process.env.CHAINKEY_ETH_MAINNET ?? 3);

const POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const BATCH_SIZE = 10;

const swapIface = new Interface([
    'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);

const Q96 = 2n ** 96n;
function ethPriceFromSqrtX96(s: bigint): number {
    return Number(((Q96 * Q96 * 10n ** 12n) * 1_000_000n) / (s * s)) / 1_000_000;
}

async function main() {
    console.log('='.repeat(72));
    console.log('HINDSIGHT SPIKE 2 — batch proof (candle economics)');
    console.log('='.repeat(72));

    const eth = new JsonRpcProvider(ETH_RPC);
    const cc3 = new JsonRpcProvider(CC3_RPC);
    const builder = new proofProvider.service.ProofBuilder(CHAINKEY_ETH, PROVER_API);
    const info = new chainInfo.PrecompileChainInfoProvider(cc3);

    const {height} = await info.getLatestAttestedHeightAndHash(CHAINKEY_ETH);
    const attested = Number(height);

    // Collect BATCH_SIZE swaps, each from a distinct block, inside one 1000-block window.
    // ~0.4 swaps/block on this pool, so ~50 blocks yields 10+ distinct blocks.
    // NOTE: public RPCs treat anything >~128 blocks from head as an "archive" request and
    // reject it. Scanning historical eras (2021 etc.) REQUIRES an archive provider —
    // set ETH_MAINNET_RPC_URL to an Alchemy/Infura endpoint. Free tiers include archive.
    const toBlock = attested - 5;
    const fromBlock = toBlock - 50;
    console.log(`\nScanning blocks ${fromBlock}..${toBlock} for swaps...`);
    const logs = await eth.getLogs({address: POOL, topics: [SWAP_TOPIC], fromBlock, toBlock});
    console.log(`  found ${logs.length} swap events`);

    const seen = new Set<number>();
    const picked = logs.filter((l) => !seen.has(l.blockNumber) && seen.add(l.blockNumber)).slice(0, BATCH_SIZE);
    console.log(`  picked ${picked.length} swaps across distinct blocks`);
    console.log(`  block span: ${picked[0].blockNumber} .. ${picked[picked.length - 1].blockNumber}`);

    console.log('\nGenerating batch proof...');
    const t0 = Date.now();
    const res = await builder.getBatchProof(picked.map((l) => l.transactionHash));
    const ms = Date.now() - t0;
    if (!res.success || !res.data) throw new Error(`batch proof failed: ${res.error}`);
    const d = res.data;

    console.log(`  generated in       : ${ms} ms (cached: ${d.cached})`);
    console.log(`  header range       : ${d.fromHeader} .. ${d.toHeader}`);
    console.log(`  SHARED continuity  : ${d.continuityProof.roots.length} roots for all ${picked.length} txs`);

    // Flatten the nested Map<height, Map<txIndex, entry>> into ordered arrays.
    const heights: number[] = [];
    const txBytesArr: string[] = [];
    const merkleProofs: any[] = [];
    for (const [h, inner] of d.merkleProofs) {
        for (const [, entry] of inner) {
            heights.push(Number(h));
            txBytesArr.push(entry.txBytes);
            merkleProofs.push(entry.merkleProof);
        }
    }
    console.log(`  flattened          : ${heights.length} proofs`);

    const singleCost = picked.length * (2.3e-5 + 2.9e-7 * d.continuityProof.roots.length);
    const batchCost = 2.3e-5 + 2.9e-7 * d.continuityProof.roots.length;
    console.log(`  cost if separate   : ~${singleCost.toExponential(3)} CTC`);
    console.log(`  cost as batch      : ~${batchCost.toExponential(3)} CTC  (${(singleCost / batchCost).toFixed(1)}x cheaper)`);

    console.log('\nVerifying batch on Creditcoin (view call, no gas)...');
    const prover = new blockProver.PrecompileBlockProver(cc3);
    const ok = await prover.verifyBatch(CHAINKEY_ETH, heights, txBytesArr, merkleProofs, d.continuityProof);
    console.log(`  BATCH VERIFIED     : ${ok ? '✅ TRUE' : '❌ FALSE'}`);

    console.log('\nCandles extracted from the proven batch:');
    for (const l of picked) {
        const p = swapIface.parseLog({topics: [...l.topics], data: l.data})!;
        const price = ethPriceFromSqrtX96(p.args.sqrtPriceX96);
        console.log(`  block ${l.blockNumber}  →  $${price.toFixed(2)}`);
    }

    console.log('\n' + '='.repeat(72));
    console.log(ok ? '✅ BATCH SPIKE PASSED — candle economics work' : '❌ BATCH SPIKE FAILED');
    console.log('='.repeat(72) + '\n');
}

main().catch((e) => {
    console.error('\n❌ ERROR:', e.message ?? e);
    process.exit(1);
});
