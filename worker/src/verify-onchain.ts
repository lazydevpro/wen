/**
 * End-to-end check: read candles back off Creditcoin and confirm each one matches the real
 * Uniswap swap on Ethereum mainnet.
 *
 *   pnpm verify-onchain
 *
 * This is the whole thesis in one script — a Creditcoin contract holding prices it can prove
 * came from Ethereum, without ever trusting an oracle.
 */
import {JsonRpcProvider, Interface} from 'ethers';
import {cfg, DEFAULT_POOL} from './lib/config.js';
import {chartVerifier, cc3Provider} from './lib/contracts.js';
import {priceFromSqrtX96} from './lib/uniswap.js';

const swapIface = new Interface([
    'event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)',
]);
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

async function main() {
    const cc3 = cc3Provider();
    const eth = new JsonRpcProvider(cfg.ethRpc);
    const verifier = chartVerifier(cc3);
    const pool = DEFAULT_POOL;

    const count = Number(await verifier.candleCount(pool.address));
    console.log('='.repeat(78));
    console.log('VERIFYING ON-CHAIN CANDLES AGAINST ETHEREUM MAINNET');
    console.log('='.repeat(78));
    console.log(`verifier : ${await verifier.getAddress()}`);
    console.log(`pool     : ${pool.label}`);
    console.log(`candles  : ${count} recorded on Creditcoin\n`);

    console.log('  idx  eth block    creditcoin price   ethereum price   match');
    console.log('  ' + '-'.repeat(66));

    let ok = 0;
    for (let i = 0; i < count; i++) {
        const queryId = await verifier.candlesByPool(pool.address, i);
        const [sourceBlock, sqrtPriceX96] = await verifier.candles(queryId);

        const onchainPrice = priceFromSqrtX96(BigInt(sqrtPriceX96), pool);

        // independently re-read the same block from Ethereum
        const logs = await eth.getLogs({
            address: pool.address,
            topics: [SWAP_TOPIC],
            fromBlock: Number(sourceBlock),
            toBlock: Number(sourceBlock),
        });
        const prices = logs.map((l) => {
            const p = swapIface.parseLog({topics: [...l.topics], data: l.data})!;
            return priceFromSqrtX96(p.args.sqrtPriceX96, pool);
        });

        const match = prices.some((p) => Math.abs(p - onchainPrice) < 0.01);
        if (match) ok++;
        console.log(
            `  ${String(i).padStart(3)}  ${String(sourceBlock).padStart(10)}   ` +
                `$${onchainPrice.toFixed(2).padStart(12)}   ` +
                `$${(prices[0] ?? 0).toFixed(2).padStart(12)}   ${match ? '✅' : '❌'}`,
        );
    }

    console.log('\n' + '='.repeat(78));
    console.log(
        ok === count
            ? `✅ all ${count} candles on Creditcoin match real Ethereum mainnet history`
            : `❌ ${count - ok}/${count} mismatched`,
    );
    console.log('='.repeat(78) + '\n');
}

main().catch((e) => {
    console.error('❌', e.shortMessage ?? e.message ?? e);
    process.exit(1);
});
