// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ChartRegistry} from "../src/ChartRegistry.sol";
import {GridGame} from "../src/GridGame.sol";

/**
 * Tests ChartRegistry + GridGame against a REAL exported Hindsight window
 * (test/fixtures/window-*.json — regenerate with `pnpm export-window <id>` in worker/).
 *
 * The most important assertion here is test_BandMathMatchesTypeScript: if Solidity's bandOf()
 * disagrees with the worker's, resolution pays the wrong cells and the whole game is broken.
 */
contract HindsightGameTest is Test {
    ChartRegistry internal registry;
    GridGame internal game;

    address internal constant PLAYER = address(0xA11CE);
    address internal constant ATTACKER = address(0xBAD);

    string internal json;
    bytes32 internal windowId;
    uint8 internal timeSteps;
    uint8 internal priceBands;
    uint32[] internal multipliers;

    /// bands the TypeScript implementation computed for each hidden candle
    int256[] internal expectedBands;

    function setUp() public {
        json = vm.readFile("test/fixtures/window-luna-2022.json");

        windowId = vm.parseJsonBytes32(json, ".windowId");
        timeSteps = uint8(vm.parseJsonUint(json, ".timeSteps"));
        priceBands = uint8(vm.parseJsonUint(json, ".priceBands"));

        uint256[] memory mults = vm.parseJsonUintArray(json, ".multipliers");
        for (uint256 i = 0; i < mults.length; i++) multipliers.push(uint32(mults[i]));

        uint256[] memory visRaw = vm.parseJsonUintArray(json, ".visibleSqrtPrices");
        uint160[] memory visible = new uint160[](visRaw.length);
        for (uint256 i = 0; i < visRaw.length; i++) visible[i] = uint160(visRaw[i]);

        registry = new ChartRegistry();
        registry.registerWindow(
            ChartRegistry.RegisterParams({
                windowId: windowId,
                merkleRoot: vm.parseJsonBytes32(json, ".merkleRoot"),
                anchorSqrtPriceX96: uint160(vm.parseJsonUint(json, ".anchorSqrtPriceX96")),
                bandHeight: vm.parseJsonUint(json, ".bandHeightScaled"),
                totalCandles: uint16(vm.parseJsonUint(json, ".totalCandles")),
                visibleCount: uint16(vm.parseJsonUint(json, ".visibleCount")),
                timeSteps: timeSteps,
                priceBands: priceBands,
                invert: vm.parseJsonBool(json, ".invert"),
                eraLabel: vm.parseJsonString(json, ".eraLabel"),
                riddleHash: vm.parseJsonBytes32(json, ".riddleHash"),
                multipliers: multipliers,
                visible: visible
            })
        );

        for (uint256 t = 0; t < timeSteps; t++) {
            expectedBands.push(vm.parseJsonInt(json, string.concat(".hidden[", vm.toString(t), "].expectedBand")));
        }

        game = new GridGame(registry);
        vm.deal(address(this), 10_000 ether);
        game.fundBankroll{value: 4_000 ether}();
        vm.deal(PLAYER, 100 ether);
    }

    // ---- fixture helpers ----

    function _hidden(uint256 t)
        internal
        view
        returns (uint256 index, uint64 blockNumber, uint160 sqrtPrice, bytes32[] memory proof)
    {
        string memory base = string.concat(".hidden[", vm.toString(t), "]");
        index = vm.parseJsonUint(json, string.concat(base, ".index"));
        blockNumber = uint64(vm.parseJsonUint(json, string.concat(base, ".blockNumber")));
        sqrtPrice = uint160(vm.parseJsonUint(json, string.concat(base, ".sqrtPriceX96")));
        proof = vm.parseJsonBytes32Array(json, string.concat(base, ".proof"));
    }

    function _revealAll()
        internal
        view
        returns (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs)
    {
        idx = new uint256[](timeSteps);
        bns = new uint64[](timeSteps);
        sps = new uint160[](timeSteps);
        prs = new bytes32[][](timeSteps);
        for (uint256 t = 0; t < timeSteps; t++) {
            (idx[t], bns[t], sps[t], prs[t]) = _hidden(t);
        }
    }

    // =================================================== THE CRITICAL TEST

    /// If Solidity and TypeScript disagree on which band a price lands in, the game pays the
    /// wrong cells. Cross-check every hidden candle in the window.
    function test_BandMathMatchesTypeScript() public view {
        for (uint256 t = 0; t < timeSteps; t++) {
            (,, uint160 sqrtPrice,) = _hidden(t);
            int256 onchain = registry.bandOf(windowId, sqrtPrice);
            assertEq(onchain, expectedBands[t], string.concat("band mismatch at t=", vm.toString(t)));
            console.log("t=%s  solidity=%s  typescript=%s", t, uint256(onchain), uint256(expectedBands[t]));
        }
    }

    // ------------------------------------------------------ merkle reveal

    function test_VerifiesRealCandleProofs() public view {
        for (uint256 t = 0; t < timeSteps; t++) {
            (uint256 index, uint64 bn, uint160 sp, bytes32[] memory proof) = _hidden(t);
            assertTrue(registry.verifyCandle(windowId, index, bn, sp, proof), "real proof must verify");
        }
    }

    function test_RejectsTamperedCandle() public view {
        (uint256 index, uint64 bn, uint160 sp, bytes32[] memory proof) = _hidden(0);
        assertFalse(registry.verifyCandle(windowId, index, bn, sp + 1, proof), "tampered price must fail");
        assertFalse(registry.verifyCandle(windowId, index, bn + 1, sp, proof), "tampered block must fail");
        assertFalse(registry.verifyCandle(windowId, index + 1, bn, sp, proof), "tampered index must fail");
    }

    // --------------------------------------------------------- round flow

    function test_WinningBetPaysMultiplier() public {
        uint8 t = 0;
        uint8 winning = uint8(uint256(expectedBands[0]));
        uint128 stake = 0.01 ether;

        uint8[] memory ts = new uint8[](1);
        uint8[] memory ps = new uint8[](1);
        uint128[] memory amts = new uint128[](1);
        ts[0] = t;
        ps[0] = winning;
        amts[0] = stake;

        vm.prank(PLAYER);
        uint256 roundId = game.openRound{value: stake}(windowId, ts, ps, amts);

        uint32 mult = registry.multiplierAt(windowId, t, winning);
        uint256 expectedPayout = (uint256(stake) * mult) / game.MULT_SCALE();

        uint256 before = PLAYER.balance;
        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        game.resolveRound(roundId, idx, bns, sps, prs);

        assertEq(PLAYER.balance - before, expectedPayout, "payout must equal stake * multiplier");
        console.log("stake %s -> payout %s at %sx", stake, expectedPayout, uint256(mult) / 100);
    }

    function test_LosingBetPaysNothing() public {
        // pick a band the path definitely does not visit at t=0
        uint8 losing = uint8(uint256(expectedBands[0])) == 0 ? 1 : 0;
        uint128 stake = 0.01 ether;

        uint8[] memory ts = new uint8[](1);
        uint8[] memory ps = new uint8[](1);
        uint128[] memory amts = new uint128[](1);
        ts[0] = 0;
        ps[0] = losing;
        amts[0] = stake;

        vm.prank(PLAYER);
        uint256 roundId = game.openRound{value: stake}(windowId, ts, ps, amts);

        uint256 before = PLAYER.balance;
        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        game.resolveRound(roundId, idx, bns, sps, prs);

        assertEq(PLAYER.balance, before, "losing bet must pay nothing");
    }

    function test_ResolveRejectsForgedCandle() public {
        uint8[] memory ts = new uint8[](1);
        uint8[] memory ps = new uint8[](1);
        uint128[] memory amts = new uint128[](1);
        ts[0] = 0;
        ps[0] = uint8(uint256(expectedBands[0]));
        amts[0] = 0.01 ether;

        vm.prank(PLAYER);
        uint256 roundId = game.openRound{value: 0.01 ether}(windowId, ts, ps, amts);

        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        sps[0] = sps[0] + 1; // forge a price

        vm.expectRevert(abi.encodeWithSelector(GridGame.BadCandleProof.selector, idx[0]));
        game.resolveRound(roundId, idx, bns, sps, prs);
    }

    // ------------------------------------------------------ risk controls

    function test_RejectsBetAboveDynamicLimit() public {
        uint256 limit = game.maxBet();
        uint128 tooBig = uint128(limit + 1);

        uint8[] memory ts = new uint8[](1);
        uint8[] memory ps = new uint8[](1);
        uint128[] memory amts = new uint128[](1);
        ts[0] = 0;
        ps[0] = 0;
        amts[0] = tooBig;

        vm.deal(PLAYER, uint256(tooBig) + 1 ether);
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.BetTooLarge.selector, tooBig, limit));
        game.openRound{value: tooBig}(windowId, ts, ps, amts);
    }

    function test_RejectsExposureAboveRoundCap() public {
        // stake the max bet on the highest-multiplier cell we can find
        uint256 limit = game.maxBet();
        uint8 bestT;
        uint8 bestP;
        uint32 bestMult;
        for (uint8 t = 0; t < timeSteps; t++) {
            for (uint8 p = 0; p < priceBands; p++) {
                uint32 m = registry.multiplierAt(windowId, t, p);
                if (m > bestMult) {
                    bestMult = m;
                    bestT = t;
                    bestP = p;
                }
            }
        }

        uint8[] memory ts = new uint8[](1);
        uint8[] memory ps = new uint8[](1);
        uint128[] memory amts = new uint128[](1);
        ts[0] = bestT;
        ps[0] = bestP;
        amts[0] = uint128(limit);

        uint256 payout = (limit * bestMult) / game.MULT_SCALE();
        vm.assume(payout > game.maxRoundExposure());

        vm.deal(PLAYER, limit + 1 ether);
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.ExposureTooHigh.selector, payout, game.maxRoundExposure()));
        game.openRound{value: limit}(windowId, ts, ps, amts);
    }

    function test_RejectsDuplicateCells() public {
        uint8[] memory ts = new uint8[](2);
        uint8[] memory ps = new uint8[](2);
        uint128[] memory amts = new uint128[](2);
        ts[0] = 1; ps[0] = 2; amts[0] = 0.01 ether;
        ts[1] = 1; ps[1] = 2; amts[1] = 0.01 ether;

        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.DuplicateCell.selector, 1, 2));
        game.openRound{value: 0.02 ether}(windowId, ts, ps, amts);
    }

    function test_RejectsCellOutOfRange() public {
        uint8[] memory ts = new uint8[](1);
        uint8[] memory ps = new uint8[](1);
        uint128[] memory amts = new uint128[](1);
        ts[0] = timeSteps; // one past the end
        ps[0] = 0;
        amts[0] = 0.01 ether;

        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.CellOutOfRange.selector, timeSteps, 0));
        game.openRound{value: 0.01 ether}(windowId, ts, ps, amts);
    }

    function test_RejectsStakeMismatch() public {
        uint8[] memory ts = new uint8[](1);
        uint8[] memory ps = new uint8[](1);
        uint128[] memory amts = new uint128[](1);
        ts[0] = 0; ps[0] = 0; amts[0] = 0.02 ether;

        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.StakeMismatch.selector, 0.01 ether, 0.02 ether));
        game.openRound{value: 0.01 ether}(windowId, ts, ps, amts);
    }

    function test_ReclaimAfterTimeout() public {
        uint8[] memory ts = new uint8[](1);
        uint8[] memory ps = new uint8[](1);
        uint128[] memory amts = new uint128[](1);
        ts[0] = 0; ps[0] = 0; amts[0] = 0.05 ether;

        vm.prank(PLAYER);
        uint256 roundId = game.openRound{value: 0.05 ether}(windowId, ts, ps, amts);

        vm.prank(PLAYER);
        vm.expectRevert(GridGame.TooEarlyToReclaim.selector);
        game.reclaim(roundId);

        vm.warp(block.timestamp + game.ROUND_TIMEOUT() + 1);
        uint256 before = PLAYER.balance;
        vm.prank(PLAYER);
        game.reclaim(roundId);
        assertEq(PLAYER.balance - before, 0.05 ether, "stake must be refunded");
    }

    function test_OnlyPlayerCanReclaim() public {
        uint8[] memory ts = new uint8[](1);
        uint8[] memory ps = new uint8[](1);
        uint128[] memory amts = new uint128[](1);
        ts[0] = 0; ps[0] = 0; amts[0] = 0.05 ether;

        vm.prank(PLAYER);
        uint256 roundId = game.openRound{value: 0.05 ether}(windowId, ts, ps, amts);

        vm.warp(block.timestamp + game.ROUND_TIMEOUT() + 1);
        vm.prank(ATTACKER);
        vm.expectRevert(GridGame.NotPlayer.selector);
        game.reclaim(roundId);
    }

    function test_CannotResolveTwice() public {
        uint8[] memory ts = new uint8[](1);
        uint8[] memory ps = new uint8[](1);
        uint128[] memory amts = new uint128[](1);
        ts[0] = 0; ps[0] = uint8(uint256(expectedBands[0])); amts[0] = 0.01 ether;

        vm.prank(PLAYER);
        uint256 roundId = game.openRound{value: 0.01 ether}(windowId, ts, ps, amts);

        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        game.resolveRound(roundId, idx, bns, sps, prs);

        vm.expectRevert(abi.encodeWithSelector(GridGame.WrongRoundState.selector, roundId));
        game.resolveRound(roundId, idx, bns, sps, prs);
    }

    // --------------------------------------------------------- registry

    function test_OnlyOwnerCanRegisterWindow() public {
        uint32[] memory m = new uint32[](uint256(timeSteps) * uint256(priceBands));
        uint160[] memory v = new uint160[](1);

        vm.prank(ATTACKER);
        vm.expectRevert(ChartRegistry.NotOwner.selector);
        registry.registerWindow(
            ChartRegistry.RegisterParams({
                windowId: keccak256("fake"),
                merkleRoot: bytes32(0),
                anchorSqrtPriceX96: 1,
                bandHeight: 1e16,
                totalCandles: 1,
                visibleCount: 1,
                timeSteps: timeSteps,
                priceBands: priceBands,
                invert: true,
                eraLabel: "fake",
                riddleHash: bytes32(0),
                multipliers: m,
                visible: v
            })
        );
    }

    function test_RejectsGridSizeMismatch() public {
        uint32[] memory m = new uint32[](3); // wrong length
        uint160[] memory v = new uint160[](1);

        vm.expectRevert(
            abi.encodeWithSelector(
                ChartRegistry.GridSizeMismatch.selector, uint256(timeSteps) * uint256(priceBands), uint256(3)
            )
        );
        registry.registerWindow(
            ChartRegistry.RegisterParams({
                windowId: keccak256("fake2"),
                merkleRoot: bytes32(0),
                anchorSqrtPriceX96: 1,
                bandHeight: 1e16,
                totalCandles: 1,
                visibleCount: 1,
                timeSteps: timeSteps,
                priceBands: priceBands,
                invert: true,
                eraLabel: "fake",
                riddleHash: bytes32(0),
                multipliers: m,
                visible: v
            })
        );
    }

    receive() external payable {}
}
