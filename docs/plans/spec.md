# wen — Spec

*Working title. Alternatives: When, Rewind, Ghost Chart.*

**BUIDL CTC 2026 Fall · Gaming track · submission 2026-09-06 · CC3 Testnet**

---

## The game

You are shown a real slice of Ethereum's price history — but not told when it is.

1. **A chart loads.** Roughly 20% of a real historical window is drawn. Real candles, from real
   on-chain swaps, cryptographically proven.
2. **A riddle names the era.** *"Gas got so expensive people stopped using the chain."* *"A
   stablecoin wasn't stable."* Work out roughly when you are.
3. **You bet the grid.** A lattice of `(time × price)` cells sits over the chart's future. Each cell
   shows a multiplier — near the current price pays ~1.1×, far out pays 100×+. Place as many bets as
   you like.
4. **The chart plays forward.** Real history unspools. Cells the price path crosses pay out.

The skill is compound: read the chart, identify the era, remember what happened next, and price
the risk. That's chart-reading, crypto history, and bet sizing in one decision.

## Why it's fun (checked against the theory)

| Test | Result |
|---|---|
| Koster: does the verb face many situations? | ✅ Every window and era is different |
| Preparation layer | ✅ Riddle → era → thesis → cell selection → sizing |
| **Information accrual** | ✅ Each revealed candle narrows the era *and* the path |
| Legible odds | ✅ The multiplier is printed on every cell — you lose and understand why |
| Relatable | ✅ *"What happened next"* is a universal crypto fantasy |
| Juice | ✅ Live line, cells igniting, instant resolve |
| Reason to return | ✅ You get better at reading eras |

## Why Attestcoin is load-bearing

**In a history-guessing game, the data being genuinely historical is the entire premise.** Fabricate
the chart and *"when is this?"* has no answer — the riddle becomes meaningless and the game stops
working. Every candle must trace to a real, proven on-chain swap.

That is not a trust nicety bolted onto a price feed. It is what makes the question answerable.

Supporting facts:
- **Only Creditcoin can reach back this far.** Flare's FDC has a hard 14-day request window;
  historical attestation is architecturally excluded for them.
- **Cost is flat under 90 days and trivial beyond** (~2×10⁻⁴ CTC), with **no lookback limit**.
- **Latency is irrelevant** — we prove transactions from years ago, attested long since. wen is
  the rare design where Attestcoin's ~7-minute lag costs nothing.

## Data pipeline

**Source:** Uniswap `Swap` events on Ethereum mainnet (chainKey 3).

- **V3** (May 2021+) — `Swap(...uint160 sqrtPriceX96, int128 liquidity, int24 tick)`. `sqrtPriceX96`
  gives exact price directly. Preferred.
- **V2** (May 2020+) — `Swap(address,uint,uint,uint,uint,address)`. Price derived from the amount ratio.
- **V1** (Nov 2018+) — fallback for the earliest playable era.

⚠️ **Honest constraint:** on-chain ETH price data effectively begins ~2019 and only gets dense from
2020. "Unlimited lookback" is bounded in practice by when DEX liquidity existed. Playable eras:
DeFi summer 2020, the 2021 bull run, May 2021 crash, Luna/3AC 2022, the Merge, FTX, 2023–2026.
That's plenty of drama, but pre-2019 is not reachable via swaps.

**Candle construction:** bucket swaps by time, derive OHLC from `sqrtPriceX96`. Sample enough swaps
per bucket to be representative without proving thousands. Batch proofs: **10 per continuity proof,
within a 1000-block range** — pick windows so buckets cluster inside that range.

## Multiplier calibration — the important bit

Cell probabilities **must be computed from the visible 20% only**, never from the hidden future.
Deriving odds from the realised path would leak the answer through the multipliers.

Method: fit realised volatility from the visible candles → compute cell-crossing probabilities under
a random walk → set `multiplier = (1 / p) × (1 − houseEdge)`.

Target house edge ~3–5%. Cap the top multiplier — it dominates variance and therefore bankroll.

## Architecture

### Contracts (Creditcoin)

