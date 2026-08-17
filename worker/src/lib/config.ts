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
 * Playable eras. On-chain price data only exists from ~2021 (Uniswap V3 launched May 2021),
 * so the genesis-era romance is unreachable — see docs/plans/spec.md.
 *
 * `riddle` names the era through what happened, never when.
 */
export interface EraSpec {
    id: string;
    label: string;
    startBlock: number;
    riddle: string;
    /** answer accepted for the era-guess bonus, lowercase substrings */
    answers: string[];
}

export const ERAS: EraSpec[] = [
    {
        id: 'pre-ath-2021',
        label: 'October 2021 — the run to the all-time high',
        startBlock: 13_314_560,
        riddle: 'Everything was going up, and everyone had already decided it would keep going up.',
        answers: ['2021', 'oct 2021', 'october 2021', 'bull'],
    },
    {
        id: 'luna-2022',
        label: 'May 2022 — Luna collapses',
        startBlock: 14_770_000,
        riddle: 'Something that promised to always be worth a dollar stopped being worth a dollar.',
        answers: ['2022', 'may 2022', 'luna', 'terra', 'ust'],
    },
    {
        id: 'merge-2022',
        label: 'September 2022 — the Merge',
        startBlock: 15_537_400,
        riddle: 'The way blocks got made changed forever, and the price barely noticed.',
        answers: ['2022', 'sep 2022', 'september 2022', 'merge', 'pos'],
    },
    {
        id: 'ftx-2022',
        label: 'November 2022 — FTX collapses',
        startBlock: 15_950_000,
        riddle: 'An exchange everyone trusted turned out to be holding nothing at all.',
        answers: ['2022', 'nov 2022', 'november 2022', 'ftx', 'sbf', 'alameda'],
    },
    {
        id: 'etf-2024',
        label: 'March 2024 — the ETF era',
        startBlock: 19_400_000,
        riddle: 'Wall Street finally got a wrapper it was allowed to buy.',
        answers: ['2024', 'mar 2024', 'march 2024', 'etf'],
    },
    {
        id: 'gas-crisis-2021',
        label: 'May 2021 — peak gas',
        startBlock: 12_500_000,
        riddle: 'The chain worked fine. Everyone just stopped being able to afford it.',
        answers: ['2021', 'may 2021', 'gas'],
    },
];
