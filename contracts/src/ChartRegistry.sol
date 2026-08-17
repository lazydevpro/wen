// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title ChartRegistry
 * @notice Registry of playable Hindsight windows.
 *
 * A window is a slice of real Ethereum history. Its candles are committed as a Merkle root so
 * hidden candles can be revealed one at a time with inclusion proofs — the operator can neither
 * forge a candle (each is Attestcoin-proven upstream in ChartVerifier) nor swap the series
 * mid-round (the root is fixed at registration).
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

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    struct RegisterParams {
        bytes32 windowId;
        bytes32 merkleRoot;
        uint160 anchorSqrtPriceX96;
        uint256 bandHeight;
        uint16 totalCandles;
        uint16 visibleCount;
        uint8 timeSteps;
        uint8 priceBands;
        bool invert;
        string eraLabel;
        bytes32 riddleHash;
        uint32[] multipliers;
        uint160[] visible;
    }

    function registerWindow(RegisterParams calldata p) external onlyOwner {
        if (windows[p.windowId].exists) revert WindowExists(p.windowId);

        uint256 expectedCells = uint256(p.timeSteps) * uint256(p.priceBands);
        if (p.multipliers.length != expectedCells) revert GridSizeMismatch(expectedCells, p.multipliers.length);
        if (p.visible.length != p.visibleCount) revert VisibleCountMismatch(p.visibleCount, p.visible.length);

        windows[p.windowId] = Window({
            exists: true,
            merkleRoot: p.merkleRoot,
            anchorSqrtPriceX96: p.anchorSqrtPriceX96,
            bandHeight: p.bandHeight,
            totalCandles: p.totalCandles,
            visibleCount: p.visibleCount,
            timeSteps: p.timeSteps,
            priceBands: p.priceBands,
            invert: p.invert,
            eraLabel: p.eraLabel,
            riddleHash: p.riddleHash
        });
        gridMultipliers[p.windowId] = p.multipliers;
        visibleSqrtPrices[p.windowId] = p.visible;
        windowIds.push(p.windowId);

        emit WindowRegistered(p.windowId, p.eraLabel, p.merkleRoot, p.totalCandles);
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
