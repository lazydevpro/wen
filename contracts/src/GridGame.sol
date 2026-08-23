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
 * ── Why the round entry points are payable ──────────────────────────────────────────────────
 *
 * Rounds draw from an on-chain balance so winnings can be credited rather than transferred.
 * But a mandatory deposit-first step was pure friction: the player signs startRound anyway,
 * and attaching value to a transaction they are already signing costs no extra interaction.
 * So startRound and settleRound accept value and credit it before their own accounting —
 * a brand-new wallet goes faucet → deal in one popup, and the balance remains what winnings
 * accumulate into. deposit() stays for topping up without playing.
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
     * @dev Every UNRESOLVED round's worst case, summed, may not exceed bankroll/TOTAL_EXPOSURE_DIVISOR.
     *      EXPOSURE_DIVISOR alone bounds one round; it says nothing about eighty at once. Opening
     *      80 rounds and only then resolving them drained 93.7% of the bankroll straight through a
     *      breaker set at 30%, because the breaker only ever gated startRound.
     */
    uint256 public constant TOTAL_EXPOSURE_DIVISOR = 4;

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

    /**
     * @dev Hidden candles between the anchor and the first bettable column.
     *
     * The chart travels before the grid begins: two steps of runway, so the path is already
     * moving when it reaches the cells rather than starting pinned to the anchor. That also
     * spreads the distribution over the first column, which used to be so concentrated that a
     * single cell carried most of the probability.
     */
    uint256 public constant GRID_LEAD_STEPS = 2;

    uint256 public constant MULT_SCALE = 1e4;
    uint256 public constant MAX_DRAWDOWN_PCT = 30;

    /**
     * @dev Simple mode: one bet on whether the final hidden candle closes above the anchor.
     *
     * The two sides are NOT priced the same, because the window pool is not a fair coin. Measured
     * over all 120 registered windows the final candle closes up 65 times and down 55 — 54.2% up.
     * Paying both sides alike would hand an "always UP" bot near break-even, a house that loses
     * to a script with no knowledge at all. Pricing each side against its own measured frequency
     * keeps every fixed strategy negative, at the same ~10% house edge the grid now carries:
     *
     *   always UP     0.542 * 1.70 = 0.921     always DOWN  0.458 * 1.90 = 0.870
     *   coin flip     mixes to 0.896
     *
     * Break-even needs 58.8% accuracy on UP calls (52.6% on DOWN) — reachable by actually reading
     * the era, not by guessing. Re-measure with `pnpm sweep-span` if the pool changes materially;
     * 120 windows puts roughly +/-9% of confidence on that 54.2%.
     */
    uint32 public constant DIRECTION_UP_MULT = 17000; // 1.70x
    uint32 public constant DIRECTION_DOWN_MULT = 19000; // 1.90x

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
        /** block the bets landed in — resolution must come strictly after it */
        uint64 settledBlock;
        uint128 ante;
        uint128 staked;
        /** worst case this round can pay; held in outstandingExposure until it resolves */
        uint128 maxPayout;
        uint128 paidOut;
    }

    ChartRegistry public immutable registry;
    address public owner;

    uint256 public bankroll;
    uint256 public bankrollPeak;
    /** sum of maxPayout across settled-but-unresolved rounds */
    uint256 public outstandingExposure;
    bool public paused;

    /// @notice Player credit. Deposit once, play many rounds without moving value each time.
    mapping(address => uint256) public balances;

    uint256 public nextRoundId = 1;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => Bet[]) public betsOf;

    /// @dev Kept out of Round: that struct already sits close to the stack limit at call sites.
    struct DirectionBet {
        bool active;
        bool up;
    }

    mapping(uint256 => DirectionBet) public directionBets;

    event Deposited(address indexed player, uint256 amount, uint256 balance);
    event Withdrawn(address indexed player, uint256 amount, uint256 balance);
    event BankrollFunded(address indexed from, uint256 amount, uint256 total);
    event RoundDealt(uint256 indexed roundId, address indexed player, uint128 ante, uint64 deadlineBlock, uint64 revealBlock);
    event RoundSettled(uint256 indexed roundId, address indexed player, uint256 staked, uint256 maxPayout);
    event DirectionSettled(uint256 indexed roundId, address indexed player, bool up, uint256 staked, uint256 maxPayout);
    event RoundResolved(uint256 indexed roundId, address indexed player, uint256 payout);
    event RoundExpired(uint256 indexed roundId, address indexed player, uint128 anteForfeited);
    event Paused(string reason);
    event Unpaused();

    error NotOwner();
    error GamePaused();
    error UnknownRound(uint256 roundId);
    error WindowNotYetKnown(uint256 revealBlock, uint256 currentBlock);
    error WindowExpired(uint256 revealBlock);
    error TooSoonToResolve(uint64 settledBlock, uint256 currentBlock);
    error TotalExposureTooHigh(uint256 requested, uint256 cap);
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
    error WrongCandleIndex(uint256 expected, uint256 got);

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
        _creditValue();
    }

    /// @dev Credit attached value to the sender's balance before any round accounting runs.
    ///      Excess simply stays as withdrawable credit; a shortfall still reverts with
    ///      InsufficientBalance, so the caller never needs to attach an exact amount.
    function _creditValue() private {
        if (msg.value > 0) {
            balances[msg.sender] += msg.value;
            emit Deposited(msg.sender, msg.value, balances[msg.sender]);
        }
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
    function startRound(uint128 ante) external payable returns (uint256 roundId) {
        _creditValue();
        if (paused) revert GamePaused();
        if (ante == 0) revert AnteTooSmall();

        uint256 limit = maxBet();
        if (ante > limit) revert BetTooLarge(ante, limit);

        uint256 bal = balances[msg.sender];
        if (ante > bal) revert InsufficientBalance(ante, bal);

        uint256 n = registry.windowCount();
        if (n == 0) revert NoWindows();

        roundId = nextRoundId++;
        // The window is NOT chosen here. It is derived from the hash of the NEXT block, which does
        // not exist yet, so this transaction cannot learn which window it drew. That is what makes
        // the ante real: a contract used to call startRound, inspect the returned windowId and
        // revert the whole transaction if it did not like it, paying nothing to look.

        balances[msg.sender] = bal - ante;
        bankroll += ante;
        if (bankroll > bankrollPeak) bankrollPeak = bankroll;

        rounds[roundId] = Round({
            player: msg.sender,
            windowId: bytes32(0),
            state: RoundState.Dealt,
            startBlock: uint64(block.number),
            settledBlock: 0,
            ante: ante,
            staked: ante,
            maxPayout: 0,
            paidOut: 0
        });

        emit RoundDealt(roundId, msg.sender, ante, uint64(block.number + DECISION_BLOCKS), uint64(block.number));
    }

    /**
     * @notice The window a round drew. Unknowable until the block after the deal is mined.
     * @dev blockhash only reaches back 256 blocks; DECISION_BLOCKS is 20, so a round that can
     *      still be settled can always be read. Past the deadline the ante is forfeit anyway.
     */
    function windowOf(uint256 roundId) public view returns (bytes32) {
        Round storage r = rounds[roundId];
        if (r.player == address(0)) revert UnknownRound(roundId);
        if (r.windowId != bytes32(0)) return r.windowId; // fixed at settle
        // The DEAL block's own hash. A block cannot know its own hash, so this is still
        // unreadable while startRound executes — nothing to peek at, nothing to revert away from.
        // But it lands one block sooner than startBlock+1 did, and the client can derive it
        // straight from the deal receipt without waiting for a contract call at all.
        uint256 revealBlock = uint256(r.startBlock);
        if (block.number <= revealBlock) revert WindowNotYetKnown(revealBlock, block.number);
        bytes32 bh = blockhash(revealBlock);
        if (bh == bytes32(0)) revert WindowExpired(revealBlock);
        uint256 n = registry.windowCount();
        return registry.windowIds(uint256(keccak256(abi.encodePacked(bh, r.player, roundId))) % n);
    }

    /// @dev Reserve a round's worst case against the pool-wide ceiling.
    function _reserveExposure(uint256 maxPayout) private {
        uint256 total = outstandingExposure + maxPayout;
        uint256 totalCap = bankroll / TOTAL_EXPOSURE_DIVISOR;
        if (total > totalCap) revert TotalExposureTooHigh(total, totalCap);
        outstandingExposure = total;
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
        payable
    {
        _creditValue();
        Round storage r = rounds[roundId];
        if (r.state != RoundState.Dealt) revert WrongRoundState(roundId);
        if (msg.sender != r.player) revert NotPlayer();
        if (block.number > deadlineOf(roundId)) revert DecisionWindowClosed(uint64(deadlineOf(roundId)), block.number);
        if (ts.length == 0 || ts.length != ps.length || ts.length != amounts.length) revert NoBets();

        // One block must separate the deal from the bets, which is also when the window becomes
        // knowable. Without it a contract can deal, look, bet and resolve inside one transaction
        // and the decision clock means nothing.
        bytes32 wid = windowOf(roundId);
        r.windowId = wid;

        (uint256 totalStake, uint256 maxPayout) = _priceBets(wid, ts, ps, amounts);
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
        _reserveExposure(maxPayout);

        for (uint256 i = 0; i < ts.length; i++) {
            betsOf[roundId].push(Bet({t: ts[i], p: ps[i], amount: amounts[i]}));
        }

        r.staked = uint128(totalStake);
        r.maxPayout = uint128(maxPayout);
        r.settledBlock = uint64(block.number);
        r.state = RoundState.Settled;

        emit RoundSettled(roundId, msg.sender, totalStake, maxPayout);
    }

    /**
     * @notice Simple mode: one bet on the direction of the final hidden candle.
     * @dev An alternative to settleRound, not an addition — a round settles one way or the other.
     *      Everything before this point is identical, so the blind deal and the forfeit economics
     *      that make "pay to look" real are untouched; only the shape of the bet differs.
     */
    function settleDirection(uint256 roundId, bool up, uint128 stake) external payable {
        _creditValue();

        Round storage r = rounds[roundId];
        if (r.state != RoundState.Dealt) revert WrongRoundState(roundId);
        if (msg.sender != r.player) revert NotPlayer();
        if (block.number > deadlineOf(roundId)) revert DecisionWindowClosed(uint64(deadlineOf(roundId)), block.number);

        // One block must separate the deal from the bets, which is also when the window becomes
        // knowable. Without it a contract can deal, look, bet and resolve inside one transaction
        // and the decision clock means nothing.
        bytes32 wid = windowOf(roundId);
        r.windowId = wid;

        uint256 limit = maxBet();
        if (stake == 0 || stake > limit) revert BetTooLarge(stake, limit);
        if (stake < r.ante) revert StakeBelowAnte(stake, r.ante);

        uint256 maxPayout = (uint256(stake) * uint256(up ? DIRECTION_UP_MULT : DIRECTION_DOWN_MULT)) / MULT_SCALE;
        uint256 cap = maxRoundExposure();
        if (maxPayout > cap) revert ExposureTooHigh(maxPayout, cap);
        _reserveExposure(maxPayout);

        // the ante is already held; take only the difference
        uint256 extra = uint256(stake) - uint256(r.ante);
        if (extra > 0) {
            uint256 bal = balances[msg.sender];
            if (extra > bal) revert InsufficientBalance(extra, bal);
            balances[msg.sender] = bal - extra;
            bankroll += extra;
            if (bankroll > bankrollPeak) bankrollPeak = bankroll;
        }

        directionBets[roundId] = DirectionBet({active: true, up: up});
        r.staked = stake;
        r.maxPayout = uint128(maxPayout);
        r.settledBlock = uint64(block.number);
        r.state = RoundState.Settled;

        emit DirectionSettled(roundId, msg.sender, up, stake, maxPayout);
    }

    /**
     * @dev Did the final candle close above the anchor?
     *
     * Deliberately NOT derived from bandOf(): that returns -1 whenever the price leaves the grid,
     * which is 20% of windows in the current pool — exactly the big moves, and precisely the case
     * where the direction is least ambiguous. Losing the sign there would misresolve one round in
     * five.
     *
     * Compared in sqrtPriceX96 space, so no price is ever materialised. Under `invert` the quote
     * is token0/token1, so a RISING price is a FALLING sqrtPriceX96 — get this backwards and every
     * payout inverts.
     */
    function _closedUp(bytes32 windowId, uint160 finalSqrtPriceX96) private view returns (bool) {
        (,, uint160 anchorSqrt,,,,,, bool invert,,) = registry.windows(windowId);
        return invert ? finalSqrtPriceX96 < anchorSqrt : finalSqrtPriceX96 > anchorSqrt;
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
        // Resolution in the settling block would let one transaction deal, bet and collect.
        if (block.number <= r.settledBlock) revert TooSoonToResolve(r.settledBlock, block.number);

        (uint8 timeSteps,) = registry.gridDims(r.windowId);
        if (
            indices.length != timeSteps || blockNumbers.length != timeSteps || sqrtPrices.length != timeSteps
                || proofs.length != timeSteps
        ) revert RevealCountMismatch(timeSteps, indices.length);

        // A Merkle proof only says "this candle belongs to this window" — it says nothing about
        // WHICH candle, and resolution is permissionless with caller-supplied indices. Without
        // pinning the position, a player could submit one winning candle in all eight slots and
        // collect on every column; measured at 19x the honest payout before this check existed.
        uint256 firstIdx = _firstOutcomeIndex(r.windowId);
        int256[] memory bands = new int256[](timeSteps);
        for (uint256 t = 0; t < timeSteps; t++) {
            if (indices[t] != firstIdx + t) revert WrongCandleIndex(firstIdx + t, indices[t]);
            if (!registry.verifyCandle(r.windowId, indices[t], blockNumbers[t], sqrtPrices[t], proofs[t])) {
                revert BadCandleProof(indices[t]);
            }
            bands[t] = registry.bandOf(r.windowId, sqrtPrices[t]);
        }

        uint256 payout = directionBets[roundId].active
            ? _directionPayout(roundId, r.windowId, r.staked, sqrtPrices[timeSteps - 1])
            : _gridPayout(roundId, r.windowId, bands);

        r.state = RoundState.Resolved;
        r.paidOut = uint128(payout);
        // release the reservation now the round can never pay again
        outstandingExposure -= r.maxPayout;

        if (payout > 0) {
            if (payout > bankroll) revert InsufficientBankroll(payout, bankroll);
            bankroll -= payout;
            balances[r.player] += payout;
        }

        _checkDrawdown();
        emit RoundResolved(roundId, r.player, payout);
    }

    /// @dev Index of the first bettable candle: past the visible run, past the runway.
    function _firstOutcomeIndex(bytes32 windowId) private view returns (uint256) {
        (,,,,, uint16 visibleCount,,,,,) = registry.windows(windowId);
        return uint256(visibleCount) + GRID_LEAD_STEPS;
    }

    /// @dev Both payout shapes live outside resolveRound; inlining either blows the stack.
    function _gridPayout(uint256 roundId, bytes32 windowId, int256[] memory bands)
        private
        view
        returns (uint256 payout)
    {
        Bet[] storage bets = betsOf[roundId];
        for (uint256 i = 0; i < bets.length; i++) {
            int256 landed = bands[bets[i].t];
            if (landed >= 0 && uint256(landed) == uint256(bets[i].p)) {
                payout += (uint256(bets[i].amount) * uint256(registry.multiplierAt(windowId, bets[i].t, bets[i].p)))
                    / MULT_SCALE;
            }
        }
    }

    function _directionPayout(uint256 roundId, bytes32 windowId, uint128 staked, uint160 finalSqrtPriceX96)
        private
        view
        returns (uint256)
    {
        // the candle was proven by the caller before this runs
        bool up = _closedUp(windowId, finalSqrtPriceX96);
        if (up != directionBets[roundId].up) return 0;
        return (uint256(staked) * uint256(up ? DIRECTION_UP_MULT : DIRECTION_DOWN_MULT)) / MULT_SCALE;
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
