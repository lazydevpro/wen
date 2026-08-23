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
- **Flare's FDC, the closest comparable attestation layer, caps the age of the underlying data.**
  Its docs put the maximum allowed data age at **14 days for most chain-data attestation types** —
  the class that `EVMTransaction`, and therefore a Uniswap swap from 2022, falls into. (A few
  non-chain-data types such as `AddressValidity` and `Web2Json` carry no practical limit, so the
  cap is per-type rather than global.) For this game's data the window excludes every era it deals.

Latency is also structurally free here: Attestcoin runs ~7.4 minutes behind Ethereum, which matters
for live data and not at all for transactions from 2022.

## Deployed contracts (CC3 Testnet)

| Contract | Address |
|---|---|
| `EvmV1Decoder` (library) | `0xcba2A0C9CBbbA5179fCCd2f5049Ea37D2BB939C7` |
| `ChartVerifier` | `0xE64f8b159FC22F9B0B1ca4980362eB5765cAb0f3` |
| `ChartRegistry` | `0xBCf9D65e6eb421B6dbf2CaEDbB21bCcBD0337dC5` |
| `GridGame` | `0x5D2b31f37342d6a842742628e49b70f0f3507b96` |

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
a time with inclusion proofs, so the operator cannot swap the series mid-round.

**6. Provenance enforced at registration — the one that was missing**
A Merkle proof answers *"is this candle in the set I committed"*, never *"did this happen on
Ethereum"*. For a while this document claimed guard 5 delivered both. It did not, and the gap was
total: `registerWindow` was `onlyOwner`, validated two array lengths, and stored whatever root it
was handed. A window of candles at block 99,000,000 — a height Ethereum will not reach for years —
registered and resolved cleanly. Attestcoin ran in a separate offline script whose output nothing
read, so the real trust root was the deployer's key.

`ChartRegistry` now holds an immutable `IChartVerifier` and refuses any candle whose
`(pool, block, price)` the verifier does not know:

```solidity
if (verifier.provenPrice(pool, blocks[i]) != prices[i]) revert CandleNotProven(i, blocks[i]);
```

The price is checked, not just the block — proving *a* swap in a block must not license committing
a different price for it. `merkleRoot`, `anchorSqrtPriceX96`, the visible series and `totalCandles`
are then **derived** from those verified candles instead of accepted as calldata: anything the
operator can state independently is something the operator can lie about.

Regression tests: `test_RejectsWindowWithUnprovenCandles`, `test_RejectsRestatedPriceAtProvenBlock`,
`test_DerivedRootMatchesOffchainBuilder`.

**What the gate caught on its first run.** 14 of 120 windows failed to register. The cause was real
and had been invisible: `foldBuckets` builds a candle from the *last* swap in its bucket and keeps
that swap's `txHash`, while `recordCandle` proves that transaction and takes the *first* swap
matching the pool. When the closing transaction touches the pool twice — split route, multi-hop,
arb — they are different swaps a few parts per million apart. About 0.5% of candles, which is ~12%
of 40-candle windows. Both prices are genuine; only one is attested, so `reconcile-proven.ts`
adopts the proven one and rebuilds everything derived from it. All 120 windows now register.

## A gap in `USCBase`, and how we worked around it

`USCBase.execute()` receives `blockHeight` but does **not** forward it to `_processAndEmitEvent`,
and it is not `virtual`, so it cannot be overridden. A candle needs its source block.

Rather than fork the vendored base contract, `ChartVerifier` adds its own entry point,
`recordCandle`, which reuses `USCBase`'s `_computeQueryId`, `_verifyProof` and `processedQueries`
unchanged, and disables `execute()` so it cannot silently record a candle with no block height.

## Measurements

Blocks, prices, ages, continuity-root counts and gas are **measured live** against CC3 Testnet.
The cost column is **modelled** — flagged as such below rather than presented as observed.

**Historical proving** — five eras, all verified:

| Era | Block | ETH | Age | Continuity roots | Cost (modelled) |
|---|---|---|---|---|---|
| Oct 2021 | 13,314,561 | $2,937 | 1,731 days | 440 | ~1.51e-4 CTC |
| May 2022 (Luna) | 14,770,000 | $2,076 | 1,528 days | 1 | ~2.33e-5 CTC |
| Sep 2022 (Merge) | 15,537,400 | $1,606 | 1,422 days | 601 | ~1.97e-4 CTC |
| Nov 2022 (FTX) | 15,950,000 | $1,270 | 1,365 days | 1 | ~2.33e-5 CTC |
| Mar 2024 | 19,400,000 | $3,907 | 885 days | 1 | ~2.33e-5 CTC |

Every price matches real history, and each row is a live `verifySingle` against the BlockProver
precompile — those parts are observed.

