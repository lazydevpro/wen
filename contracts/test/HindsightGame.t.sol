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

    // ----------------------------------------------------- credit + deal

    function _deposit(address who, uint256 amt) internal {
        vm.deal(who, amt);
        vm.prank(who);
        game.deposit{value: amt}();
    }

    function _dealRound(address who, uint128 ante) internal returns (uint256 roundId) {
        vm.prank(who);
        (roundId,) = game.startRound(ante);
    }

    function _cells(uint8 t, uint8 p, uint128 amt)
        internal
        pure
        returns (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts)
    {
        ts = new uint8[](1); ps = new uint8[](1); amts = new uint128[](1);
        ts[0] = t; ps[0] = p; amts[0] = amt;
    }

    function test_DepositAndWithdraw() public {
        _deposit(PLAYER, 5 ether);
        assertEq(game.balances(PLAYER), 5 ether);

        uint256 before = PLAYER.balance;
        vm.prank(PLAYER);
        game.withdraw(2 ether);
        assertEq(game.balances(PLAYER), 3 ether);
        assertEq(PLAYER.balance - before, 2 ether);
    }

    /// The ante must land BEFORE the window is known — that is what makes "pay to look" real.
    function test_StartRoundAssignsWindowAndDebitsAnte() public {
        _deposit(PLAYER, 5 ether);

        vm.prank(PLAYER);
        (uint256 roundId, bytes32 assigned) = game.startRound(0.1 ether);

        assertEq(assigned, windowId, "only one window registered, so it must be dealt");
        assertEq(game.balances(PLAYER), 5 ether - 0.1 ether, "ante debited");

        (address player, bytes32 w, uint8 state, uint128 ante) = _round(roundId);
        assertEq(player, PLAYER);
        assertEq(w, windowId);
        assertEq(state, uint8(1), "Dealt");
        assertEq(ante, 0.1 ether);
    }

    function _round(uint256 id) internal view returns (address, bytes32, uint8, uint128) {
        (address player, bytes32 w, GridGame.RoundState st, uint128 ante,,) = game.roundSummary(id);
        return (player, w, uint8(st), ante);
    }

    function test_RevertsWhenAnteExceedsBalance() public {
        _deposit(PLAYER, 0.01 ether);
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.InsufficientBalance.selector, 0.1 ether, 0.01 ether));
        game.startRound(0.1 ether);
    }

    // --------------------------------------------------------- round flow

    function test_WinningBetPaysMultiplier() public {
        _deposit(PLAYER, 5 ether);
        uint128 ante = 0.01 ether;
        uint256 roundId = _dealRound(PLAYER, ante);

        uint8 winning = uint8(uint256(expectedBands[0]));
        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, winning, ante);

        vm.prank(PLAYER);
        game.settleRound(roundId, ts, ps, amts);

        uint32 mult = registry.multiplierAt(windowId, 0, winning);
        uint256 expectedPayout = (uint256(ante) * mult) / game.MULT_SCALE();

        uint256 before = game.balances(PLAYER);
        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        game.resolveRound(roundId, idx, bns, sps, prs);

        assertEq(game.balances(PLAYER) - before, expectedPayout, "payout credited to balance");
        console.log("ante %s -> payout %s", ante, expectedPayout);
    }

    function test_LosingBetPaysNothing() public {
        _deposit(PLAYER, 5 ether);
        uint128 ante = 0.01 ether;
        uint256 roundId = _dealRound(PLAYER, ante);

        uint8 losing = uint8(uint256(expectedBands[0])) == 0 ? 1 : 0;
        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, losing, ante);
        vm.prank(PLAYER);
        game.settleRound(roundId, ts, ps, amts);

        uint256 before = game.balances(PLAYER);
        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        game.resolveRound(roundId, idx, bns, sps, prs);
        assertEq(game.balances(PLAYER), before, "losing bet pays nothing");
    }

    // ------------------------------------------- the decision window

    /// The countdown must be enforced on-chain, or it is decoration and a reverse-searcher
    /// simply takes as long as they like.
    function test_RevertsWhenDecisionWindowClosed() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);

        vm.roll(block.number + game.DECISION_BLOCKS() + 1);

        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 5, 0.01 ether);
        vm.prank(PLAYER);
        vm.expectRevert();
        game.settleRound(roundId, ts, ps, amts);
    }

    function test_SettlesAtTheDeadline() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);

        vm.roll(block.number + game.DECISION_BLOCKS()); // exactly on the deadline

        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 5, 0.01 ether);
        vm.prank(PLAYER);
        game.settleRound(roundId, ts, ps, amts);

        (,, uint8 state,) = _round(roundId);
        assertEq(state, uint8(2), "Settled");
    }

    /// Deal, look, walk away -> the ante is forfeit. This is what prices reverse-search.
    function test_ExpiredRoundForfeitsAnte() public {
        _deposit(PLAYER, 5 ether);
        uint128 ante = 0.05 ether;
        uint256 balBefore = game.balances(PLAYER);
        uint256 roundId = _dealRound(PLAYER, ante);

        vm.roll(block.number + game.DECISION_BLOCKS() + 1);
        game.expireRound(roundId); // permissionless

        (,, uint8 state,) = _round(roundId);
        assertEq(state, uint8(4), "Expired");
        assertEq(game.balances(PLAYER), balBefore - ante, "ante not returned");
    }

    function test_CannotExpireBeforeDeadline() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);
        vm.expectRevert();
        game.expireRound(roundId);
    }

    // ------------------------------------------------------ risk controls

    /// Total stake must cover the ante, so the ante is a stake and not an extra fee.
    function test_RevertsWhenStakeBelowAnte() public {
        _deposit(PLAYER, 5 ether);
        uint128 ante = 0.05 ether;
        uint256 roundId = _dealRound(PLAYER, ante);

        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 5, 0.01 ether);
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.StakeBelowAnte.selector, uint256(0.01 ether), ante));
        game.settleRound(roundId, ts, ps, amts);
    }

    /// NOTE: the ante joins the bankroll, so maxBet() grows slightly the moment a round is
    /// dealt. The limit must therefore be read AFTER dealing, not before.
    function test_RejectsBetAboveDynamicLimit() public {
        _deposit(PLAYER, game.maxBet() * 3);
        uint256 roundId = _dealRound(PLAYER, uint128(game.maxBet() / 2));

        uint256 limit = game.maxBet(); // re-read: the ante moved it
        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 0, uint128(limit + 1));
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.BetTooLarge.selector, limit + 1, limit));
        game.settleRound(roundId, ts, ps, amts);
    }

    function test_RejectsDuplicateCells() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);

        uint8[] memory ts = new uint8[](2);
        uint8[] memory ps = new uint8[](2);
        uint128[] memory amts = new uint128[](2);
        ts[0] = 1; ps[0] = 2; amts[0] = 0.01 ether;
        ts[1] = 1; ps[1] = 2; amts[1] = 0.01 ether;

        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.DuplicateCell.selector, 1, 2));
        game.settleRound(roundId, ts, ps, amts);
    }

    function test_RejectsCellOutOfRange() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);

        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(timeSteps, 0, 0.01 ether);
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.CellOutOfRange.selector, timeSteps, 0));
        game.settleRound(roundId, ts, ps, amts);
    }

    function test_OnlyPlayerCanSettle() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);

        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 5, 0.01 ether);
        vm.prank(ATTACKER);
        vm.expectRevert(GridGame.NotPlayer.selector);
        game.settleRound(roundId, ts, ps, amts);
    }

    function test_ResolveRejectsForgedCandle() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);
        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) =
            _cells(0, uint8(uint256(expectedBands[0])), 0.01 ether);
        vm.prank(PLAYER);
        game.settleRound(roundId, ts, ps, amts);

        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        sps[0] = sps[0] + 1;

        vm.expectRevert(abi.encodeWithSelector(GridGame.BadCandleProof.selector, idx[0]));
        game.resolveRound(roundId, idx, bns, sps, prs);
    }

    function test_CannotResolveTwice() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);
        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) =
            _cells(0, uint8(uint256(expectedBands[0])), 0.01 ether);
        vm.prank(PLAYER);
        game.settleRound(roundId, ts, ps, amts);

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
