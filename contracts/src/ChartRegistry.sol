// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IChartVerifier {
    /// @notice sqrtPriceX96 proven through Attestcoin for a (pool, source block); 0 if never proven.
    function provenPrice(address pool, uint64 blockNumber) external view returns (uint160);
}

/**
 * @title ChartRegistry
 * @notice Registry of playable Hindsight windows.
 *
 * A window is a slice of real Ethereum history, committed as a Merkle root so hidden candles can
 * be revealed one at a time with inclusion proofs.
 *
 * WHY REGISTRATION LOOKS THE WAY IT DOES
 * An earlier version took `merkleRoot`, `anchorSqrtPriceX96` and the visible series as operator
 * calldata and validated two array lengths. That made the root a *statement* rather than a fact:
 * a Merkle proof answers "is this candle inside the set I committed", never "did this happen on
 * Ethereum", so a wholly invented window — candles at block heights that do not exist — passed
 * every on-chain check. Attestcoin sat upstream in ChartVerifier and nothing consulted it, which
 * meant the game's real trust root was the deployer's key.
 *
 * So the operator no longer supplies chart data at all. It supplies the candle series, and this
 * contract:
 *   1. refuses any candle whose (pool, block, price) was not proven through Attestcoin, and
 *   2. DERIVES the merkle root, the anchor and the visible series from those proven candles.
 *
 * The root is therefore provably a root over real Ethereum swaps, and forging a window stops
 * being dishonest and starts being impossible. Registration costs more gas; it happens once per
 * window and the alternative is a claim nobody can check.
 *
 * The multiplier grid is stored here too. It is derived from VISIBLE candles only; because the
 * visible candles are on-chain, anyone can recompute the grid and check that no future data
 * influenced the odds.
 */