**The cost column is not.** Every figure in it comes from `cost = 2.3e-5 + 2.9e-7 × roots`
([`spike-historical.ts:94`](../worker/src/spike-historical.ts)), a linear model whose two constants
are hardcoded in three files and are not themselves validated anywhere in this repo. Read it as an
order-of-magnitude estimate, not a measurement.

**Batching** — 10 swaps share a single continuity proof and verify in one `verifyBatch` view call.
That sharing is real and is the substantive result. The "10× cheaper" headline is *not* a separate
finding: it is the same linear model divided by itself, so it collapses to the batch size by
construction ([`spike-batch.ts:85`](../worker/src/spike-batch.ts)). Ten swaps would report "10×"
whatever the constants were.

**Attestation lag** — 37 blocks (~7.4 min) on testnet, consistent with the `EvmSafe` maturity
strategy. Single observation, not a distribution.

**On-chain recording** — 8 Luna-era candles recorded, gas 462k–1.3M, scaling with continuity-root
count. `pnpm verify-onchain` reads them back and confirms all 8 match Ethereum mainnet.

## Practical findings

Against `@gluwa/usc-sdk@0.18.0`, the version pinned since this repo's first commit. An earlier
draft of this section listed six findings; three did not survive being checked against the SDK
source and have been withdrawn rather than quietly deleted — see *Withdrawn* below.

**1. `forge script` cannot deploy to Creditcoin.** The chain does not populate `prevrandao`, and
Foundry's script runner rejects the header before any deployment happens:

```
Error: Failed to deploy script:
EVM error; header validation error: `prevrandao` not set
```

Reproducible with no key, no funds and no broadcast via
[`script/tmp/PrevrandaoProbe.s.sol`](../contracts/script/tmp/PrevrandaoProbe.s.sol) on Foundry
1.5.1-stable. Root cause is visible straight off the RPC — CC3 block headers carry
`difficulty: 0x0` and no `mixHash` field at all. Workaround: `forge create` with an explicit
`--libraries` link for `EvmV1Decoder`.

**2. The SDK's shipped examples contradict its own deprecation notice.** `waitUntilHeightAttested`
has two implementations. The one on `PrecompileChainInfoProvider` is marked legacy in its own
docstring, which redirects you elsewhere (`chain-info/index.d.ts:212`):

> "This is a legacy implementation! ... use the implementation of `waitUntilHeightAttested` in
> src/proof-provider/service/index.ts"

Yet both shipped examples call precisely that legacy method — `examples/end-to-end.ts:19` and
`examples/supported-chains-attestation-information.ts:22`. A reader following the examples adopts
the deprecated path. (This repo does too, at `spike.ts:51`.)

**3. The default proof-builder timeout is 10 seconds**, which is too short for deep history —
`constructor(chainKey, builderUrl, timeout = 10000)` in `proof-provider/service/index.js:108`.
Proofs carrying several hundred continuity roots time out intermittently at that setting; we pass
`300_000` explicitly ([`prove-candles.ts:58`](../worker/src/prove-candles.ts)).

**4. Continuity-root count varies from 1 to 601 across our five sampled eras**, depending on
whether the block lands on a sparse checkpoint — measured, and independent of transaction age.
Under the cost model above that implies a large cost and gas spread for otherwise identical proofs,
so an indexer should prefer checkpoint-aligned blocks. The *root counts* are measured; the cost
consequence inherits the model's caveat, and "~8×" was an artifact of that model rather than an
observed billing difference.

**5. `verifySingle` / `verifyBatch` are view calls** — implemented as `staticCall`
(`block-prover/index.js:114,220`) and taking no `Signer`, unlike `verifyAndEmit*`. The whole proof
pipeline can therefore be developed and tested with a zero balance. Inferable from the type
signatures, so this is a documentation suggestion rather than a defect: it is worth stating
explicitly in the quickstart.

### Withdrawn

- ~~"`waitUntilHeightAttested` does not exist on `ProofBuilder`."~~ **False.** It exists at
  `proof-provider/service/index.d.ts:158`. Superseded by finding 2, which points the other way.
- ~~"`getBatchProof`'s nested `Map` return is undocumented."~~ **False.** The type is nested
  (`proof-provider/index.d.ts:62`), but `examples/batch-proof-validation.ts` demonstrates the exact
  flattening loop, with an explanatory comment.
- ~~"Continuity roots vary 1 to ~1000."~~ Overstated; the measured range across our sample is
  1 to 601. Folded into finding 4.

## Reproducing

```bash
pnpm --dir worker spike            # prove one historical swap (no CTC needed)
pnpm --dir worker spike:batch      # batch proof economics
pnpm --dir worker spike:hist       # prove five eras, 2021 -> 2024
pnpm --dir worker prove-candles luna-2022 8
pnpm --dir worker verify-onchain   # read candles back, compare to Ethereum
forge test --root contracts        # 44 tests
```
