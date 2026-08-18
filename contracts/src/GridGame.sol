// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ChartRegistry} from "./ChartRegistry.sol";

/**
 * @title GridGame
 * @notice Hindsight's betting layer. Players ante up, get dealt a random slice of real Ethereum
 *         history, and bet a (time x price) grid on what happened next.
 *
 * ── Why two transactions per round ──────────────────────────────────────────────────────────
 *
 * The player must not see the chart before paying. Otherwise they can deal, reverse-search the
 * candle series against public price history, and walk away for free — which is exactly the
 * attack this design exists to price. So:
 *
 *   1. startRound(ante)  — debits the ante and ASSIGNS THE WINDOW ON-CHAIN. Only after this
 *                          transaction lands does the client learn which window it is.
 *   2. settleRound(...)  — places bets, and must arrive within DECISION_BLOCKS.
 *
 * The ante is not a fee: it counts toward the player's stake, so an honest player pays nothing
 * extra. A player who deals and walks away forfeits it. That is the whole point.
 *
 * Players deposit once and rounds draw from an on-chain balance, so per-round transactions are
 * signatures rather than value transfers.
 *
 * Testnet only — CTC here has no value, so this is game mechanics rather than a gambling
 * operation. The bankroll controls are real because getting them right is the interesting work.
 */
