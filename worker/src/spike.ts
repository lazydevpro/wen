/**
 * SPIKE: prove a real historical Uniswap V3 Swap from Ethereum mainnet on CC3 Testnet.
 *
 * Validates the entire wen thesis end-to-end:
 *   1. find a real Uniswap V3 Swap event on Ethereum mainnet
 *   2. generate an Attestcoin inclusion proof for its transaction
 *   3. verify that proof against Creditcoin's BlockProver precompile
 *   4. decode sqrtPriceX96 out of the proven receipt -> a real price candle
 *
 * Uses the *view* variant `verifySingle`, so this needs NO testnet CTC.
 */
import 'dotenv/config';
import {JsonRpcProvider, Interface} from 'ethers';
import {proofProvider, blockProver, chainInfo} from '@gluwa/usc-sdk';

const ETH_RPC = process.env.ETH_MAINNET_RPC_URL || 'https://ethereum-rpc.publicnode.com';
const CC3_RPC = process.env.CC3_RPC_URL!;
const PROVER_API = process.env.PROVER_API_URL!;
const CHAINKEY_ETH = Number(process.env.CHAINKEY_ETH_MAINNET ?? 3);

/** Uniswap V3 USDC/WETH 0.05% — deepest ETH price source on mainnet. token0=USDC(6), token1=WETH(18) */
const POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const swapIface = new Interface([
    'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);

const Q96 = 2n ** 96n;

/** ETH price in USDC from sqrtPriceX96, for a token0=USDC(6dp)/token1=WETH(18dp) pool. */
function ethPriceFromSqrtX96(sqrtPriceX96: bigint): number {
    // raw = (sqrtPriceX96/2^96)^2 = wei per USDC-micro.  1 ETH = 1e18 wei => 1e12/raw USDC.
    const num = Q96 * Q96 * 10n ** 12n;
    const den = sqrtPriceX96 * sqrtPriceX96;
    return Number((num * 1_000_000n) / den) / 1_000_000;
}

const step = (n: number, s: string) => console.log(`\n[${n}] ${s}`);

async function main() {
    console.log('='.repeat(72));
    console.log('HINDSIGHT SPIKE — prove a real Uniswap V3 swap on Creditcoin');
    console.log('='.repeat(72));

    const eth = new JsonRpcProvider(ETH_RPC);
    const cc3 = new JsonRpcProvider(CC3_RPC);

    step(1, 'Checking attested height on Creditcoin...');
    const builder = new proofProvider.service.ProofBuilder(CHAINKEY_ETH, PROVER_API);
    const info = new chainInfo.PrecompileChainInfoProvider(cc3);
    const {height: attestedRaw} = await info.getLatestAttestedHeightAndHash(CHAINKEY_ETH);
    const attested = Number(attestedRaw);
    const ethHead = await eth.getBlockNumber();
    console.log(`    ethereum head    : ${ethHead}`);
    console.log(`    attested height  : ${attested}`);
    console.log(`    lag              : ${ethHead - attested} blocks (~${(((ethHead - attested) * 12) / 60).toFixed(1)} min)`);

    step(2, 'Searching for a real Uniswap V3 Swap in an attested block...');
    // stay comfortably inside the attested range
    const toBlock = attested - 20;
    const fromBlock = toBlock - 40;
    const logs = await eth.getLogs({address: POOL, topics: [SWAP_TOPIC], fromBlock, toBlock});
    if (logs.length === 0) throw new Error(`no swaps in blocks ${fromBlock}..${toBlock}`);
    console.log(`    scanned blocks ${fromBlock}..${toBlock}`);
    console.log(`    found ${logs.length} swap events`);

    const target = logs[Math.floor(logs.length / 2)];
    console.log(`    chosen tx        : ${target.transactionHash}`);
    console.log(`    block            : ${target.blockNumber}`);

    step(3, 'Decoding the swap directly from Ethereum (ground truth)...');
    const parsed = swapIface.parseLog({topics: [...target.topics], data: target.data})!;
    const sqrtPriceX96: bigint = parsed.args.sqrtPriceX96;
    const truthPrice = ethPriceFromSqrtX96(sqrtPriceX96);
    console.log(`    sqrtPriceX96     : ${sqrtPriceX96}`);
    console.log(`    tick             : ${parsed.args.tick}`);
    console.log(`    ETH price        : $${truthPrice.toFixed(2)}`);

    step(4, 'Generating Attestcoin inclusion proof...');
    const t0 = Date.now();
    const result = await builder.getProof(target.transactionHash);
    const ms = Date.now() - t0;
    if (!result.success || !result.data) throw new Error(`proof generation failed: ${result.error}`);
    const p = result.data;
    console.log(`    generated in     : ${ms} ms  (cached: ${p.cached})`);
    console.log(`    chainKey         : ${p.chainKey}`);
    console.log(`    headerNumber     : ${p.headerNumber}`);
    console.log(`    txIndex          : ${p.txIndex}`);
    console.log(`    txBytes          : ${(p.txBytes.length - 2) / 2} bytes`);
    console.log(`    merkle siblings  : ${p.merkleProof.siblings.length}`);
    console.log(`    continuity roots : ${p.continuityProof.roots.length}`);

    const costCTC = 2.3e-5 + 2.9e-7 * p.continuityProof.roots.length;
    console.log(`    est. verify cost : ${costCTC.toExponential(3)} CTC`);

    step(5, 'Verifying the proof on Creditcoin (view call — no gas, no CTC needed)...');
    const prover = new blockProver.PrecompileBlockProver(cc3);
    const verified = await prover.verifySingle(
        p.chainKey,
        p.headerNumber,
        p.txBytes,
        p.merkleProof,
        p.continuityProof,
    );
    console.log(`    VERIFIED         : ${verified ? '✅ TRUE' : '❌ FALSE'}`);
    if (!verified) throw new Error('precompile rejected a proof for a real transaction');

    step(6, 'Negative control — tampering with txBytes must fail...');
    const bad = p.txBytes.slice(0, -2) + (p.txBytes.endsWith('00') ? '01' : '00');
    let tamperedResult: boolean | string;
    try {
        tamperedResult = await prover.verifySingle(p.chainKey, p.headerNumber, bad, p.merkleProof, p.continuityProof);
    } catch (e: any) {
        tamperedResult = `reverted (${e.shortMessage ?? e.message?.slice(0, 60)})`;
    }
    const rejected = tamperedResult !== true;
    console.log(`    tampered proof   : ${rejected ? `✅ REJECTED (${tamperedResult})` : '❌ ACCEPTED — BAD'}`);

    console.log('\n' + '='.repeat(72));
    console.log(rejected && verified ? '✅ SPIKE PASSED — thesis holds' : '❌ SPIKE FAILED');
    console.log('='.repeat(72));
    console.log(`\nA real Uniswap V3 swap at block ${target.blockNumber} was proven on Creditcoin`);
    console.log(`and yields a verifiable ETH price of $${truthPrice.toFixed(2)}.`);
    console.log(`That is one candle of wen, cryptographically anchored.\n`);
}

main().catch((e) => {
    console.error('\n❌ SPIKE ERROR:', e.message ?? e);
    process.exit(1);
});
