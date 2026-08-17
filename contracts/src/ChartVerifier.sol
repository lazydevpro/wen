// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {USCBase} from "./usc/USCBase.sol";
import {INativeQueryVerifier} from "./usc/VerifierInterface.sol";
import {EvmV1Decoder} from "@gluwa/usc-contracts/contracts/decoding/EvmV1Decoder.sol";

/**
 * @title ChartVerifier
 * @notice Turns proven Ethereum transactions into verified price candles on Creditcoin.
 *
 * This is Hindsight's load-bearing Attestcoin surface. A candle is admitted only if the
 * Attestcoin precompile proves the transaction really was included in an attested Ethereum
 * block, AND the swap event came from a pool we recognise.
 *
 * Without this, "guess which era this chart is from" has no answer — anyone could fabricate
 * a chart. The proof is what makes the question answerable.
 *
 * @dev USCBase.execute() does not forward `blockHeight` to `_processAndEmitEvent`, and is not
 *      `virtual`, so it cannot be overridden. Rather than fork the vendored base contract we
 *      add our own entry point, `recordCandle`, which reuses USCBase's `_computeQueryId`,
 *      `_verifyProof` and `processedQueries` unchanged. `execute()` is therefore unusable here
 *      and reverts — see `_processAndEmitEvent`.
 */
