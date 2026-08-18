# Attestcoin Protocol Integration

**wen · BUIDL CTC 2026 Fall · Gaming track · CC3 Testnet (chainId 102031)**

---

## Why the protocol is load-bearing

wen shows you a slice of Ethereum's price history without telling you when it is, and asks
you to bet on what happened next.

**If the chart can be fabricated, the game has no answer.** "Which era is this?" is only a question
if the candles are genuinely from that era. So the integration is not a trust nicety layered onto a
price feed — it is the thing that makes the question answerable.

Remove Attestcoin and there are two options, both worse:

| Alternative | Why it fails |
|---|---|
| Operator-supplied chart data | The operator can invent any price series; the riddle becomes meaningless |
| Price oracle | Reintroduces a trusted reporter over data that decides payouts |

And critically, **Creditcoin cannot produce this fact itself.** The game runs on Creditcoin; the
history lives on Ethereum. Attestcoin is the only trustless bridge between them.

## Why this needs Creditcoin specifically

wen's core axis is **depth into the past**. That is precisely where Creditcoin's attestation
layer is unique:

- **No lookback limit.** `attestationGenesisHeight = 0`, and we verified it empirically by proving
  transactions from October 2021 — **1,731 days old** — all the way through March 2024.
- **Flat cost.** 2.3×10⁻⁵ to 2.0×10⁻⁴ CTC regardless of age.
- **Flare's FDC, the closest comparable attestation layer, has a hard 14-day request window.**
  Historical attestation is architecturally excluded there. This game cannot be built on it.

Latency is also structurally free here: Attestcoin runs ~7.4 minutes behind Ethereum, which matters
for live data and not at all for transactions from 2022.

## Deployed contracts (CC3 Testnet)

| Contract | Address |
|---|---|
| `EvmV1Decoder` (library) | `0xcba2A0C9CBbbA5179fCCd2f5049Ea37D2BB939C7` |
| `ChartVerifier` | `0x6eeeA8340195B1eE41883AA2F489a9259ab238cF` |
| `ChartRegistry` | `0xA7d01c898b4Ea2143c4Af3Ec52Bd0C8DBCB1BE61` |
| `GridGame` | `0x0e60CdA4959849244095D1f0ED0F787e8Da39Ac3` |

Precompiles used: BlockProver `0x…0FD2`, ChainInfo `0x…0FD3`. Source chain: Ethereum mainnet,
**chainKey 3**.

## Protocol surface exercised

| Component | Used for |
|---|---|
| `@gluwa/usc-sdk` `ProofBuilder` | Generating inclusion proofs for historical Uniswap swaps |
| `getProof` / `getBatchProof` | Single and batched proof generation |
| `PrecompileChainInfoProvider` | Attested height, attestation genesis, chain discovery |
| `PrecompileBlockProver.verifySingle` / `verifyBatch` | **View-path verification — no gas, no CTC** |
| `USCBase` | Inherited; reuses `_computeQueryId`, `_verifyProof`, `processedQueries` |
| `BlockProver.verifyAndEmit` | State-changing verification when recording a candle |
| `EvmV1Decoder.getTransactionType` / `isValidTransactionType` | Transaction-type guard |
| `EvmV1Decoder.decodeReceiptFields` | Receipt status and logs |
| `EvmV1Decoder.getLogsByEventSignature` | Extracting Uniswap V3 `Swap` events |

## The flow

```
Ethereum mainnet                    Attestcoin                     Creditcoin
─────────────────                   ──────────                     ──────────
Uniswap V3 Swap
  (e.g. block 14,770,009,           attestors reach
   May 2022)                        consensus on the
       │                            source block
       │                                  │
       └── indexer selects ───────────────┤
           a representative                │
           swap per candle          ProofBuilder builds
                                    merkle + continuity proof
                                            │
                                            └──► ChartVerifier.recordCandle()
                                                   ├ BlockProver.verifyAndEmit  ← precompile
                                                   ├ require receiptStatus == 1
                                                   ├ require log.address_ == allowlisted pool
                                                   ├ select the Swap from THAT pool
                                                   ├ decode sqrtPriceX96
                                                   └ store candle
                                                          │
                                              ChartRegistry commits merkle root
                                                          │
                                              GridGame resolves rounds against
                                              Merkle-proved hidden candles
```

## Security guards, and why each exists

`USCBase.execute()` proves inclusion. Everything after that is application-level validation, and
each guard closes a real hole:

