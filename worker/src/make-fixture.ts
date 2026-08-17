/**
 * Dumps a REAL Attestcoin proof to contracts/test/fixtures/ so Foundry tests can run
 * against genuine proven data rather than synthetic encodings.
 */
import 'dotenv/config';
import {writeFileSync, mkdirSync} from 'node:fs';
import {JsonRpcProvider, Interface} from 'ethers';
import {proofProvider, chainInfo} from '@gluwa/usc-sdk';

const ETH_RPC = process.env.ETH_MAINNET_RPC_URL!;
const CC3_RPC = process.env.CC3_RPC_URL!;
const PROVER_API = process.env.PROVER_API_URL!;
const CHAINKEY_ETH = Number(process.env.CHAINKEY_ETH_MAINNET ?? 3);

const POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

const swapIface = new Interface([
    'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);

async function main() {
    const eth = new JsonRpcProvider(ETH_RPC);
    const cc3 = new JsonRpcProvider(CC3_RPC);
    const builder = new proofProvider.service.ProofBuilder(CHAINKEY_ETH, PROVER_API);
    const info = new chainInfo.PrecompileChainInfoProvider(cc3);

    const {height} = await info.getLatestAttestedHeightAndHash(CHAINKEY_ETH);
    const attested = Number(height);

    // A recent swap, safely inside the attested range and inside free-tier getLogs limits.
    let log: any = null;
    for (let i = 1; i <= 12 && !log; i++) {
        const to = attested - i * 10;
        const logs = await eth.getLogs({address: POOL, topics: [SWAP_TOPIC], fromBlock: to - 9, toBlock: to});
        if (logs.length) log = logs[0];
    }
    if (!log) throw new Error('no swap found');

    const res = await builder.getProof(log.transactionHash);
    if (!res.success || !res.data) throw new Error(`proof failed: ${res.error}`);
    const d = res.data;

    const parsed = swapIface.parseLog({topics: [...log.topics], data: log.data})!;

    const fixture = {
        _comment: 'REAL Attestcoin proof captured from CC3 Testnet. Regenerate with: pnpm fixture',
        capturedAt: new Date().toISOString(),
        txHash: d.txHash,
        chainKey: d.chainKey,
        blockHeight: d.headerNumber,
        txIndex: d.txIndex,
        pool: POOL,
        expectedSqrtPriceX96: parsed.args.sqrtPriceX96.toString(),
        expectedTick: Number(parsed.args.tick),
        txBytes: d.txBytes,
        merkleRoot: d.merkleProof.root,
        // flat parallel arrays — trivial for forge's vm.parseJson to read
        siblingHashes: d.merkleProof.siblings.map((s: any) => s.hash),
        siblingIsLeft: d.merkleProof.siblings.map((s: any) => s.isLeft),
        lowerEndpointDigest: d.continuityProof.lowerEndpointDigest,
        continuityRoots: d.continuityProof.roots,
    };

    const dir = new URL('../../contracts/test/fixtures/', import.meta.url).pathname;
    mkdirSync(dir, {recursive: true});
    const path = `${dir}real-swap-proof.json`;
    writeFileSync(path, JSON.stringify(fixture, null, 2));

    console.log(`✅ fixture written: ${path}`);
    console.log(`   tx            : ${fixture.txHash}`);
    console.log(`   block         : ${fixture.blockHeight}`);
    console.log(`   sqrtPriceX96  : ${fixture.expectedSqrtPriceX96}`);
    console.log(`   txBytes       : ${(fixture.txBytes.length - 2) / 2} bytes`);
    console.log(`   siblings      : ${fixture.siblingHashes.length}`);
    console.log(`   continuity    : ${fixture.continuityRoots.length} roots`);
}

main().catch((e) => {
    console.error('❌', e.message ?? e);
    process.exit(1);
});
