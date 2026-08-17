# Spike Results — Attestcoin proof pipeline

Run 2026-08-17 against CC3 Testnet (chainId **102031**) and Ethereum mainnet (chainKey **3**).
Both spikes executed with **zero CTC** — `verifySingle` / `verifyBatch` are `view` calls.

## ✅ Spike 1 — single historical swap

```
ethereum head    : 25774647
attested height  : 25774610
lag              : 37 blocks (~7.4 min)     ← matches research (37.8 blocks / ~7.5 min)

chosen tx        : 0x0322f7b95143523704fe109807bf527a320016418375ea10974ae78f0becddb4
block            : 25774566
sqrtPriceX96     : 1815437222896110049797623354653282
tick             : 200800
ETH price        : $1904.57

proof generated  : 1741 ms (cached)
txBytes          : 10752 bytes            ← far under MAX_ENCODED_SIZE (449,280)
merkle siblings  : 9
continuity roots : 5
est. verify cost : 2.445e-5 CTC           ← matches the documented cost model

VERIFIED         : ✅ TRUE
tampered txBytes : ✅ REJECTED — "Merkle proof validation failed"
```

## ✅ Spike 2 — batch (candle economics)

```
scanned          : 50 blocks → 26 swap events
picked           : 10 swaps across distinct blocks (span 25774565..25774593)
proof generated  : 2035 ms (uncached)
SHARED continuity: 36 roots for all 10 txs

cost if separate : ~3.344e-4 CTC
cost as batch    : ~3.344e-5 CTC          ← 10.0× cheaper
BATCH VERIFIED   : ✅ TRUE
```

Price series extracted from the proven batch — **this is a Hindsight chart**:

| block | ETH |
|---|---|
| 25774565 | $1904.57 |
| 25774566 | $1904.57 |
| 25774568 | $1904.57 |
| 25774570 | $1904.00 |
| 25774576 | $1904.01 |
| 25774577 | $1904.14 |
| 25774579 | $1904.14 |
| 25774582 | $1904.14 |
| 25774588 | $1904.19 |
| 25774593 | $1904.69 |

## What this validates

1. **The thesis holds.** A real Uniswap V3 swap from Ethereum mainnet can be proven inside
   Creditcoin and decoded into a verifiable price point.
2. **Batching gives a clean 10× cost reduction** — one continuity proof serves ten candles. Chart
   construction is economically trivial.
3. **The precompile rejects tampered data**, so the security guard works.
4. **No CTC needed to develop.** The `view` verification path means the whole proof pipeline can be
   built and tested before the faucet ever arrives. Only state-changing
   `verifyAndEmit` calls need funds.

## Gotchas found (not in the docs)

- **`waitUntilHeightAttested` is on `PrecompileChainInfoProvider`, not `ProofBuilder`** — the docs'
  example (`proofBuilder.waitUntilHeightAttested`) is wrong. Attested height comes from
  `chainInfo.PrecompileChainInfoProvider(rpc).getLatestAttestedHeightAndHash(chainKey)`.
- **`ProofBuilder` only exposes `getProof` and `getBatchProof`.** Constructor is
  `(chainKey, builderUrl, timeout?)`.
- **`getBatchProof` returns a nested `Map<height, Map<txIndex, entry>>`** that must be flattened into
  parallel arrays for `verifyBatch`.
- **Public Ethereum RPCs reject `getLogs` beyond ~128 blocks from head** as archive requests. Tested
  publicnode, drpc, 1rpc, merkle.io, payload.de — none allow it. **An archive provider
  (Alchemy/Infura free tier) is required** to reach historical eras.

## Price math (verified)

For the Uniswap V3 USDC/WETH 0.05% pool `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640`
(token0 = USDC 6dp, token1 = WETH 18dp):

```
raw   = (sqrtPriceX96 / 2^96)^2      // wei per USDC-micro
ETH$  = 1e12 / raw
```

Cross-checked against the tick: `1.0001^200800 ≈ 5.25e8` → `1e18 / 5.25e8 / 1e6 ≈ $1905`. ✓