**1. `receiptStatus == 0x1`**
The precompile explicitly does **not** check whether the source transaction succeeded — the docs
say so in bold. Without this, a reverted swap becomes a price candle.

**2. `log.address_` must be an allowlisted pool**
Anyone can deploy a contract that emits an identical `Swap` signature. This is the forgery guard;
without it the entire chart can be fabricated by a third party and proven "genuine".

**3. The caller must name the pool**
A transaction can contain **many** swaps across many pools. Our own fixture turned out to be an
aggregator split-route with two V3 swaps at different fee tiers (0.01% at logIndex 92, 0.05% at
logIndex 95). An earlier version took `swaps[0]` blindly and silently recorded a price from a pool
we never indexed. Regression test: `test_SelectsSwapFromRequestedPoolNotFirstInTx`.

**4. Replay protection**
Inherited from `USCBase.processedQueries`, keyed on `keccak(chainKey, blockHeight, txIndex)`.

**5. Merkle commitment for hidden candles**
The full candle series is committed as a root at registration; hidden candles are revealed one at
a time with inclusion proofs. The operator can neither forge a candle (each is Attestcoin-proven)
nor swap the series mid-round (the root is fixed).

## A gap in `USCBase`, and how we worked around it

`USCBase.execute()` receives `blockHeight` but does **not** forward it to `_processAndEmitEvent`,
and it is not `virtual`, so it cannot be overridden. A candle needs its source block.

Rather than fork the vendored base contract, `ChartVerifier` adds its own entry point,
`recordCandle`, which reuses `USCBase`'s `_computeQueryId`, `_verifyProof` and `processedQueries`
unchanged, and disables `execute()` so it cannot silently record a candle with no block height.

## Measurements

All figures measured live against CC3 Testnet, not taken from documentation.

**Historical proving** — five eras, all verified:

| Era | Block | ETH | Age | Continuity roots | Cost |
|---|---|---|---|---|---|
| Oct 2021 | 13,314,561 | $2,937 | 1,731 days | 440 | 1.51e-4 CTC |
| May 2022 (Luna) | 14,770,000 | $2,076 | 1,528 days | 1 | 2.33e-5 CTC |
| Sep 2022 (Merge) | 15,537,400 | $1,606 | 1,422 days | 601 | 1.97e-4 CTC |
| Nov 2022 (FTX) | 15,950,000 | $1,270 | 1,365 days | 1 | 2.33e-5 CTC |
| Mar 2024 | 19,400,000 | $3,907 | 885 days | 1 | 2.33e-5 CTC |

Every price matches real history.

**Batching** — 10 swaps sharing one continuity proof cost **10× less** than proving separately.

**Attestation lag** — 37 blocks (~7.4 min), matching the `EvmSafe` maturity strategy on testnet.

**On-chain recording** — 8 Luna-era candles recorded, gas 462k–1.3M, scaling with continuity-root
count. `pnpm verify-onchain` reads them back and confirms all 8 match Ethereum mainnet.

## Practical findings the docs get wrong or omit

1. **`waitUntilHeightAttested` lives on `PrecompileChainInfoProvider`, not `ProofBuilder`.** The
   documented example (`proofBuilder.waitUntilHeightAttested`) does not exist.
2. **`getBatchProof` returns a nested `Map<height, Map<txIndex, entry>>`** that must be flattened
   into parallel arrays for `verifyBatch`.
3. **`verifySingle` / `verifyBatch` are view calls.** The whole proof pipeline can be developed and
   tested with a zero balance — funds are only needed for `verifyAndEmit`.
4. **Continuity-root count varies from 1 to ~1000 for similar-age transactions**, depending on
   whether the block lands on a sparse checkpoint. That is an ~8× cost and gas difference for
   otherwise identical proofs; the indexer should prefer checkpoint-aligned blocks.
5. **The SDK's default 100s proof timeout is too short for deep history.** Proofs carrying ~1000
   continuity roots time out intermittently; we raise it to 300s.
6. **`forge script` cannot deploy to Creditcoin** — the chain does not set `prevrandao` and
   Foundry's script runner panics. Use `forge create` with an explicit `--libraries` link for
   `EvmV1Decoder`.

## Reproducing

```bash
pnpm --dir worker spike            # prove one historical swap (no CTC needed)
pnpm --dir worker spike:batch      # batch proof economics
pnpm --dir worker spike:hist       # prove five eras, 2021 -> 2024
pnpm --dir worker prove-candles luna-2022 8
pnpm --dir worker verify-onchain   # read candles back, compare to Ethereum
forge test --root contracts        # 33 tests
```
