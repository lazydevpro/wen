import 'dotenv/config';

function req(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`missing env var ${name}`);
    return v;
}

export const cfg = {
    ethRpc: req('ETH_MAINNET_RPC_URL'),
    cc3Rpc: req('CC3_RPC_URL'),
    proverApi: req('PROVER_API_URL'),
    chainKeyEth: Number(process.env.CHAINKEY_ETH_MAINNET ?? 3),
    deployerKey: process.env.DEPLOYER_PRIVATE_KEY,
    chartVerifier: process.env.CHART_VERIFIER_ADDRESS,
    chartRegistry: process.env.CHART_REGISTRY_ADDRESS,
    gridGame: process.env.GRID_GAME_ADDRESS,
};

/** Free-tier RPCs cap eth_getLogs at a 10-block range. */
export const LOG_CHUNK = 10;

/** Attestcoin batch limits (from the docs). */
export const MAX_BATCH_SIZE = 10;
export const MAX_BATCH_RANGE = 1000;

/** Uniswap V3 Swap(address,address,int256,int256,uint160,uint128,int24) */
export const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

export interface PoolSpec {
    address: string;
    label: string;
    token0Decimals: number;
    token1Decimals: number;
    /** true when the quote asset is token0, e.g. USDC/WETH -> price of WETH in USDC */
    invert: boolean;
    /** first block where this pool has usable liquidity */
    fromBlock: number;
}

/**
 * Deep USDC/WETH pools. The 0.05% tier carries most ETH volume and is the primary source.
 * NOTE: a single transaction often contains swaps across several of these (aggregator split
 * routes), which is exactly why ChartVerifier requires the caller to name the pool.
 */
export const POOLS: Record<string, PoolSpec> = {
    'usdc-weth-005': {
        address: '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640',
        label: 'USDC/WETH 0.05%',
        token0Decimals: 6,
        token1Decimals: 18,
        invert: true,
        fromBlock: 12_376_729, // pool creation, May 2021
    },
    'usdc-weth-001': {
        address: '0xE0554a476A092703abdB3Ef35c80e0D76d32939F',
        label: 'USDC/WETH 0.01%',
        token0Decimals: 6,
        token1Decimals: 18,
        invert: true,
        fromBlock: 15_240_000,
    },
};

export const DEFAULT_POOL = POOLS['usdc-weth-005'];

/**
 * The era catalogue lives in ./eras.ts — re-exported here so existing imports keep working.
 * Eras are anchored to dates rather than block numbers; call `blockForDate()` to resolve one.
 */
export {ERAS, type EraSpec} from './eras.js';
