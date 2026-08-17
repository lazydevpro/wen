import {Contract, JsonRpcProvider, Wallet} from 'ethers';
import {cfg} from './config.js';

export const CHART_VERIFIER_ABI = [
    'function registerPool(address pool,string label,uint8 token0Decimals,uint8 token1Decimals,bool invert) external',
    'function recordCandle(address pool,uint64 chainKey,uint64 blockHeight,bytes encodedTransaction,bytes32 merkleRoot,(bytes32 hash,bool isLeft)[] siblings,bytes32 lowerEndpointDigest,bytes32[] continuityRoots) external returns (bytes32)',
    'function candleCount(address pool) external view returns (uint256)',
    'function candles(bytes32) external view returns (uint64 sourceBlock,uint160 sqrtPriceX96,address pool)',
    'function pools(address) external view returns (bool enabled,uint8 token0Decimals,uint8 token1Decimals,bool invert,string label)',
    'event CandleVerified(address indexed pool,uint64 indexed sourceBlock,uint160 sqrtPriceX96,bytes32 indexed queryId)',
];

export const CHART_REGISTRY_ABI = [
    'function registerWindow((bytes32 windowId,bytes32 merkleRoot,uint160 anchorSqrtPriceX96,uint256 bandHeight,uint16 totalCandles,uint16 visibleCount,uint8 timeSteps,uint8 priceBands,bool invert,string eraLabel,bytes32 riddleHash,uint32[] multipliers,uint160[] visible) p) external',
    'function windowCount() external view returns (uint256)',
    'function windowIds(uint256) external view returns (bytes32)',
    'function exists(bytes32) external view returns (bool)',
    'function gridDims(bytes32) external view returns (uint8,uint8)',
    'function getMultipliers(bytes32) external view returns (uint32[])',
    'function getVisible(bytes32) external view returns (uint160[])',
    'function multiplierAt(bytes32,uint8,uint8) external view returns (uint32)',
    'function bandOf(bytes32,uint160) external view returns (int256)',
    'function verifyCandle(bytes32,uint256,uint64,uint160,bytes32[]) external view returns (bool)',
    'function windows(bytes32) external view returns (bool exists,bytes32 merkleRoot,uint160 anchorSqrtPriceX96,uint256 bandHeight,uint16 totalCandles,uint16 visibleCount,uint8 timeSteps,uint8 priceBands,bool invert,string eraLabel,bytes32 riddleHash)',
];

export const GRID_GAME_ABI = [
    'function fundBankroll() external payable',
    'function bankroll() external view returns (uint256)',
    'function maxBet() external view returns (uint256)',
    'function maxRoundExposure() external view returns (uint256)',
    'function paused() external view returns (bool)',
    'function openRound(bytes32 windowId,uint8[] ts,uint8[] ps,uint128[] amounts) external payable returns (uint256)',
    'function resolveRound(uint256 roundId,uint256[] indices,uint64[] blockNumbers,uint160[] sqrtPrices,bytes32[][] proofs) external',
    'function reclaim(uint256 roundId) external',
    'function rounds(uint256) external view returns (address player,bytes32 windowId,uint8 state,uint64 openedAt,uint128 staked,uint128 paidOut)',
    'function getBets(uint256) external view returns ((uint8 t,uint8 p,uint128 amount)[])',
    'function nextRoundId() external view returns (uint256)',
    'event RoundOpened(uint256 indexed roundId,address indexed player,bytes32 indexed windowId,uint256 staked)',
    'event RoundResolved(uint256 indexed roundId,address indexed player,uint256 payout)',
];

export function cc3Provider() {
    return new JsonRpcProvider(cfg.cc3Rpc);
}

export function signer(provider = cc3Provider()) {
    if (!cfg.deployerKey) throw new Error('DEPLOYER_PRIVATE_KEY not set');
    return new Wallet(cfg.deployerKey, provider);
}

export function chartVerifier(runner: any) {
    if (!cfg.chartVerifier) throw new Error('CHART_VERIFIER_ADDRESS not set');
    return new Contract(cfg.chartVerifier, CHART_VERIFIER_ABI, runner);
}

export function chartRegistry(runner: any) {
    if (!cfg.chartRegistry) throw new Error('CHART_REGISTRY_ADDRESS not set');
    return new Contract(cfg.chartRegistry, CHART_REGISTRY_ABI, runner);
}

export function gridGame(runner: any) {
    if (!cfg.gridGame) throw new Error('GRID_GAME_ADDRESS not set');
    return new Contract(cfg.gridGame, GRID_GAME_ABI, runner);
}