**`ChartVerifier.sol`** *(extends `USCBase`)* — the Attestcoin surface.
- Verifies batched proofs of Uniswap `Swap` events
- **`require(receiptStatus == 0x1)`** — the precompile does not check this
- **`require(log.address_ == knownPoolAddress)`** — else anyone emits fake swaps from their own contract
- Decodes via `EvmV1Decoder.decodeReceiptFields` + `getLogsByEventSignature`
- Extracts `sqrtPriceX96`, folds swaps into candles
- Commits a Merkle root of the full window

**`ChartRegistry.sol`** — verified windows: `windowId → { merkleRoot, chainKey, blockRange, eraTag, riddleHash }`.

**`GridGame.sol`** — bets, cell resolution, payouts, house bankroll, per-round exposure cap.

**Anti-lookahead:** the full candle series is committed as a Merkle root at round start; candles are
revealed progressively with inclusion proofs. The operator cannot forge (each candle is
Attestcoin-proven) and cannot swap the series mid-round (the root is fixed).

### Off-chain
- **Indexer** — scan Uniswap swaps across a target window
- **Prover worker** — batch proofs via `ProofBuilder`, submit to `ChartVerifier`
- **Window library** — pre-verified windows ready to serve instantly

### Frontend
- Chart on `<canvas>` — **rendered as pixels, no numeric series in the DOM**
- Grid overlay with per-cell multipliers
- Bet placement, riddle panel, reveal animation, leaderboard

## Riddles

Authored per window. Each names an era through what happened, not when:

> *"The chain worked fine. Everyone just stopped being able to afford it."*
> *"Something that promised to always be worth a dollar stopped being worth a dollar."*
> *"The way blocks got made changed forever, and the price did almost nothing."*

Riddles can double as **bot traps** — phrasing that a scraper or naive model answers confidently and
wrongly, while a human who was there gets it immediately.

## Out of scope (documented, not built)

**Bot protection.** Testnet, no real value at stake, so deferred. When it matters, the stack is:

1. **Behavioural detection** — bet placement involves aiming, hesitation and revision. Bots show
   bimodal displacement, narrow pause clustering, idle-to-burst speed. ~8.9% FAR / 7.2% FRR with
   engineered features. Games have an advantage here: long, rich input sequences, and detection can
   live inside gameplay rather than as a separate challenge.
2. **Attestcoin wallet-age gating** — *creating 99 addresses takes 30 seconds; making them look two
   years old takes two years.* Address age ranked among the most reliable Sybil indicators in the
   Binance Account Bound analysis, and is the "A" in Trusta's MEDIA score (used by LayerZero, Linea,
   Scroll). This is the one anti-bot layer where Attestcoin is genuinely load-bearing: the game is on
   Creditcoin, the history is on Ethereum, and only proof bridges them autonomously.
3. **World ID tier** — a verified-human division. Precedent: World × Mythical Games targets exactly
   "smurfing, botting and account sharing" for leaderboard integrity.
4. **Stake and slash** — the real deterrent. Sybil classification cancels claims outright, nullifying
   the gas, proxy and labour cost. Post-hoc detection with forfeiture beats prevention at the door.

**Also out:** writability (not live), any chain but Ethereum (nothing else registered), real-money
stakes (licensing).

## Acceptance criteria

1. A real Uniswap swap from a past era is proven on CC3 Testnet and becomes a candle in a verified window
2. A forged `Swap` from an attacker-deployed contract is **rejected** (`log.address_` check)
3. A failed source transaction (`receiptStatus == 0`) is **rejected**
4. The same proof cannot be replayed (`USCBase.processedQueries`)
5. Multipliers are computed from visible candles only — verified by inspection that no future data reaches the pricing function
6. Committed Merkle root matches the revealed series; a tampered candle fails its inclusion proof
7. Simulated house edge over ≥1M rounds matches the target within tolerance
8. A full round is playable end-to-end: load → riddle → bet → reveal → payout → leaderboard
9. Technical doc explains the Attestcoin integration — explicitly scored

## Risks

| Risk | Mitigation |
|---|---|
| **Discord-gated faucet** — human in the loop | Day one. Calendar-blocking regardless of build speed |
| Sparse swaps in early windows | Prefer high-liquidity pools; widen buckets for thin eras |
| Multiplier miscalibration | Simulate against the realised path *after* pricing is frozen |
| Pattern-matching the window | Accepted. Testnet, and era-identification is the intended mechanic |
| SDK static since 2026-06-22, ~10 testnet proofs/day | Prototype the proof path before building on it |
