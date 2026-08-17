// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ChartVerifier} from "../src/ChartVerifier.sol";
import {INativeQueryVerifier} from "../src/usc/VerifierInterface.sol";

/**
 * Tests run against a REAL Attestcoin proof captured from CC3 Testnet
 * (test/fixtures/real-swap-proof.json — regenerate with `pnpm fixture` in worker/).
 *
 * The precompile does not exist in the local EVM, so it is mocked. Everything downstream —
 * receipt decoding, swap extraction, the forgery guard, sqrtPriceX96 parsing — runs against
 * genuine mainnet bytes.
 */
contract ChartVerifierTest is Test {
    ChartVerifier internal verifier;

    address internal constant PRECOMPILE = 0x0000000000000000000000000000000000000FD2;
    address internal constant ATTACKER = address(0xBAD);

    // ---- fixture ----
    uint64 internal chainKey;
    uint64 internal blockHeight;
    address internal pool;
    uint256 internal expectedSqrtPriceX96;
    bytes internal txBytes;
    bytes32 internal merkleRoot;
    bytes32 internal lowerEndpointDigest;
    bytes32[] internal continuityRoots;
    INativeQueryVerifier.MerkleProofEntry[] internal siblings;

    function setUp() public {
        string memory json = vm.readFile("test/fixtures/real-swap-proof.json");

        chainKey = uint64(vm.parseJsonUint(json, ".chainKey"));
        blockHeight = uint64(vm.parseJsonUint(json, ".blockHeight"));
        pool = vm.parseJsonAddress(json, ".pool");
        expectedSqrtPriceX96 = vm.parseJsonUint(json, ".expectedSqrtPriceX96");
        txBytes = vm.parseJsonBytes(json, ".txBytes");
        merkleRoot = vm.parseJsonBytes32(json, ".merkleRoot");
        lowerEndpointDigest = vm.parseJsonBytes32(json, ".lowerEndpointDigest");
        continuityRoots = vm.parseJsonBytes32Array(json, ".continuityRoots");

        bytes32[] memory hashes = vm.parseJsonBytes32Array(json, ".siblingHashes");
        bool[] memory isLeft = vm.parseJsonBoolArray(json, ".siblingIsLeft");
        assertEq(hashes.length, isLeft.length, "fixture sibling arrays must align");
        for (uint256 i = 0; i < hashes.length; i++) {
            siblings.push(INativeQueryVerifier.MerkleProofEntry({hash: hashes[i], isLeft: isLeft[i]}));
        }

        verifier = new ChartVerifier();
        _mockPrecompile(true, uint64(vm.parseJsonUint(json, ".txIndex")));
    }

    /// @dev Mock the Attestcoin precompile: proof verification result + txIndex for queryId.
    function _mockPrecompile(bool verified, uint64 txIndex) internal {
        vm.mockCall(
            PRECOMPILE, abi.encodeWithSelector(INativeQueryVerifier.verifyAndEmit.selector), abi.encode(verified)
        );
        vm.mockCall(
            PRECOMPILE, abi.encodeWithSelector(INativeQueryVerifier.calculateTxIndex.selector), abi.encode(txIndex)
        );
    }

    function _record() internal returns (bytes32) {
        return _recordFor(pool);
    }

    function _recordFor(address p) internal returns (bytes32) {
        return verifier.recordCandle(
            p, chainKey, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots
        );
    }

    // ------------------------------------------------------------ happy path

    function test_RecordsCandleFromRealProof() public {
        verifier.registerPool(pool, "USDC/WETH 0.05%", 6, 18, true);

        bytes32 queryId = _record();

        (uint64 srcBlock, uint160 sqrtPriceX96, address candlePool) = verifier.candles(queryId);
        assertEq(srcBlock, blockHeight, "source block");
        assertEq(uint256(sqrtPriceX96), expectedSqrtPriceX96, "sqrtPriceX96 must match Ethereum ground truth");
        assertEq(candlePool, pool, "pool");
        assertEq(verifier.candleCount(pool), 1, "candle count");

        console.log("decoded sqrtPriceX96:", uint256(sqrtPriceX96));
        console.log("expected            :", expectedSqrtPriceX96);
    }

    function test_GetCandlesReturnsSeries() public {
        verifier.registerPool(pool, "USDC/WETH 0.05%", 6, 18, true);
        _record();

        ChartVerifier.Candle[] memory series = verifier.getCandles(pool, 0, 10);
        assertEq(series.length, 1);
        assertEq(uint256(series[0].sqrtPriceX96), expectedSqrtPriceX96);
    }

    // -------------------------------------------------- the security guards

    /// The forgery guard. Without it, anyone deploys a contract emitting a lookalike
    /// Swap event and fabricates a chart.
    function test_RevertsOnUnregisteredPool() public {
        // deliberately do NOT register the pool
        vm.expectRevert(abi.encodeWithSelector(ChartVerifier.UnknownPool.selector, pool));
        _record();
    }

    function test_RevertsWhenPoolDisabled() public {
        verifier.registerPool(pool, "USDC/WETH 0.05%", 6, 18, true);
        verifier.disablePool(pool);

        vm.expectRevert(abi.encodeWithSelector(ChartVerifier.UnknownPool.selector, pool));
        _record();
    }

    /// USCBase replay protection must hold — the same proof cannot mint two candles.
    function test_RevertsOnReplay() public {
        verifier.registerPool(pool, "USDC/WETH 0.05%", 6, 18, true);
        bytes32 queryId = _record();

        vm.expectRevert(abi.encodeWithSelector(ChartVerifier.QueryAlreadyProcessed.selector, queryId));
        _record();
    }

    function test_RevertsWhenPrecompileRejectsProof() public {
        verifier.registerPool(pool, "USDC/WETH 0.05%", 6, 18, true);
        _mockPrecompile(false, 53); // precompile says "not verified"

        vm.expectRevert(ChartVerifier.ProofVerificationFailed.selector);
        _record();
    }

    /// execute() cannot supply blockHeight, so it must be unusable rather than silently wrong.
    function test_ExecuteIsDisabled() public {
        verifier.registerPool(pool, "USDC/WETH 0.05%", 6, 18, true);

        vm.expectRevert(ChartVerifier.UseRecordCandle.selector);
        verifier.execute(0, chainKey, blockHeight, txBytes, merkleRoot, siblings, lowerEndpointDigest, continuityRoots);
    }

    // ------------------------------------------------------------ ownership

    function test_OnlyOwnerCanRegisterPool() public {
        vm.prank(ATTACKER);
        vm.expectRevert(ChartVerifier.NotOwner.selector);
        verifier.registerPool(pool, "malicious", 6, 18, true);
    }

    function test_OnlyOwnerCanDisablePool() public {
        verifier.registerPool(pool, "USDC/WETH 0.05%", 6, 18, true);

        vm.prank(ATTACKER);
        vm.expectRevert(ChartVerifier.NotOwner.selector);
        verifier.disablePool(pool);
    }

    // ------------------------------------------------- multi-pool regression

    /// REGRESSION: the fixture transaction is an aggregator split-route containing TWO V3 swaps
    /// (USDC/WETH 0.01% at logIndex 92 and 0.05% at logIndex 95). An earlier version took
    /// swaps[0] blindly and silently recorded a price from a pool it never indexed.
    function test_SelectsSwapFromRequestedPoolNotFirstInTx() public {
        address otherPool = 0xE0554a476A092703abdB3Ef35c80e0D76d32939F; // 0.01% tier, logIndex 92
        verifier.registerPool(pool, "USDC/WETH 0.05%", 6, 18, true);

        bytes32 queryId = _record();
        (,, address recorded) = verifier.candles(queryId);

        assertEq(recorded, pool, "must record the requested pool");
        assertTrue(recorded != otherPool, "must not silently use the first swap in the tx");
    }

    /// A registered pool that took no part in this transaction must not yield a candle.
    function test_RevertsWhenPoolNotInTransaction() public {
        address unrelated = address(0xDEAD);
        verifier.registerPool(unrelated, "unrelated pool", 6, 18, true);

        vm.expectRevert(abi.encodeWithSelector(ChartVerifier.NoSwapFromPool.selector, unrelated));
        _recordFor(unrelated);
    }

    // ------------------------------------------------------------- sanity

    /// Guards against a silent regression in the assembly offset for sqrtPriceX96.
    function test_SqrtPriceIsPlausibleEthPrice() public {
        verifier.registerPool(pool, "USDC/WETH 0.05%", 6, 18, true);
        bytes32 queryId = _record();
        (, uint160 sqrtPriceX96,) = verifier.candles(queryId);

        // ETH$ = 1e12 / (sqrtPriceX96/2^96)^2, for token0=USDC(6dp) / token1=WETH(18dp)
        uint256 q96 = 2 ** 96;
        uint256 ethPrice = (q96 * q96 * 1e12) / (uint256(sqrtPriceX96) * uint256(sqrtPriceX96));
        console.log("implied ETH price (USD):", ethPrice);

        assertGt(ethPrice, 100, "ETH price implausibly low - offset likely wrong");
        assertLt(ethPrice, 100_000, "ETH price implausibly high - offset likely wrong");
    }
}