contract ChartVerifier is USCBase {
    /// @dev keccak256("Swap(address,address,int256,int256,uint160,uint128,int24)") — Uniswap V3
    bytes32 public constant UNISWAP_V3_SWAP_TOPIC =
        0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67;

    /// @dev Byte offset of sqrtPriceX96 within the Swap payload.
    ///      Layout: amount0 (0..31) | amount1 (32..63) | sqrtPriceX96 (64..95) | liquidity | tick
    uint256 private constant SQRT_PRICE_OFFSET = 64;

    /// @dev A well-formed V3 Swap payload is exactly five 32-byte words.
    uint256 private constant SWAP_DATA_LEN = 160;

    struct Pool {
        bool enabled;
        uint8 token0Decimals;
        uint8 token1Decimals;
        /// @dev true when price should be read as token0-per-token1 (e.g. USDC/WETH → ETH in USDC)
        bool invert;
        string label;
    }

    struct Candle {
        uint64 sourceBlock;
        uint160 sqrtPriceX96;
        address pool;
    }

    address public owner;

    /// @notice Pools whose Swap events we accept. This is the security boundary: without it,
    ///         anyone deploys a contract, emits a lookalike Swap, and forges a chart.
    mapping(address => Pool) public pools;

    /// @notice Verified candles, keyed by Attestcoin queryId (unique per source transaction).
    mapping(bytes32 => Candle) public candles;

    /// @notice Candle ids per pool, in the order they were verified.
    mapping(address => bytes32[]) public candlesByPool;

    event PoolRegistered(address indexed pool, string label, uint8 token0Decimals, uint8 token1Decimals, bool invert);
    event PoolDisabled(address indexed pool);
    event CandleVerified(
        address indexed pool, uint64 indexed sourceBlock, uint160 sqrtPriceX96, bytes32 indexed queryId
    );

    error NotOwner();
    error UseRecordCandle();
    error QueryAlreadyProcessed(bytes32 queryId);
    error ProofVerificationFailed();
    error UnsupportedTransactionType(uint8 txType);
    error SourceTransactionFailed();
    error NoSwapEvent();
    error UnknownPool(address pool);
    error NoSwapFromPool(address pool);
    error MalformedSwapData(uint256 length);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    // ---------------------------------------------------------------- admin

    function registerPool(address pool, string calldata label, uint8 token0Decimals, uint8 token1Decimals, bool invert)
        external
        onlyOwner
    {
        pools[pool] =
            Pool({enabled: true, token0Decimals: token0Decimals, token1Decimals: token1Decimals, invert: invert, label: label});
        emit PoolRegistered(pool, label, token0Decimals, token1Decimals, invert);
    }

    function disablePool(address pool) external onlyOwner {
        pools[pool].enabled = false;
        emit PoolDisabled(pool);
    }

    // ---------------------------------------------------------------- views

    function candleCount(address pool) external view returns (uint256) {
        return candlesByPool[pool].length;
    }

    /// @notice Returns up to `limit` candles for `pool` starting at `offset`, for chart assembly.
    function getCandles(address pool, uint256 offset, uint256 limit) external view returns (Candle[] memory out) {
        bytes32[] storage ids = candlesByPool[pool];
        uint256 n = ids.length;
        if (offset >= n) return new Candle[](0);
        uint256 end = offset + limit;
        if (end > n) end = n;
        out = new Candle[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = candles[ids[i]];
        }
    }

    // ---------------------------------------------------------------- core

    /**
     * @notice Verify a proven Ethereum transaction and record the swap from `pool` as a candle.
     * @param pool The pool whose Swap event we want. REQUIRED because a single transaction can
     *        contain many swaps across many pools — aggregators routinely split a trade across
     *        several fee tiers. Taking the first Swap blindly reads a pool you never indexed.
     * @dev Mirrors USCBase.execute() but forwards `blockHeight` into the handler, which the base
     *      contract does not do. Reuses the base's verification and replay protection unchanged.
     */
    function recordCandle(
        address pool,
        uint64 chainKey,
        uint64 blockHeight,
        bytes calldata encodedTransaction,
        bytes32 merkleRoot,
        INativeQueryVerifier.MerkleProofEntry[] calldata siblings,
        bytes32 lowerEndpointDigest,
        bytes32[] calldata continuityRoots
    ) external returns (bytes32 queryId) {
        // THE FORGERY GUARD — only pools we registered may produce candles. Without this,
        // anyone deploys a contract emitting a lookalike Swap event and fabricates a chart.
        if (!pools[pool].enabled) revert UnknownPool(pool);

        queryId = _computeQueryId(chainKey, blockHeight, merkleRoot, siblings);
        if (processedQueries[queryId]) revert QueryAlreadyProcessed(queryId);

        bool verified = _verifyProof(
            chainKey, blockHeight, encodedTransaction, merkleRoot, siblings, lowerEndpointDigest, continuityRoots
        );
        if (!verified) revert ProofVerificationFailed();

        processedQueries[queryId] = true;
        _recordCandle(queryId, pool, blockHeight, encodedTransaction);
    }

    /// @dev Application-level validation. The inclusion proof is already verified by this point.
    function _recordCandle(bytes32 queryId, address pool, uint64 blockHeight, bytes memory encodedTransaction)
        private
    {
        // 1. Reject transaction types the decoder cannot handle.
        uint8 txType = EvmV1Decoder.getTransactionType(encodedTransaction);
        if (!EvmV1Decoder.isValidTransactionType(txType)) revert UnsupportedTransactionType(txType);

        // 2. The precompile does NOT check whether the source transaction succeeded.
        //    Skipping this would let reverted swaps become candles.
        EvmV1Decoder.ReceiptFields memory receipt = EvmV1Decoder.decodeReceiptFields(encodedTransaction);
        if (receipt.receiptStatus != 1) revert SourceTransactionFailed();

        // 3. Locate the Uniswap V3 Swap events.
        EvmV1Decoder.LogEntry[] memory swaps = EvmV1Decoder.getLogsByEventSignature(receipt, UNISWAP_V3_SWAP_TOPIC);
        if (swaps.length == 0) revert NoSwapEvent();

        // 4. Select the swap emitted by the requested pool. A transaction may hold several.
        uint160 sqrtPriceX96 = 0;
        bool found = false;
        for (uint256 i = 0; i < swaps.length; i++) {
            if (swaps[i].address_ != pool) continue;
            if (swaps[i].data.length < SWAP_DATA_LEN) revert MalformedSwapData(swaps[i].data.length);
            sqrtPriceX96 = _readSqrtPriceX96(swaps[i].data);
            found = true;
            break;
        }
        if (!found) revert NoSwapFromPool(pool);

        candles[queryId] = Candle({sourceBlock: blockHeight, sqrtPriceX96: sqrtPriceX96, pool: pool});
        candlesByPool[pool].push(queryId);

        emit CandleVerified(pool, blockHeight, sqrtPriceX96, queryId);
    }

    /// @dev Reads the uint160 sqrtPriceX96 at byte offset 64 of the Swap payload.
    function _readSqrtPriceX96(bytes memory data) private pure returns (uint160 sqrtPriceX96) {
        assembly {
            // skip the 32-byte length prefix, then advance to the third word
            sqrtPriceX96 := mload(add(add(data, 0x20), SQRT_PRICE_OFFSET))
        }
    }

    /// @dev USCBase requires this, but execute() cannot supply blockHeight, which a candle needs.
    ///      Callers must use recordCandle instead.
    function _processAndEmitEvent(uint8, bytes32, bytes memory) internal pure override {
        revert UseRecordCandle();
    }
}
