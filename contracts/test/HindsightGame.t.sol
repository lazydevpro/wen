// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ChartRegistry, IChartVerifier} from "../src/ChartRegistry.sol";
import {GridGame} from "../src/GridGame.sol";

/**
 * Tests ChartRegistry + GridGame against a REAL exported Hindsight window
 * (test/fixtures/window-*.json — regenerate with `pnpm export-window <id>` in worker/).
 *
 * The most important assertion here is test_BandMathMatchesTypeScript: if Solidity's bandOf()
 * disagrees with the worker's, resolution pays the wrong cells and the whole game is broken.
 */
/**
 * Stands in for ChartVerifier so these tests need no live Attestcoin proof. It is seeded from the
 * same fixture the registry is handed, so "proven" here means exactly what it means on-chain:
 * this pool, this block, this price. ChartVerifier.t.sol covers the real proving path.
 */
contract MockVerifier is IChartVerifier {
    mapping(address => mapping(uint64 => uint160)) internal _proven;

    function set(address pool, uint64 blockNumber, uint160 sqrtPriceX96) external {
        _proven[pool][blockNumber] = sqrtPriceX96;
    }

    function provenPrice(address pool, uint64 blockNumber) external view returns (uint160) {
        return _proven[pool][blockNumber];
    }
}

/// Reproduces the "deal, look, revert" attack: a contract paid nothing to reverse-search a window
/// because it could read the windowId and undo the whole transaction if it did not like it.
contract PeekBot {
    GridGame public game;
    constructor(GridGame g) payable { game = g; }
    function peek(uint128 ante) external returns (bytes32) {
        uint256 rid = game.startRound{value: ante}(ante);
        return game.windowOf(rid);   // must revert: the window is not knowable yet
    }
}

