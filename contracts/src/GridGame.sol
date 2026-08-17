// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChartRegistry} from "./ChartRegistry.sol";

/**
 * @title GridGame
 * @notice Hindsight's betting layer. Players stake on (time, price) cells over a window's hidden
 *         future; the chart plays forward and cells the real price path crosses pay out.
 *
 * Testnet only — CTC here has no value, so this is game mechanics rather than a gambling
 * operation. Bankroll protections are nonetheless real, because getting them right is the
 * interesting engineering:
 *
 *  - dynamic bet limit: maxBet = bankroll / BANKROLL_RATIO, recomputed on-chain so exposure
 *    shrinks automatically as the bankroll does. Self-limiting rather than a fixed constant.
 *  - per-round exposure cap: total possible payout may not exceed a fraction of the bankroll.
 *  - drawdown circuit breaker: pause if the bankroll falls past a threshold in a window.
 *
 * Resolution is permissionless: anyone may submit the hidden candles with Merkle proofs, so the
 * operator cannot withhold a losing outcome. A round that nobody resolves can be reclaimed by
 * the player after `ROUND_TIMEOUT`.
 */
contract GridGame {
    /// @dev bankroll must be this many times the max single bet (1% ruin risk at sigma ~2.54)
    uint256 public constant BANKROLL_RATIO = 400;

    /// @dev a single round may never risk more than 1/EXPOSURE_DIVISOR of the bankroll
    uint256 public constant EXPOSURE_DIVISOR = 50;

    /// @dev unresolved rounds become reclaimable after this long
    uint256 public constant ROUND_TIMEOUT = 1 days;

    uint256 public constant MULT_SCALE = 1e4;

    enum RoundState {
        None,
        Open,
        Resolved,
        Reclaimed
    }

    struct Bet {
        uint8 t;
        uint8 p;
        uint128 amount;
    }

    struct Round {
        address player;
        bytes32 windowId;
        RoundState state;
        uint64 openedAt;
        uint128 staked;
        uint128 paidOut;
    }

    ChartRegistry public immutable registry;
    address public owner;

    uint256 public bankroll;
    bool public paused;

    /// @dev high-water mark used by the drawdown breaker
    uint256 public bankrollPeak;
    /// @dev pause automatically if bankroll drops below peak * (100 - MAX_DRAWDOWN_PCT) / 100
    uint256 public constant MAX_DRAWDOWN_PCT = 30;

    uint256 public nextRoundId = 1;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => Bet[]) public betsOf;

    event BankrollFunded(address indexed from, uint256 amount, uint256 total);
    event RoundOpened(uint256 indexed roundId, address indexed player, bytes32 indexed windowId, uint256 staked);
    event RoundResolved(uint256 indexed roundId, address indexed player, uint256 payout);
    event RoundReclaimed(uint256 indexed roundId, address indexed player, uint256 amount);
    event Paused(string reason);
    event Unpaused();

    error NotOwner();
    error GamePaused();
    error NoBets();
    error BetTooLarge(uint256 amount, uint256 maxBet);
    error StakeMismatch(uint256 sent, uint256 declared);
    error ExposureTooHigh(uint256 maxPayout, uint256 cap);
    error CellOutOfRange(uint8 t, uint8 p);
    error DuplicateCell(uint8 t, uint8 p);
    error WrongRoundState(uint256 roundId);
    error NotPlayer();
    error TooEarlyToReclaim();
    error RevealCountMismatch(uint256 expected, uint256 got);
    error BadCandleProof(uint256 index);
    error InsufficientBankroll(uint256 needed, uint256 have);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(ChartRegistry _registry) {
        registry = _registry;
        owner = msg.sender;
    }

    // ------------------------------------------------------------ bankroll

    function fundBankroll() external payable {
        bankroll += msg.value;
        if (bankroll > bankrollPeak) bankrollPeak = bankroll;
        emit BankrollFunded(msg.sender, msg.value, bankroll);
    }

    function withdrawBankroll(uint256 amount) external onlyOwner {
        if (amount > bankroll) revert InsufficientBankroll(amount, bankroll);
        bankroll -= amount;
        payable(owner).transfer(amount);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        if (p) emit Paused("manual"); else emit Unpaused();
    }

    /// @notice Largest single bet currently allowed. Shrinks with the bankroll automatically.
    function maxBet() public view returns (uint256) {
        return bankroll / BANKROLL_RATIO;
    }

    /// @notice Largest total payout a single round may risk.
    function maxRoundExposure() public view returns (uint256) {
        return bankroll / EXPOSURE_DIVISOR;
    }

    // ------------------------------------------------------------ gameplay

    /**
     * @notice Open a round and place all bets atomically.
     * @param windowId the window being played
     * @param ts       cell time indices
     * @param ps       cell price-band indices
     * @param amounts  stake per cell
     */
    function openRound(bytes32 windowId, uint8[] calldata ts, uint8[] calldata ps, uint128[] calldata amounts)
        external
        payable
        returns (uint256 roundId)
    {
        if (paused) revert GamePaused();
        if (ts.length == 0 || ts.length != ps.length || ts.length != amounts.length) revert NoBets();

        (uint256 totalStake, uint256 maxPayout) = _priceBets(windowId, ts, ps, amounts);

        if (msg.value != totalStake) revert StakeMismatch(msg.value, totalStake);

        // Worst case: every cell hits. Cap it against the bankroll.
        uint256 cap = maxRoundExposure();
        if (maxPayout > cap) revert ExposureTooHigh(maxPayout, cap);

        roundId = nextRoundId++;
        rounds[roundId] = Round({
            player: msg.sender,
            windowId: windowId,
            state: RoundState.Open,
            openedAt: uint64(block.timestamp),
            staked: uint128(totalStake),
            paidOut: 0
        });
        for (uint256 i = 0; i < ts.length; i++) {
            betsOf[roundId].push(Bet({t: ts[i], p: ps[i], amount: amounts[i]}));
        }

        // stake joins the bankroll; payouts come back out of it
        bankroll += totalStake;
        if (bankroll > bankrollPeak) bankrollPeak = bankroll;

        emit RoundOpened(roundId, msg.sender, windowId, totalStake);
    }

    /**
     * @dev Validate every cell and compute the total stake plus the worst-case payout.
     *      Split out of openRound purely to keep the stack shallow enough for solc.
     */
    function _priceBets(bytes32 windowId, uint8[] calldata ts, uint8[] calldata ps, uint128[] calldata amounts)
        private
        view
        returns (uint256 totalStake, uint256 maxPayout)
    {
        (uint8 timeSteps, uint8 priceBands) = registry.gridDims(windowId);
        uint256 limit = maxBet();

        for (uint256 i = 0; i < ts.length; i++) {
            if (ts[i] >= timeSteps || ps[i] >= priceBands) revert CellOutOfRange(ts[i], ps[i]);
            if (amounts[i] == 0 || amounts[i] > limit) revert BetTooLarge(amounts[i], limit);

            // reject duplicate cells so payout accounting stays simple
            for (uint256 j = 0; j < i; j++) {
                if (ts[j] == ts[i] && ps[j] == ps[i]) revert DuplicateCell(ts[i], ps[i]);
            }

            totalStake += amounts[i];
            maxPayout += (uint256(amounts[i]) * uint256(registry.multiplierAt(windowId, ts[i], ps[i]))) / MULT_SCALE;
        }
    }

    /**
     * @notice Resolve a round by revealing the hidden candles with Merkle proofs.
     * @dev Permissionless — the operator cannot withhold an outcome that pays the player.
     *      `indices`, `blockNumbers` and `sqrtPrices` describe candle t of the hidden series,
     *      in order, one per grid time step.
     */
    function resolveRound(
        uint256 roundId,
        uint256[] calldata indices,
        uint64[] calldata blockNumbers,
        uint160[] calldata sqrtPrices,
        bytes32[][] calldata proofs
    ) external {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Open) revert WrongRoundState(roundId);

        (uint8 timeSteps,) = registry.gridDims(r.windowId);
        if (indices.length != timeSteps) revert RevealCountMismatch(timeSteps, indices.length);
        if (blockNumbers.length != timeSteps || sqrtPrices.length != timeSteps || proofs.length != timeSteps) {
            revert RevealCountMismatch(timeSteps, blockNumbers.length);
        }

        // Verify each revealed candle against the committed root, then map it to a band.
        int256[] memory bands = new int256[](timeSteps);
        for (uint256 t = 0; t < timeSteps; t++) {
            bool ok = registry.verifyCandle(r.windowId, indices[t], blockNumbers[t], sqrtPrices[t], proofs[t]);
            if (!ok) revert BadCandleProof(indices[t]);
            bands[t] = registry.bandOf(r.windowId, sqrtPrices[t]);
        }

        // Pay every bet whose cell the real path crossed.
        uint256 payout;
        Bet[] storage bets = betsOf[roundId];
        for (uint256 i = 0; i < bets.length; i++) {
            int256 landed = bands[bets[i].t];
            if (landed >= 0 && uint256(landed) == uint256(bets[i].p)) {
                uint32 mult = registry.multiplierAt(r.windowId, bets[i].t, bets[i].p);
                payout += (uint256(bets[i].amount) * uint256(mult)) / MULT_SCALE;
            }
        }

        r.state = RoundState.Resolved;
        r.paidOut = uint128(payout);

        if (payout > 0) {
            if (payout > bankroll) revert InsufficientBankroll(payout, bankroll);
            bankroll -= payout;
            payable(r.player).transfer(payout);
        }

        _checkDrawdown();
        emit RoundResolved(roundId, r.player, payout);
    }

    /// @notice Reclaim a stake from a round nobody resolved.
    function reclaim(uint256 roundId) external {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Open) revert WrongRoundState(roundId);
        if (msg.sender != r.player) revert NotPlayer();
        if (block.timestamp < r.openedAt + ROUND_TIMEOUT) revert TooEarlyToReclaim();

        uint256 amount = r.staked;
        r.state = RoundState.Reclaimed;
        if (amount > bankroll) revert InsufficientBankroll(amount, bankroll);
        bankroll -= amount;
        payable(r.player).transfer(amount);

        emit RoundReclaimed(roundId, r.player, amount);
    }

    /// @dev Halt the game if the bankroll has fallen too far from its peak.
    function _checkDrawdown() private {
        if (bankrollPeak == 0 || paused) return;
        uint256 floorValue = (bankrollPeak * (100 - MAX_DRAWDOWN_PCT)) / 100;
        if (bankroll < floorValue) {
            paused = true;
            emit Paused("drawdown breaker");
        }
    }

    // --------------------------------------------------------------- views

    function betCount(uint256 roundId) external view returns (uint256) {
        return betsOf[roundId].length;
    }

    function getBets(uint256 roundId) external view returns (Bet[] memory) {
        return betsOf[roundId];
    }

}