contract ChartRegistry {
    uint256 public constant SCALE = 1e18;
    /** multipliers are stored scaled by 1e4, e.g. 2.27x -> 22700 */
    uint256 public constant MULT_SCALE = 1e4;

    struct Window {
        bool exists;
        bytes32 merkleRoot;
        /** sqrtPriceX96 at the last visible candle — the grid is centred here */
        uint160 anchorSqrtPriceX96;
        /** band height as a fraction of anchor price, scaled by 1e18 */
        uint256 bandHeight;
        uint16 totalCandles;
        uint16 visibleCount;
        uint8 timeSteps;
        uint8 priceBands;
        /** true when price = token0/token1 (e.g. USDC/WETH -> ETH in USDC) */
        bool invert;
        string eraLabel;
        /** keccak of the riddle text, so the riddle can be served off-chain but pinned on-chain */
        bytes32 riddleHash;
    }

    address public owner;

    /// @notice The Attestcoin verifier every candle must have passed through. Immutable so the
    ///         provenance check cannot be pointed at a friendlier contract after deployment.
    IChartVerifier public immutable verifier;

    mapping(bytes32 => Window) public windows;
    /** flattened grid multipliers, index = t * priceBands + p */
    mapping(bytes32 => uint32[]) public gridMultipliers;
    /** visible candles, revealed at registration so players (and auditors) can see them */
    mapping(bytes32 => uint160[]) public visibleSqrtPrices;
    bytes32[] public windowIds;

    event WindowRegistered(bytes32 indexed windowId, string eraLabel, bytes32 merkleRoot, uint16 totalCandles);

    error NotOwner();
    error WindowExists(bytes32 windowId);
    error UnknownWindow(bytes32 windowId);
    error GridSizeMismatch(uint256 expected, uint256 got);
    error VisibleCountMismatch(uint256 expected, uint256 got);
    error BadMerkleProof(uint256 candleIndex);
    error CandleCountMismatch(uint256 expected, uint256 got);
    /// @notice This candle was never proven through Attestcoin, or was proven at a different price.
    error CandleNotProven(uint256 candleIndex, uint64 blockNumber);
    error NoCandles();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(IChartVerifier _verifier) {
        owner = msg.sender;
        verifier = _verifier;
    }

    struct RegisterParams {
        bytes32 windowId;
        /** the Uniswap pool these candles were proven from, as allowlisted in ChartVerifier */
        address pool;
        uint256 bandHeight;
        uint16 visibleCount;
        uint8 timeSteps;
        uint8 priceBands;
        bool invert;
        string eraLabel;
        bytes32 riddleHash;
        uint32[] multipliers;
        /**
         * The full candle series in index order. `merkleRoot`, `anchorSqrtPriceX96`, `visible`
         * and `totalCandles` used to be supplied alongside this and are now derived from it —
         * anything the operator can state independently is something the operator can lie about.
         */
        uint64[] blockNumbers;
        uint160[] sqrtPrices;
    }

    function registerWindow(RegisterParams calldata p) external onlyOwner {
        if (windows[p.windowId].exists) revert WindowExists(p.windowId);

        uint256 n = p.blockNumbers.length;
        if (n == 0) revert NoCandles();
        if (p.sqrtPrices.length != n) revert CandleCountMismatch(n, p.sqrtPrices.length);
        if (p.visibleCount == 0 || p.visibleCount > n) revert VisibleCountMismatch(n, p.visibleCount);

        uint256 expectedCells = uint256(p.timeSteps) * uint256(p.priceBands);
        if (p.multipliers.length != expectedCells) revert GridSizeMismatch(expectedCells, p.multipliers.length);

        // Provenance and commitment in one pass: reverts unless every candle came through
        // Attestcoin, and returns the root over exactly those candles.
        bytes32 root = _provenRoot(p.pool, p.blockNumbers, p.sqrtPrices);

        windows[p.windowId] = Window({
            exists: true,
            merkleRoot: root,
            // the grid is centred on the last visible candle, which is now a proven price
            anchorSqrtPriceX96: p.sqrtPrices[p.visibleCount - 1],
            bandHeight: p.bandHeight,
            totalCandles: uint16(n),
            visibleCount: p.visibleCount,
            timeSteps: p.timeSteps,
            priceBands: p.priceBands,
            invert: p.invert,
            eraLabel: p.eraLabel,
            riddleHash: p.riddleHash
        });
        gridMultipliers[p.windowId] = p.multipliers;
        _storeVisible(p.windowId, p.sqrtPrices, p.visibleCount);
        windowIds.push(p.windowId);

        emit WindowRegistered(p.windowId, p.eraLabel, root, uint16(n));
    }

    /**
     * @notice Checks every candle against ChartVerifier and returns the Merkle root over them.
     * @dev Sorted-pair hashing with the odd node PROMOTED rather than duplicated. This must match
     *      buildMerkle() in worker/src/lib/window.ts exactly — the off-chain builder generates the
     *      inclusion proofs that verifyCandle() later checks, so any divergence would make every
     *      hidden candle unrevealable.
     */
    function _provenRoot(address pool, uint64[] calldata blocks, uint160[] calldata prices)
        private
        view
        returns (bytes32)
    {
        uint256 n = blocks.length;
        bytes32[] memory layer = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            // The price is part of the check, not just the block: proving *a* swap in this block
            // must not license committing a different price for it.
            if (verifier.provenPrice(pool, blocks[i]) != prices[i]) revert CandleNotProven(i, blocks[i]);
            layer[i] = candleLeaf(i, blocks[i], prices[i]);
        }
        while (n > 1) {
            uint256 m = 0;
            for (uint256 i = 0; i < n; i += 2) {
                layer[m++] = i + 1 < n ? _hashPair(layer[i], layer[i + 1]) : layer[i];
            }
            n = m;
        }
        return layer[0];
    }

    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return a <= b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }

    /// @dev Extracted so registerWindow stays under the stack limit.
    function _storeVisible(bytes32 windowId, uint160[] calldata prices, uint16 count) private {
        uint160[] storage v = visibleSqrtPrices[windowId];
        for (uint256 i = 0; i < count; i++) {
            v.push(prices[i]);
        }
    }

    // --------------------------------------------------------------- views

    function windowCount() external view returns (uint256) {
        return windowIds.length;
    }

    /// @notice Grid dimensions only. Avoids destructuring the whole Window struct at call sites,
    ///         which pushes the stack too deep in consumers.
    function gridDims(bytes32 windowId) external view returns (uint8 timeSteps, uint8 priceBands) {
        Window storage w = windows[windowId];
        if (!w.exists) revert UnknownWindow(windowId);
        return (w.timeSteps, w.priceBands);
    }

    function exists(bytes32 windowId) external view returns (bool) {
        return windows[windowId].exists;
    }

    function getMultipliers(bytes32 windowId) external view returns (uint32[] memory) {
        return gridMultipliers[windowId];
    }

    function getVisible(bytes32 windowId) external view returns (uint160[] memory) {
        return visibleSqrtPrices[windowId];
    }

    function multiplierAt(bytes32 windowId, uint8 t, uint8 p) public view returns (uint32) {
        Window storage w = windows[windowId];
        if (!w.exists) revert UnknownWindow(windowId);
        return gridMultipliers[windowId][uint256(t) * uint256(w.priceBands) + uint256(p)];
    }

    // ------------------------------------------------------ candle reveal

    /** leaf = keccak256(abi.encode(index, blockNumber, sqrtPriceX96)) — matches worker/src/lib/window.ts */
    function candleLeaf(uint256 index, uint64 blockNumber, uint160 sqrtPriceX96) public pure returns (bytes32) {
        return keccak256(abi.encode(index, blockNumber, sqrtPriceX96));
    }

    /**
     * @notice Verify that a candle really belongs to a registered window.
     * @dev Sorted-pair Merkle verification, matching the worker's builder.
     */
    function verifyCandle(
        bytes32 windowId,
        uint256 index,
        uint64 blockNumber,
        uint160 sqrtPriceX96,
        bytes32[] calldata proof
    ) public view returns (bool) {
        Window storage w = windows[windowId];
        if (!w.exists) revert UnknownWindow(windowId);

        bytes32 computed = candleLeaf(index, blockNumber, sqrtPriceX96);
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 sibling = proof[i];
            computed = computed <= sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        return computed == w.merkleRoot;
    }

    // ------------------------------------------------------ band maths

    /**
     * @notice Which price band a candle falls into, or -1 when it lands outside the grid.
     *
     * Works in sqrtPriceX96 space to avoid ever materialising a price:
     *   sqrtRatio  = anchorSqrt * SCALE / candleSqrt
     *   priceRatio = sqrtRatio^2 / SCALE          == (price / anchorPrice) * SCALE   [invert]
     * and the reciprocal when !invert.
     */
    function bandOf(bytes32 windowId, uint160 candleSqrtPriceX96) public view returns (int256) {
        Window storage w = windows[windowId];
        if (!w.exists) revert UnknownWindow(windowId);
        if (candleSqrtPriceX96 == 0) return -1;

        uint256 priceRatio;
        if (w.invert) {
            uint256 sqrtRatio = (uint256(w.anchorSqrtPriceX96) * SCALE) / uint256(candleSqrtPriceX96);
            priceRatio = (sqrtRatio * sqrtRatio) / SCALE;
        } else {
            uint256 sqrtRatio = (uint256(candleSqrtPriceX96) * SCALE) / uint256(w.anchorSqrtPriceX96);
            priceRatio = (sqrtRatio * sqrtRatio) / SCALE;
        }

        // (price/anchor - 1) / bandHeight, scaled by SCALE.
        // bandHeight is itself SCALE-scaled, so the two SCALEs cancel to leave one.
        int256 delta = int256(priceRatio) - int256(SCALE);
        int256 offset = (delta * int256(SCALE)) / int256(w.bandHeight);

        // shift so band 0 sits at the bottom of the grid
        int256 shifted = offset + (int256(uint256(w.priceBands)) * int256(SCALE)) / 2;

        // Solidity truncates toward zero; the worker uses Math.floor (toward -inf). A negative
        // numerator would truncate to band 0 instead of falling outside the grid, so reject it
        // explicitly rather than relying on the division.
        if (shifted < 0) return -1;

        int256 band = shifted / int256(SCALE);
        if (band >= int256(uint256(w.priceBands))) return -1;
        return band;
    }
}