contract GridGame {
    /// @dev bankroll must be this many times the max single bet (1% ruin risk at sigma ~2.54)
    uint256 public constant BANKROLL_RATIO = 400;

    /**
     * @dev A single round may never risk more than 1/EXPOSURE_DIVISOR of the bankroll.
     *
     * Started at 50 (2% of bankroll). That made a large share of the grid unbettable: at a
     * 4000 CTC bankroll the cap was 80 CTC, so a 250x cell could only carry 0.32 CTC — less
     * than the smallest sensible ante. Players picked a long-shot cell, got refused, and lost
     * the ante to the clock. 20 (5% of bankroll) keeps the round bounded while letting an
     * ante actually sit on a long-shot cell.
     */
    uint256 public constant EXPOSURE_DIVISOR = 20;

    /**
     * @dev How long the player has to settle, in blocks, counted from startRound.
     *
     * The budget is not just the player's thinking time. From startRound's block it must cover
     * the deal confirming before the chart is drawn, the 45s client countdown, the player
     * reaching for their wallet and confirming, and the settle being mined.
     *
     * 4 blocks then 8 both proved too tight in real play — testers lost antes to the clock
     * while a wallet prompt sat unconfirmed. 20 blocks (~5 min) is generous for a human and
     * changes nothing for an attacker: a bot that can cross-correlate a chart against public
     * price history does it in seconds, so tightening this punishes only honest players.
     */
    uint256 public constant DECISION_BLOCKS = 20;

    /// @dev unresolved rounds become reclaimable after this long
    uint256 public constant ROUND_TIMEOUT = 1 days;

    uint256 public constant MULT_SCALE = 1e4;
    uint256 public constant MAX_DRAWDOWN_PCT = 30;

    enum RoundState {
        None,
        Dealt, // ante paid, window assigned, awaiting bets
        Settled, // bets placed, awaiting resolution
        Resolved,
        Expired
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
        uint64 startBlock;
        uint64 settledAt;
        uint128 ante;
        uint128 staked;
        uint128 paidOut;
    }

    ChartRegistry public immutable registry;
    address public owner;

    uint256 public bankroll;
    uint256 public bankrollPeak;
    bool public paused;

    /// @notice Player credit. Deposit once, play many rounds without moving value each time.
    mapping(address => uint256) public balances;

    uint256 public nextRoundId = 1;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => Bet[]) public betsOf;

    event Deposited(address indexed player, uint256 amount, uint256 balance);
    event Withdrawn(address indexed player, uint256 amount, uint256 balance);
    event BankrollFunded(address indexed from, uint256 amount, uint256 total);
    event RoundDealt(uint256 indexed roundId, address indexed player, bytes32 indexed windowId, uint128 ante, uint64 deadlineBlock);
    event RoundSettled(uint256 indexed roundId, address indexed player, uint256 staked, uint256 maxPayout);
    event RoundResolved(uint256 indexed roundId, address indexed player, uint256 payout);
    event RoundExpired(uint256 indexed roundId, address indexed player, uint128 anteForfeited);
    event Paused(string reason);
    event Unpaused();

    error NotOwner();
    error GamePaused();
    error NoWindows();
    error NoBets();
    error InsufficientBalance(uint256 needed, uint256 have);
    error AnteTooSmall();
    error BetTooLarge(uint256 amount, uint256 maxBet);
    error StakeBelowAnte(uint256 staked, uint128 ante);
    error ExposureTooHigh(uint256 maxPayout, uint256 cap);
    error CellOutOfRange(uint8 t, uint8 p);
    error DuplicateCell(uint8 t, uint8 p);
    error WrongRoundState(uint256 roundId);
    error NotPlayer();
    error DecisionWindowClosed(uint64 deadlineBlock, uint256 current);
    error DecisionWindowStillOpen(uint64 deadlineBlock, uint256 current);
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
        if (p) emit Paused("manual");
        else emit Unpaused();
    }

    function maxBet() public view returns (uint256) {
        return bankroll / BANKROLL_RATIO;
    }

    function maxRoundExposure() public view returns (uint256) {
        return bankroll / EXPOSURE_DIVISOR;
    }

    // ------------------------------------------------------- player credit

    function deposit() external payable {
        balances[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value, balances[msg.sender]);
    }

    function withdraw(uint256 amount) external {
        uint256 bal = balances[msg.sender];
        if (amount > bal) revert InsufficientBalance(amount, bal);
        balances[msg.sender] = bal - amount;
        payable(msg.sender).transfer(amount);
        emit Withdrawn(msg.sender, amount, balances[msg.sender]);
    }

    // ---------------------------------------------------------------- deal

    /**
     * @notice Pay the ante and be dealt a random window. The client cannot know which window
     *         it is until this transaction lands — that is what makes "pay to look" real.
     *
     * @dev Window selection uses blockhash. A validator could in principle steer which window a
     *      player receives, but every window carries the same house edge, so there is nothing to
     *      gain. This is deliberately NOT used for anything that decides a payout.
     */
    function startRound(uint128 ante) external returns (uint256 roundId, bytes32 windowId) {
        if (paused) revert GamePaused();
        if (ante == 0) revert AnteTooSmall();

        uint256 limit = maxBet();
        if (ante > limit) revert BetTooLarge(ante, limit);

        uint256 bal = balances[msg.sender];
        if (ante > bal) revert InsufficientBalance(ante, bal);

        uint256 n = registry.windowCount();
        if (n == 0) revert NoWindows();

        roundId = nextRoundId++;
        uint256 seed = uint256(keccak256(abi.encodePacked(blockhash(block.number - 1), msg.sender, roundId)));
        windowId = registry.windowIds(seed % n);

        balances[msg.sender] = bal - ante;
        bankroll += ante;
        if (bankroll > bankrollPeak) bankrollPeak = bankroll;

        rounds[roundId] = Round({
            player: msg.sender,
            windowId: windowId,
            state: RoundState.Dealt,
            startBlock: uint64(block.number),
            settledAt: 0,
            ante: ante,
            staked: ante,
            paidOut: 0
        });

        emit RoundDealt(roundId, msg.sender, windowId, ante, uint64(block.number + DECISION_BLOCKS));
    }

    /// @notice Block after which a dealt round can no longer be settled.
    function deadlineOf(uint256 roundId) public view returns (uint256) {
        return uint256(rounds[roundId].startBlock) + DECISION_BLOCKS;
    }

    // -------------------------------------------------------------- settle

    /**
     * @notice Place bets on a dealt round. Must arrive within the decision window.
     * @dev Total stake must be at least the ante — the ante counts toward the bet rather than
     *      being an extra fee, so an honest player pays nothing for the privilege of looking.
     */
    function settleRound(uint256 roundId, uint8[] calldata ts, uint8[] calldata ps, uint128[] calldata amounts)
        external
    {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Dealt) revert WrongRoundState(roundId);
        if (msg.sender != r.player) revert NotPlayer();
        if (block.number > deadlineOf(roundId)) revert DecisionWindowClosed(uint64(deadlineOf(roundId)), block.number);
        if (ts.length == 0 || ts.length != ps.length || ts.length != amounts.length) revert NoBets();

        (uint256 totalStake, uint256 maxPayout) = _priceBets(r.windowId, ts, ps, amounts);
        if (totalStake < r.ante) revert StakeBelowAnte(totalStake, r.ante);

        // the ante is already held; take only the difference
        uint256 extra = totalStake - r.ante;
        if (extra > 0) {
            uint256 bal = balances[msg.sender];
            if (extra > bal) revert InsufficientBalance(extra, bal);
            balances[msg.sender] = bal - extra;
            bankroll += extra;
            if (bankroll > bankrollPeak) bankrollPeak = bankroll;
        }

        uint256 cap = maxRoundExposure();
        if (maxPayout > cap) revert ExposureTooHigh(maxPayout, cap);

        for (uint256 i = 0; i < ts.length; i++) {
            betsOf[roundId].push(Bet({t: ts[i], p: ps[i], amount: amounts[i]}));
        }

        r.staked = uint128(totalStake);
        r.settledAt = uint64(block.timestamp);
        r.state = RoundState.Settled;

        emit RoundSettled(roundId, msg.sender, totalStake, maxPayout);
    }

    /// @dev Split out of settleRound to keep the stack shallow enough for solc.
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

            for (uint256 j = 0; j < i; j++) {
                if (ts[j] == ts[i] && ps[j] == ps[i]) revert DuplicateCell(ts[i], ps[i]);
            }

            totalStake += amounts[i];
            maxPayout += (uint256(amounts[i]) * uint256(registry.multiplierAt(windowId, ts[i], ps[i]))) / MULT_SCALE;
        }
    }

    /**
     * @notice Close out a dealt round nobody settled in time. The ante stays with the house.
     * @dev Permissionless — this is what prices "deal, reverse-search, walk away".
     */
    function expireRound(uint256 roundId) external {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Dealt) revert WrongRoundState(roundId);
        if (block.number <= deadlineOf(roundId)) {
            revert DecisionWindowStillOpen(uint64(deadlineOf(roundId)), block.number);
        }
        r.state = RoundState.Expired;
        emit RoundExpired(roundId, r.player, r.ante);
    }

    // ------------------------------------------------------------- resolve

    /**
     * @notice Resolve a settled round by revealing the hidden candles with Merkle proofs.
     * @dev Permissionless — the operator cannot withhold an outcome that pays the player.
     *      Winnings are credited to the player's balance rather than transferred, so a hostile
     *      receiver cannot block resolution.
     */
    function resolveRound(
        uint256 roundId,
        uint256[] calldata indices,
        uint64[] calldata blockNumbers,
        uint160[] calldata sqrtPrices,
        bytes32[][] calldata proofs
    ) external {
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Settled) revert WrongRoundState(roundId);

        (uint8 timeSteps,) = registry.gridDims(r.windowId);
        if (
            indices.length != timeSteps || blockNumbers.length != timeSteps || sqrtPrices.length != timeSteps
                || proofs.length != timeSteps
        ) revert RevealCountMismatch(timeSteps, indices.length);

        int256[] memory bands = new int256[](timeSteps);
        for (uint256 t = 0; t < timeSteps; t++) {
            if (!registry.verifyCandle(r.windowId, indices[t], blockNumbers[t], sqrtPrices[t], proofs[t])) {
                revert BadCandleProof(indices[t]);
            }
            bands[t] = registry.bandOf(r.windowId, sqrtPrices[t]);
        }

        uint256 payout;
        Bet[] storage bets = betsOf[roundId];
        for (uint256 i = 0; i < bets.length; i++) {
            int256 landed = bands[bets[i].t];
            if (landed >= 0 && uint256(landed) == uint256(bets[i].p)) {
                payout += (uint256(bets[i].amount) * uint256(registry.multiplierAt(r.windowId, bets[i].t, bets[i].p)))
                    / MULT_SCALE;
            }
        }

        r.state = RoundState.Resolved;
        r.paidOut = uint128(payout);

        if (payout > 0) {
            if (payout > bankroll) revert InsufficientBankroll(payout, bankroll);
            bankroll -= payout;
            balances[r.player] += payout;
        }

        _checkDrawdown();
        emit RoundResolved(roundId, r.player, payout);
    }

    function _checkDrawdown() private {
        if (bankrollPeak == 0 || paused) return;
        if (bankroll < (bankrollPeak * (100 - MAX_DRAWDOWN_PCT)) / 100) {
            paused = true;
            emit Paused("drawdown breaker");
        }
    }

    // --------------------------------------------------------------- views

    /// @notice Narrow round view. The full struct has enough fields to blow the stack at
    ///         call sites, and callers rarely want all of them.
    function roundSummary(uint256 roundId)
        external
        view
        returns (address player, bytes32 windowId, RoundState state, uint128 ante, uint128 staked, uint128 paidOut)
    {
        Round storage r = rounds[roundId];
        return (r.player, r.windowId, r.state, r.ante, r.staked, r.paidOut);
    }

    function betCount(uint256 roundId) external view returns (uint256) {
        return betsOf[roundId].length;
    }

    function getBets(uint256 roundId) external view returns (Bet[] memory) {
        return betsOf[roundId];
    }
}
