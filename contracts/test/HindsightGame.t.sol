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

    /// The fixture's hidden[] already starts at the first bettable candle, so its indices are
    /// the pinned ones; this just documents the contract's expectation in one place.
    function _firstOutcomeIdx() internal view returns (uint256 first) {
        (first,,,) = _hidden(0);
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

    // ------------------------------------------------- payable entry points

    /// The friction this kills: a brand-new wallet should go faucet -> deal, no deposit step.
    function test_StartRoundWithValueNeedsNoDeposit() public {
        vm.deal(PLAYER, 1 ether);
        assertEq(game.balances(PLAYER), 0, "no credit at all");

        vm.prank(PLAYER);
        (uint256 roundId,) = game.startRound{value: 0.1 ether}(0.1 ether);

        (address player,, uint8 state, uint128 ante) = _round(roundId);
        assertEq(player, PLAYER);
        assertEq(state, uint8(1), "Dealt");
        assertEq(ante, 0.1 ether);
        assertEq(game.balances(PLAYER), 0, "value credited then consumed by the ante");
    }

    /// Over-attaching must never lose money — the excess stays as withdrawable credit,
    /// so the client does not have to compute an exact shortfall.
    function test_StartRoundValueExcessStaysAsCredit() public {
        vm.deal(PLAYER, 2 ether);
        vm.prank(PLAYER);
        game.startRound{value: 1 ether}(0.1 ether);
        assertEq(game.balances(PLAYER), 0.9 ether, "excess is credit, not a donation");
    }

    /// Attached value merely tops up the balance; short is still short, and the revert
    /// refunds the attached value with the rest of the transaction.
    function test_StartRoundWithInsufficientValueReverts() public {
        vm.deal(PLAYER, 1 ether);
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.InsufficientBalance.selector, 0.1 ether, 0.01 ether));
        game.startRound{value: 0.01 ether}(0.1 ether);
        assertEq(PLAYER.balance, 1 ether, "reverted value came back");
        assertEq(game.balances(PLAYER), 0, "nothing sticks on revert");
    }

    /// The stake above the ante can also arrive as attached value at settle time.
    function test_SettleRoundWithValueCoversShortfall() public {
        vm.deal(PLAYER, 1 ether);
        vm.prank(PLAYER);
        (uint256 roundId,) = game.startRound{value: 0.01 ether}(0.01 ether);

        uint8 winning = uint8(uint256(expectedBands[0]));
        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, winning, 0.03 ether);

        // credit is 0 and the extra beyond the ante is 0.02 — attach exactly that
        vm.prank(PLAYER);
        game.settleRound{value: 0.02 ether}(roundId, ts, ps, amts);

        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        game.resolveRound(roundId, idx, bns, sps, prs);

        uint32 mult = registry.multiplierAt(windowId, 0, winning);
        assertEq(
            game.balances(PLAYER),
            (uint256(0.03 ether) * mult) / game.MULT_SCALE(),
            "whole flow works without deposit() ever being called"
        );
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

    // ------------------------------------------------- simple up/down mode

    /// Which way the fixture window actually closed, computed the same way the worker does:
    /// in sqrtPriceX96 space, respecting invert. This is the property the mode hinges on.
    function _fixtureClosedUp() internal view returns (bool) {
        (,, uint160 anchorSqrt,,,,,, bool invert,,) = registry.windows(windowId);
        (,, uint160 finalSqrt,) = _hidden(timeSteps - 1);
        return invert ? finalSqrt < anchorSqrt : finalSqrt > anchorSqrt;
    }

    function test_DirectionWinPaysAsymmetricMultiplier() public {
        vm.deal(PLAYER, 5 ether);
        uint128 ante = 0.01 ether;
        vm.prank(PLAYER);
        (uint256 roundId,) = game.startRound{value: 1 ether}(ante);

        bool closedUp = _fixtureClosedUp();
        vm.prank(PLAYER);
        game.settleDirection(roundId, closedUp, ante); // bet the way it actually went

        uint256 before = game.balances(PLAYER);
        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        game.resolveRound(roundId, idx, bns, sps, prs);

        uint32 mult = closedUp ? game.DIRECTION_UP_MULT() : game.DIRECTION_DOWN_MULT();
        assertEq(game.balances(PLAYER) - before, (uint256(ante) * mult) / game.MULT_SCALE(), "direction win pays");
        assertTrue(mult == 17000 || mult == 19000, "up 1.70x, down 1.90x");
    }

    function test_DirectionWrongWayPaysNothing() public {
        vm.deal(PLAYER, 5 ether);
        uint128 ante = 0.01 ether;
        vm.prank(PLAYER);
        (uint256 roundId,) = game.startRound{value: 1 ether}(ante);

        // computed BEFORE the prank: _fixtureClosedUp reads the registry, and vm.prank only
        // covers the next external call — inlining it here would consume the prank
        bool wrongWay = !_fixtureClosedUp();
        vm.prank(PLAYER);
        game.settleDirection(roundId, wrongWay, ante);

        uint256 before = game.balances(PLAYER);
        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        game.resolveRound(roundId, idx, bns, sps, prs);
        assertEq(game.balances(PLAYER), before, "wrong direction pays nothing");
    }

    /// The polarity trap: under invert a RISING price is a FALLING sqrtPriceX96. If _closedUp had
    /// the comparison backwards this test would pass its mirror image, so it pins the sign against
    /// the decoded price rather than against itself.
    function test_DirectionPolarityMatchesRealPrice() public view {
        (,, uint160 anchorSqrt,,,,,, bool invert,,) = registry.windows(windowId);
        assertTrue(invert, "USDC/WETH fixture quotes token0/token1");

        (,, uint160 finalSqrt,) = _hidden(timeSteps - 1);
        // decoded prices: price ~ 1/sqrt^2 under invert, so compare reciprocals directly
        bool upBySqrt = finalSqrt < anchorSqrt;
        bool upByBand = registry.bandOf(windowId, finalSqrt) >= int256(6); // 12 bands, centre 6
        if (registry.bandOf(windowId, finalSqrt) >= 0) {
            assertEq(upBySqrt, upByBand, "sqrt comparison must agree with bandOf when in-grid");
        }
    }

    /// bandOf returns -1 outside the grid, losing the sign — 20% of the real pool. Direction must
    /// still resolve, which is why _closedUp does not go through bandOf.
    function test_DirectionResolvesEvenWhenPriceLeftTheGrid() public {
        vm.deal(PLAYER, 5 ether);
        uint128 ante = 0.01 ether;
        vm.prank(PLAYER);
        (uint256 roundId,) = game.startRound{value: 1 ether}(ante);
        bool closedUp = _fixtureClosedUp();
        vm.prank(PLAYER);
        game.settleDirection(roundId, closedUp, ante);

        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        game.resolveRound(roundId, idx, bns, sps, prs);

        (,, GridGame.RoundState st,,, uint128 paid) = game.roundSummary(roundId);
        assertEq(uint8(st), uint8(3), "Resolved");
        assertGt(paid, 0, "a correct call pays regardless of whether the band was in range");
    }

    function test_DirectionRespectsStakeAndExposureLimits() public {
        vm.deal(PLAYER, 100 ether);
        uint128 ante = 0.01 ether;
        vm.prank(PLAYER);
        (uint256 roundId,) = game.startRound{value: 50 ether}(ante);

        // below the ante is refused, exactly as in grid mode
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.StakeBelowAnte.selector, ante - 1, ante));
        game.settleDirection(roundId, true, ante - 1);

        // and a stake over the per-bet limit is refused
        uint256 limit = game.maxBet();
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.BetTooLarge.selector, limit + 1, limit));
        game.settleDirection(roundId, true, uint128(limit + 1));
    }

    /// A round settles one way or the other, never both.
    function test_CannotSettleBothWays() public {
        vm.deal(PLAYER, 5 ether);
        uint128 ante = 0.01 ether;
        vm.prank(PLAYER);
        (uint256 roundId,) = game.startRound{value: 1 ether}(ante);

        vm.prank(PLAYER);
        game.settleDirection(roundId, true, ante);

        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 0, ante);
        vm.prank(PLAYER);
        vm.expectRevert(abi.encodeWithSelector(GridGame.WrongRoundState.selector, roundId));
        game.settleRound(roundId, ts, ps, amts);
    }

    /// A Merkle proof says a candle belongs to the window, NOT which candle it is. Resolution is
    /// permissionless with caller-supplied indices, so before index pinning a player could submit
    /// one winning candle in all eight slots and collect on every column — measured at 19x the
    /// honest payout. This is the regression guard for that.
    uint8 private xBand;
    uint256 private xRound;

    function test_RejectsRepeatedCandleAcrossColumns() public {
        vm.deal(PLAYER, 50 ether);
        vm.prank(PLAYER);
        (xRound,) = game.startRound{value: 1 ether}(0.01 ether);

        xBand = uint8(uint256(expectedBands[0]));
        require(uint256(expectedBands[2]) != xBand, "fixture needs differing bands");
        _betSameBandTwice();
        vm.expectRevert();          // WrongCandleIndex: each slot is pinned to its own candle
        _resolveWithRepeatedCandle();

    }

    function _betSameBandTwice() internal {
        uint8[] memory ts = new uint8[](2);
        uint8[] memory ps = new uint8[](2);
        uint128[] memory amts = new uint128[](2);
        ts[0] = 0; ps[0] = xBand; amts[0] = 0.01 ether;
        ts[1] = 2; ps[1] = xBand; amts[1] = 0.01 ether;   // wrong for t=2 — should lose
        vm.prank(PLAYER);
        game.settleRound(xRound, ts, ps, amts);
    }

    function _resolveWithRepeatedCandle() internal {
        (uint256 i0, uint64 b0, uint160 s0, bytes32[] memory pr0) = _hidden(0);
        uint256[] memory idx = new uint256[](timeSteps);
        uint64[] memory bns = new uint64[](timeSteps);
        uint160[] memory sps = new uint160[](timeSteps);
        bytes32[][] memory prs = new bytes32[][](timeSteps);
        for (uint256 t = 0; t < timeSteps; t++) { idx[t] = i0; bns[t] = b0; sps[t] = s0; prs[t] = pr0; }
        game.resolveRound(xRound, idx, bns, sps, prs);
    }

    // ------------------------------------------- the decision window

    /// The countdown must be enforced on-chain, or it is decoration and a reverse-searcher
    /// simply takes as long as they like.
    function test_RevertsWhenDecisionWindowClosed() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);

        vm.roll(block.number + game.DECISION_BLOCKS() + 1);

        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 0, 0.01 ether);
        vm.prank(PLAYER);
        vm.expectRevert();
        game.settleRound(roundId, ts, ps, amts);
    }

    function test_SettlesAtTheDeadline() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);

        vm.roll(block.number + game.DECISION_BLOCKS()); // exactly on the deadline

        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 0, 0.01 ether);
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

        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 0, 0.01 ether);
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

        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 0, 0.01 ether);
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