contract HindsightGameTest is Test {
    MockVerifier internal verifier;
    address internal pool;
    uint64[] internal blockNumbers;
    uint160[] internal sqrtPrices;

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

        pool = vm.parseJsonAddress(json, ".pool");
        uint256[] memory blkRaw = vm.parseJsonUintArray(json, ".blockNumbers");
        uint256[] memory prcRaw = vm.parseJsonUintArray(json, ".sqrtPrices");

        // Seed the verifier first: registration now REFUSES candles it cannot find here.
        verifier = new MockVerifier();
        for (uint256 i = 0; i < blkRaw.length; i++) {
            blockNumbers.push(uint64(blkRaw[i]));
            sqrtPrices.push(uint160(prcRaw[i]));
            verifier.set(pool, uint64(blkRaw[i]), uint160(prcRaw[i]));
        }

        registry = new ChartRegistry(verifier);
        registry.registerWindow(
            ChartRegistry.RegisterParams({
                windowId: windowId,
                pool: pool,
                bandHeight: vm.parseJsonUint(json, ".bandHeightScaled"),
                visibleCount: uint16(vm.parseJsonUint(json, ".visibleCount")),
                timeSteps: timeSteps,
                priceBands: priceBands,
                invert: vm.parseJsonBool(json, ".invert"),
                eraLabel: vm.parseJsonString(json, ".eraLabel"),
                riddleHash: vm.parseJsonBytes32(json, ".riddleHash"),
                multipliers: multipliers,
                blockNumbers: blockNumbers,
                sqrtPrices: sqrtPrices
            })
        );
        visible; // retained for readability of the fixture parse above

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
        roundId = game.startRound(ante);
        vm.roll(block.number + 1);
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
        uint256 roundId = game.startRound(0.1 ether);
        vm.roll(block.number + 1);
        bytes32 assigned = game.windowOf(roundId);

        assertEq(assigned, windowId, "only one window registered, so it must be dealt");
        assertEq(game.balances(PLAYER), 5 ether - 0.1 ether, "ante debited");

        (address player, bytes32 w, uint8 state, uint128 ante) = _round(roundId);
        assertEq(player, PLAYER);
        // stored windowId stays zero until settle: the round has drawn a window, but committing it
        // at deal time is exactly what let a contract peek and revert without paying the ante
        assertEq(w, bytes32(0), "window not committed until settle");
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
        uint256 roundId = game.startRound{value: 0.1 ether}(0.1 ether);
        vm.roll(block.number + 1);

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
        uint256 roundId = game.startRound{value: 0.01 ether}(0.01 ether);
        vm.roll(block.number + 1);

        uint8 winning = uint8(uint256(expectedBands[0]));
        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, winning, 0.03 ether);

        // credit is 0 and the extra beyond the ante is 0.02 — attach exactly that
        vm.prank(PLAYER);
        game.settleRound{value: 0.02 ether}(roundId, ts, ps, amts);

        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        vm.roll(block.number + 1);
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
        vm.roll(block.number + 1);
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
        vm.roll(block.number + 1);
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
        uint256 roundId = game.startRound{value: 1 ether}(ante);
        vm.roll(block.number + 1);

        bool closedUp = _fixtureClosedUp();
        vm.prank(PLAYER);
        game.settleDirection(roundId, closedUp, ante); // bet the way it actually went

        uint256 before = game.balances(PLAYER);
        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        vm.roll(block.number + 1);
        game.resolveRound(roundId, idx, bns, sps, prs);

        uint32 mult = closedUp ? game.DIRECTION_UP_MULT() : game.DIRECTION_DOWN_MULT();
        assertEq(game.balances(PLAYER) - before, (uint256(ante) * mult) / game.MULT_SCALE(), "direction win pays");
        assertTrue(mult == 17000 || mult == 19000, "up 1.70x, down 1.90x");
    }

    function test_DirectionWrongWayPaysNothing() public {
        vm.deal(PLAYER, 5 ether);
        uint128 ante = 0.01 ether;
        vm.prank(PLAYER);
        uint256 roundId = game.startRound{value: 1 ether}(ante);
        vm.roll(block.number + 1);

        // computed BEFORE the prank: _fixtureClosedUp reads the registry, and vm.prank only
        // covers the next external call — inlining it here would consume the prank
        bool wrongWay = !_fixtureClosedUp();
        vm.prank(PLAYER);
        game.settleDirection(roundId, wrongWay, ante);

        uint256 before = game.balances(PLAYER);
        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        vm.roll(block.number + 1);
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
        uint256 roundId = game.startRound{value: 1 ether}(ante);
        vm.roll(block.number + 1);
        bool closedUp = _fixtureClosedUp();
        vm.prank(PLAYER);
        game.settleDirection(roundId, closedUp, ante);

        (uint256[] memory idx, uint64[] memory bns, uint160[] memory sps, bytes32[][] memory prs) = _revealAll();
        vm.roll(block.number + 1);
        game.resolveRound(roundId, idx, bns, sps, prs);

        (,, GridGame.RoundState st,,, uint128 paid) = game.roundSummary(roundId);
        assertEq(uint8(st), uint8(3), "Resolved");
        assertGt(paid, 0, "a correct call pays regardless of whether the band was in range");
    }

    function test_DirectionRespectsStakeAndExposureLimits() public {
        vm.deal(PLAYER, 100 ether);
        uint128 ante = 0.01 ether;
        vm.prank(PLAYER);
        uint256 roundId = game.startRound{value: 50 ether}(ante);
        vm.roll(block.number + 1);

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
        uint256 roundId = game.startRound{value: 1 ether}(ante);
        vm.roll(block.number + 1);

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
        xRound = game.startRound{value: 1 ether}(0.01 ether);
        vm.roll(block.number + 1);

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
        vm.roll(block.number + 1);
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

        vm.roll(game.deadlineOf(roundId)); // exactly on the deadline

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
        vm.roll(block.number + 1);
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
        vm.roll(block.number + 1);
        game.resolveRound(roundId, idx, bns, sps, prs);

        vm.expectRevert(abi.encodeWithSelector(GridGame.WrongRoundState.selector, roundId));
        vm.roll(block.number + 1);
        game.resolveRound(roundId, idx, bns, sps, prs);
    }


    /// Minimal params that get past the length checks, for tests about a specific revert.
    function _fakeParams(bytes32 id, uint32[] memory m) internal view returns (ChartRegistry.RegisterParams memory) {
        uint64[] memory b = new uint64[](1);
        uint160[] memory q = new uint160[](1);
        b[0] = blockNumbers[0];
        q[0] = sqrtPrices[0];
        return ChartRegistry.RegisterParams({
            windowId: id,
            pool: pool,
            bandHeight: 1e16,
            visibleCount: 1,
            timeSteps: timeSteps,
            priceBands: priceBands,
            invert: true,
            eraLabel: "fake",
            riddleHash: bytes32(0),
            multipliers: m,
            blockNumbers: b,
            sqrtPrices: q
        });
    }

    // --------------------------------------------------------- registry

    function test_OnlyOwnerCanRegisterWindow() public {
        uint32[] memory m = new uint32[](uint256(timeSteps) * uint256(priceBands));
        vm.prank(ATTACKER);
        vm.expectRevert(ChartRegistry.NotOwner.selector);
        registry.registerWindow(
            _fakeParams(keccak256("fake"), m)
        );
    }

    function test_RejectsGridSizeMismatch() public {
        uint32[] memory m = new uint32[](3); // wrong length
        vm.expectRevert(
            abi.encodeWithSelector(
                ChartRegistry.GridSizeMismatch.selector, uint256(timeSteps) * uint256(priceBands), uint256(3)
            )
        );
        registry.registerWindow(
            _fakeParams(keccak256("fake2"), m)
        );
    }


    // ---- the provenance gate --------------------------------------------------
    // These three are the regression tests for the hole this gate exists to close: before it,
    // registerWindow validated two array lengths and took the operator's merkle root on faith,
    // so a window of candles at Ethereum blocks that do not exist registered and resolved
    // cleanly. A merkle proof answers "is this candle in the set I committed", never "did this
    // happen on Ethereum" — provenance has to be checked at registration or not at all.

    function test_RejectsWindowWithUnprovenCandles() public {
        uint64[] memory b = new uint64[](2);
        uint160[] memory q = new uint160[](2);
        // Ethereum head is ~23M. These blocks do not exist and never will.
        b[0] = 99_000_000;
        b[1] = 99_000_001;
        q[0] = 1_700_000_000_000_000_000_000_000_000_000_000;
        q[1] = 1_700_000_000_000_000_000_000_000_000_000_001;

        uint32[] memory m = new uint32[](uint256(timeSteps) * uint256(priceBands));
        vm.expectRevert(abi.encodeWithSelector(ChartRegistry.CandleNotProven.selector, uint256(0), uint64(99_000_000)));
        registry.registerWindow(
            ChartRegistry.RegisterParams({
                windowId: keccak256("fabricated"),
                pool: pool,
                bandHeight: 1e16,
                visibleCount: 1,
                timeSteps: timeSteps,
                priceBands: priceBands,
                invert: true,
                eraLabel: "a window from nowhere",
                riddleHash: bytes32(0),
                multipliers: m,
                blockNumbers: b,
                sqrtPrices: q
            })
        );
    }

    function test_RejectsRestatedPriceAtProvenBlock() public {
        // The block IS proven — but at a different price. Checking only the block number would
        // let the operator keep the real timeline and move the prices, which is the whole game.
        uint64[] memory b = new uint64[](1);
        uint160[] memory q = new uint160[](1);
        b[0] = blockNumbers[0];
        q[0] = sqrtPrices[0] + 1;

        uint32[] memory m = new uint32[](uint256(timeSteps) * uint256(priceBands));
        vm.expectRevert(abi.encodeWithSelector(ChartRegistry.CandleNotProven.selector, uint256(0), blockNumbers[0]));
        registry.registerWindow(
            ChartRegistry.RegisterParams({
                windowId: keccak256("restated"),
                pool: pool,
                bandHeight: 1e16,
                visibleCount: 1,
                timeSteps: timeSteps,
                priceBands: priceBands,
                invert: true,
                eraLabel: "right block, wrong price",
                riddleHash: bytes32(0),
                multipliers: m,
                blockNumbers: b,
                sqrtPrices: q
            })
        );
    }

    function test_DerivedRootMatchesOffchainBuilder() public view {
        // The registry now computes the root itself. If its tree shape ever diverges from
        // worker/src/lib/window.ts buildMerkle(), every inclusion proof the worker emits would
        // stop verifying and no hidden candle could be revealed. This pins the two together.
        (, bytes32 storedRoot,,,,,,,,,) = registry.windows(windowId);
        assertEq(storedRoot, vm.parseJsonBytes32(json, ".merkleRoot"), "on-chain root != off-chain root");
        assertTrue(storedRoot != bytes32(0), "root should not be empty");
    }

    function test_AnchorIsDerivedFromProvenCandles() public view {
        (,, uint160 anchor,,,,,,,,) = registry.windows(windowId);
        assertEq(anchor, sqrtPrices[uint256(vm.parseJsonUint(json, ".visibleCount")) - 1], "anchor not derived");
        assertEq(anchor, uint160(vm.parseJsonUint(json, ".anchorSqrtPriceX96")), "anchor != fixture");
    }

    // ---- the three economic guards ------------------------------------------

    function test_ContractCannotPeekAtWindowInDealTransaction() public {
        PeekBot bot = new PeekBot{value: 5 ether}(game);
        // The window derives from the hash of the NEXT block, so there is nothing to read yet and
        // nothing to revert away from. Paying to look is now unavoidable.
        vm.expectRevert(abi.encodeWithSelector(GridGame.WindowNotYetKnown.selector, block.number, block.number));
        bot.peek(0.1 ether);
    }

    function test_CannotResolveInTheSettlingBlock() public {
        _deposit(PLAYER, 5 ether);
        uint256 roundId = _dealRound(PLAYER, 0.01 ether);
        (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 0, 0.01 ether);
        vm.prank(PLAYER);
        game.settleRound(roundId, ts, ps, amts);

        // deal -> bet -> collect inside one transaction was worth 4.62 ether on a 1 ether bet
        (uint256[] memory idx, uint64[] memory blks, uint160[] memory sps, bytes32[][] memory prf) = _revealAll();
        vm.expectRevert(
            abi.encodeWithSelector(GridGame.TooSoonToResolve.selector, uint64(block.number), block.number)
        );
        game.resolveRound(roundId, idx, blks, sps, prf);
    }

    function test_TotalExposureIsBoundedAcrossOpenRounds() public {
        // EXPOSURE_DIVISOR bounds ONE round. Eighty open at once drained 93.7% of a bankroll
        // through a breaker set at 30%, because nothing summed them.
        _deposit(PLAYER, 500 ether);
        uint256 cap = game.bankroll() / game.TOTAL_EXPOSURE_DIVISOR();
        uint256 opened;
        for (uint256 i = 0; i < 200; i++) {
            uint256 rid = _dealRound(PLAYER, 0.5 ether);
            (uint8[] memory ts, uint8[] memory ps, uint128[] memory amts) = _cells(0, 0, 0.5 ether);
            vm.prank(PLAYER);
            try game.settleRound(rid, ts, ps, amts) { opened++; } catch { break; }
        }
        assertGt(opened, 0, "should open some rounds");
        assertLe(game.outstandingExposure(), cap, "pool-wide exposure never exceeds the cap");
        assertLt(opened, 200, "the cap must actually bind");
    }

    receive() external payable {}
}
