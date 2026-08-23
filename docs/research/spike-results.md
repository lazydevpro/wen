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

Price series extracted from the proven batch — **this is a wen chart**:

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

## ✅ Spike 3 — HISTORICAL proof (the critical one)

`attestationGenesisHeight = 0` — the chain claims full history. Confirmed empirically across five
eras, **all verified**:

| era | block | ETH | age | continuity roots | cost | verified |
|---|---|---|---|---|---|---|
| Oct 2021 — pre-ATH run-up | 13,314,561 | $2,937 | **1,731 days** | 440 | 1.51e-4 CTC | ✅ |
| May 2022 — Luna collapse | 14,770,000 | $2,076 | 1,528 days | 1 | 2.33e-5 CTC | ✅ |
| Sep 2022 — the Merge | 15,537,400 | $1,606 | 1,422 days | 601 | 1.97e-4 CTC | ✅ |
| Nov 2022 — FTX collapse | 15,950,000 | $1,270 | 1,365 days | 1 | 2.33e-5 CTC | ✅ |
| Mar 2024 — ETF era | 19,400,000 | $3,907 | 885 days | 1 | 2.33e-5 CTC | ✅ |

**Every price is historically accurate.** ETH really was ~$2,937 in Oct 2021, ~$2,076 during Luna,
~$1,606 at the Merge, ~$1,270 during FTX, ~$3,907 in March 2024. The pipeline returns real history.

### Cost optimization discovered

**Continuity root count varies from 1 to 601 depending on the block**, because sparse checkpoints
sit at fixed intervals. A block that lands on a checkpoint needs 1 root; one that doesn't may need
hundreds. The root count itself is measured; the **~8× cost difference** that followed from it is
not — it is the linear cost model `2.3e-5 + 2.9e-7 × roots` evaluated at both ends, and those two
constants are hardcoded and unvalidated. Treat the spread as indicative, not billed.

→ The indexer should prefer checkpoint-aligned blocks when sampling candles. *(Conclusion stands —
it follows from the measured root counts regardless of what the proofs actually cost.)*

Even the worst case (601 roots) looks negligible against a 10,000 CTC grant — but the "**roughly 50
million** proofs" figure this section used to quote divides the grant by the same modelled cost, so
it inherits the model, not a measurement.

## What this validates

1. **The thesis holds.** A real Uniswap V3 swap from Ethereum mainnet can be proven inside
   Creditcoin and decoded into a verifiable price point.
2. **Batching lets one continuity proof serve ten candles**, verified in a single `verifyBatch`
   call. That sharing is the real result. The "clean 10× cost reduction" once claimed here is not a
   second finding — it is the cost model divided by itself, which yields the batch size by
   construction and would read "10×" for any constants.
3. **The precompile rejects tampered data**, so the security guard works.
4. **No CTC needed to develop.** The `view` verification path means the whole proof pipeline can be
   built and tested before the faucet ever arrives. Only state-changing
   `verifyAndEmit` calls need funds.

## Gotchas found (not in the docs)

> **Corrected after re-checking against `@gluwa/usc-sdk@0.18.0` source.** Three items below were
> written from the shape of the API as used, not from reading the SDK, and two of them were simply
> wrong. Kept with strikethrough because this file is a dated research log, not a spec. The
> surviving and revised findings live in
> [`docs/ATTESTCOIN_INTEGRATION.md`](../ATTESTCOIN_INTEGRATION.md).

- ~~**`waitUntilHeightAttested` is on `PrecompileChainInfoProvider`, not `ProofBuilder`** — the
  docs' example (`proofBuilder.waitUntilHeightAttested`) is wrong.~~ **False.** It exists on both.
  `ProofBuilder.waitUntilHeightAttested` is at `proof-provider/service/index.d.ts:158`. The real
  finding is the inverse: the `PrecompileChainInfoProvider` implementation is marked *legacy* in its
  own docstring (`chain-info/index.d.ts:212`), yet both shipped SDK examples call it anyway.
- ~~**`ProofBuilder` only exposes `getProof` and `getBatchProof`.**~~ **False**, same reason — it
  also exposes `waitUntilHeightAttested`. The constructor signature was right:
  `(chainKey, builderUrl, timeout?)`, and that `timeout` defaults to **10 000 ms**, which is too
  short for deep history.
- ~~**`getBatchProof`'s nested `Map<height, Map<txIndex, entry>>` must be flattened** — not in the
  docs.~~ The nesting is real (`proof-provider/index.d.ts:62`), but **it is documented**:
  `examples/batch-proof-validation.ts` shows the exact flattening loop with a comment.
- **Public Ethereum RPCs reject `getLogs` beyond ~128 blocks from head** as archive requests. Tested
  publicnode, drpc, 1rpc, merkle.io, payload.de — none allow it. **An archive provider
  (Alchemy/Infura free tier) is required** to reach historical eras. *(Still stands.)*

## Price math (verified)

For the Uniswap V3 USDC/WETH 0.05% pool `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640`
(token0 = USDC 6dp, token1 = WETH 18dp):

```
raw   = (sqrtPriceX96 / 2^96)^2      // wei per USDC-micro
ETH$  = 1e12 / raw
```

Cross-checked against the tick: `1.0001^200800 ≈ 5.25e8` → `1e18 / 5.25e8 / 1e6 ≈ $1905`. ✓
