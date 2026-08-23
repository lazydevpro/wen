# wen

**Bet on what already happened.**

You put up a stake and get a random slice of Ethereum's real price history — but not told when it
is. A riddle is your only clue. Work out where you are, then bet on where the chart goes next.
You get 45 seconds.

Every candle is a real Uniswap V3 swap, cryptographically proven onto Creditcoin through the
Attestcoin Protocol. Nothing is simulated.

> *"Something that promised to always be worth a dollar stopped being worth a dollar."*
> — one of 120 windows

**BUIDL CTC 2026 Fall · Gaming track · CC3 Testnet**

---

## Why the proof matters

If the chart could be fabricated, *"which era is this?"* would have no answer. The riddle only
means something because the candles genuinely came from that moment in Ethereum's history.

**That is enforced, not asserted.** `ChartRegistry.registerWindow` rejects any candle whose
`(pool, block, price)` was not proven through Attestcoin, and derives the Merkle root, the anchor
and the visible series from those proven candles rather than accepting them as calldata. A window
of invented history does not register — `CandleNotProven`. All **4,706 candles** across all 120
windows are on-chain in `ChartVerifier`; check any of them yourself:

```bash
cast call 0xE64f8b159FC22F9B0B1ca4980362eB5765cAb0f3 "candleCount(address)(uint256)" 0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640 --rpc-url https://rpc.cc3-testnet.creditcoin.network
```

An earlier version of this README made the same claim while nothing checked it: the proving script
wrote to a journal no other code read, and the game trusted a root the operator typed in. The
sentence was true of the data and false of the system. It is now true of both.

That makes Attestcoin load-bearing rather than decorative — and it needs **Creditcoin
specifically**, because wen's core axis is depth into the past:

- **No lookback limit.** The pool reaches back to May 2021, over five years, and proving a swap
  from then costs the same as proving one from last week.
- **Flare's FDC, the closest comparable attestation layer, caps how old the underlying data may
  be** — 14 days for most chain-data attestation types, the class an Ethereum transaction falls
  into. Every era this game deals sits outside that window.

## Deployed (CC3 Testnet, chainId 102031)

| Contract | Address |
|---|---|
| `ChartVerifier` | `0xE64f8b159FC22F9B0B1ca4980362eB5765cAb0f3` |
| `ChartRegistry` | `0xBCf9D65e6eb421B6dbf2CaEDbB21bCcBD0337dC5` |
| `GridGame` | `0x5D2b31f37342d6a842742628e49b70f0f3507b96` |
| `EvmV1Decoder` (lib) | `0xcba2A0C9CBbbA5179fCCd2f5049Ea37D2BB939C7` |

**120 windows registered**, sliced from 21 hand-written eras spanning May 2021 to November 2024 —
peak gas, the London fork, the run to the ATH and the top, Luna, the lender freezes, the Merge,
FTX, capitulation, the USDC depeg, Shapella, the SEC suits, the 2023 quiet, both ETF approvals,
the carry unwind and the election.

The 114 generated slices are strictly non-overlapping — no two share a candle. Six earlier
windows predate the pool, were built from hand-picked start blocks, and overlap the slices of
their own era; they stay because they are already registered and `ChartRegistry` has no removal
path. So 12 of 7,140 window pairs share some candles. Worth knowing rather than claiming
otherwise, and it would be cleaned up by the next registry deployment.

## How it works

```
Uniswap V3 swaps          →  Attestcoin proof  →  ChartVerifier  →  verified candle
(Ethereum mainnet, 2021+)    (BlockProver          (guards +          (on Creditcoin)
                              precompile)           sqrtPriceX96)
                                                          ↓
                                              ChartRegistry commits a Merkle root
                                                          ↓
                                        GridGame resolves bets against hidden candles
                                        revealed with inclusion proofs
```

Full detail: **[docs/ATTESTCOIN_INTEGRATION.md](docs/ATTESTCOIN_INTEGRATION.md)**

## The game

```
connect wallet → pick a stake → PLAY          (no deposit step — see below)
   └─ startRound() commits the stake — the chart is NOT chosen yet
      └─ the hash of THAT block picks it. Unknowable while startRound runs, but sitting in the
         receipt the moment it confirms, so the client derives it with no extra wait — one block,
         ~7.5s, and the chart is up with 45s on the clock
         └─ place bets → settleRound() → (next block) → resolveRound() → reveal
```

- **Every riddle opens with the brand's own question** — *"wen something that promised to always
  be worth a dollar stopped being worth a dollar?"* One honest caveat: the on-chain `riddleHash`
  still pins the previous phrasing of each riddle; it re-pins automatically at the next registry
  deployment, since registration hashes whatever the riddle says then.
- You are **never shown the catalogue**. There is no index to download: the client fetches the
  single window it was dealt, keyed by a windowId that only exists once the ante is mined. It
  cannot enumerate the pool, or even learn how large it is.
- **Visible 20%** of a ~10-day window is drawn; the rest is hidden.
- **The chart travels two steps before the grid begins.** Those candles happen and are drawn —
  they simply aren't bettable. Starting the grid pinned to the anchor made the first column so
  concentrated that a couple of cells carried nearly all the probability.
- **A grid of 8 × 12 (time × price) cells** sits over the future, each printed with its multiplier.
- **Multipliers are priced from measured history** — see below. They depend only on a cell's position, never on the hidden path.
- The chart plays forward; cells the real price path crosses pay out.

**Or play it simple.** After the deal you can switch to a two-button game: does the chart end
higher or lower than the last known price? Less to think about, less to win. The two sides are
priced differently — **up 1.70×, down 1.90×** — because the pool is not a fair coin: measured over
all 120 windows, with the two-step runway in place, the final candle closes up **53.3%** of the
time. Paying both sides alike would let an "always up" bot ride that skew, so the likelier side
pays less:

| strategy | win rate | EV per 1 CTC |
|---|---|---|
| always up | 53.3% | 0.907 |
| always down | 46.7% | 0.887 |
| coin flip | 50% | 0.897 |

Neither side is positive EV, which is the property that matters. They are not *equal* either —
betting up is worth about two points more than betting down — and simple mode as a whole returns
more than the grid's 82%. That is deliberate: it is the lower-variance, lower-ceiling game.

The runway matters to this number and is easy to forget: the same measurement without it reads
54.2%, which is what an earlier draft of this table quoted after `GRID_LEAD_STEPS` went 0 → 2.

A player who actually recognises the era can push toward break-even, which is the point — knowing
the history is meant to be worth something. Both modes share the same deal, clock and forfeit; only
the shape of the bet differs.

### Wallet setup is automatic

Connecting adds Creditcoin CC3 Testnet to the wallet if it isn't there, then switches to it.
Three details that bite in practice and are handled:

- `wallet_addEthereumChain` needs the key `chainId`, not a custom one — a mismatch fails silently.
- Wallets report "I don't know that chain" inconsistently: `4902`, a nested `4902` under
  `data.originalError`, `-32603`, or just a message. All are matched.
- **Adding is not switching.** Some wallets add the network and stay where they are, so the
  result is verified and retried rather than assumed.

Rejections surface as a plain message instead of a dead button.

### Why two transactions

The ante has to confirm **before** the chart appears. Otherwise a player deals, reverse-searches
the candle series against public price history, and walks away for free — the exact attack this
design exists to price. The ante is not a fee: it counts toward your stake, so an honest player
pays nothing extra. Deal and walk away and it is forfeit.

**Confirming was not enough on its own.** `startRound` used to pick the window immediately and
return it, so a *contract* could deal, read what it drew, and revert the whole transaction if it
did not like it — reverse-searching an unlimited number of windows for nothing, because a revert
unwinds the ante too. The window is now drawn from the hash of the block *after* the deal, which
does not exist while `startRound` is executing. There is nothing to read and nothing to revert
away from. Costs one extra block (~15s) before the chart appears.

Two more guards came from the same audit:

- **Resolution must land in a later block than the bets.** Otherwise one transaction could deal,
  bet and collect — worth 4.62 CTC on a 1 CTC bet when it was possible.
- **Open rounds are capped in aggregate,** not just individually. `EXPOSURE_DIVISOR` bounds a
  single round; it says nothing about eighty at once. Opening 80 and only then resolving them
  drained 93.7% of the bankroll through a breaker set at 30%, because the breaker only gated
  `startRound`. `outstandingExposure` now sums every settled-but-unresolved round against
  `bankroll / 4`.

Regression tests: `test_ContractCannotPeekAtWindowInDealTransaction`,
`test_CannotResolveInTheSettlingBlock`, `test_TotalExposureIsBoundedAcrossOpenRounds`.

What is **not** required is a deposit. `startRound` and `settleRound` are payable: whatever the
table credit doesn't cover rides along as `msg.value` on a transaction the player signs anyway,
so a fresh faucet wallet plays in one popup. Excess value stays as withdrawable credit, winnings
accumulate there, and `deposit()` remains only as an optional top-up. A mandatory deposit-first
step would be pure friction — the signature is the cost, not the transfer.

`DECISION_BLOCKS = 20` (~5 min at 15s blocks) enforces the countdown on-chain. That budget covers
the deal confirming, the 45s client clock, and the settle being mined — it is not just thinking
time. Earlier values of 4 and 8 both stranded real testers whose settle missed the window.

### One constraint worth knowing

The per-round exposure cap (bankroll ÷ 20) applies to the **worst case where every cell hits**.
A 250× cell can therefore only carry `cap / 250` CTC — which can be *less than the ante*, forcing
bets to be spread rather than concentrated. The UI surfaces this before you can hit the revert.

## Multipliers are priced from measured history

Each cell pays `0.86 / (its measured hit rate)`. That makes **86% the ceiling for every cell by
construction** — no cell, no distance from the anchor, and no column can be positive-EV, because
none of them is priced above fair. Overall return lands at **82%**, an 18% house edge.

| distance from anchor | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| hit rate | 21% | 10.2% | 5.3% | 4.8% | 1.9% | 1.1% |
| pays (column 0) | 3× | 7.1× | 25.5× | 50.3× | 66.6× | 98.3× |

Rates come from replaying all 120 windows. Thin cells — d4 and d5 carry under 7% of outcomes
between them — get a small add-0.1 prior, so a cell with two observed hits is priced *down* rather
than exploding to a four-figure multiplier off a sample that cannot support one.

**The previous ladder was exploitable, and the way I missed it is the useful part.** Prices were
authored — round numbers by distance, `1× 4× 10× 25× 60× 150×`, with a scale solved per column so
that every column returned exactly 86.0%. That check passed, and I reported the grid as flat on
the strength of it. But a column is not the only axis. Measured per *distance* instead:

| distance | 0 | 1 | 2 | 3 | 4 | 5 |
|---|---|---|---|---|---|---|
| RTP | 21% | 46% | 55% | **128%** | **117%** | **149%** |

A player betting only the outer bands returned ~131%. The 86% figure was a true average
concealing the axis that mattered — the same error as quoting a cost model as a measurement.

The root cause is that real price paths trend, so distance-3 is nearly as likely as distance-2
(4.8% vs 5.3%) while the authored ladder paid 2.5× more for it. Authoring the numbers meant
guessing a fall-off that reality does not have.

**Cost of the fix:** the anchor rows now pay 3–5.3× rather than 1×. A 1× cell is ~21% RTP, and
recovering that lost return anywhere else is exactly what pushed the outer cells past fair. You
can have a 1× cell or an 86% ceiling, not both.

Regenerate with `pnpm --dir worker calibrate-ladder` whenever the pool changes.

### The calibrations before this

Each was measured against real outcomes, and each was wrong in a way the previous could not have
predicted. **±3σ** left the outer bands unreachable — players bought cells that could not win, at
a **56%** realised edge. **2.55σ**, fitted to the six windows that then existed, never generalised:
87% RTP against 120 windows. **3.4σ at an 11% design edge** landed 90.3% realised, but the
likeliest cell paid 3–4×, so one lucky cell covered four wrong ones. The **authored ladder** fixed
that and introduced the positive-EV outer bands described above.

## Repo

```
contracts/     Foundry — ChartVerifier, ChartRegistry, GridGame  (44 tests)
worker/        TypeScript — indexer, prover, window builder, calibration harness
web/           Client — canvas chart, multiplier grid, reveal
faucet-worker/ Cloudflare Worker — hosts the client, the faucet, and gated reveals
docs/          Spec, Attestcoin integration, research
```

## Running it

```bash
cp .env.example .env       # add DEPLOYER_PRIVATE_KEY + an archive-capable ETH_MAINNET_RPC_URL
pnpm --dir worker install
pnpm --dir contracts install && forge build --root contracts

forge test --root contracts               # 44 tests against real proven mainnet data
pnpm --dir worker spike                   # prove a real swap (needs no CTC — view call)
pnpm --dir worker bulk-windows            # rebuild the 120-window pool (~15 min of RPC)
pnpm --dir worker relabel-windows         # honest labels/riddles per slice
pnpm --dir worker export-public           # split public window data from reveals
pnpm --dir worker gen-reveal-index        # bundle reveals for the Worker
pnpm --dir worker simulate                # house-edge calibration
pnpm --dir worker verify-onchain          # read candles back, compare to Ethereum

pnpm --dir worker serve                   # play it — http://localhost:5173
```

An **archive-capable** Ethereum RPC is required — historical eras are unreachable otherwise. Free
tiers work but cap `eth_getLogs` at a 10-block range, which the indexer chunks around.

## Hosting

Deployed as a single Cloudflare Worker: **https://wen.lazydevpro.workers.dev**

```bash
cd faucet-worker && npm install
npx wrangler secret put FAUCET_PRIVATE_KEY   # dedicated key, never the deployer's
npx wrangler deploy
```

The client is static, so `run_worker_first: ["/api/*"]` keeps the Worker out of the path for
everything except the API — the chart and window data come off the edge and spend no Worker CPU.
`npm run dev` runs the whole thing locally against real CC3.

## The faucet

A new player needs nothing at all: **20 CTC per address per 24h**, and the server pays the gas.

That last part is why this is a server and not a `Faucet.sol`. A brand-new wallet holds zero CTC,
so it cannot pay gas to call a faucet contract — an on-chain faucet can only ever top up someone
who is already funded. Moving it off-chain removes the bootstrap problem entirely.

The faucet is open — no invite code, nothing to paste. Just share the link:

```
https://wen.lazydevpro.workers.dev
```

Guards, in the order that they actually matter:

| Guard | Default | Stops |
| --- | --- | --- |
| `FAUCET_DAILY_CAP` | 2000 CTC | a bug or a spray emptying the wallet |
| `FAUCET_IP_HOURLY` | 10 | farming from one machine |
| per-address cooldown | 24h | an honest player taking more than their share |
| `FAUCET_CODE` | unset | if set, gates the faucet behind `?code=` |

That ordering is deliberate and worth reading. **The 24h cooldown protects nothing against a
determined actor** — it is keyed on address, and generating a thousand fresh addresses takes about
a second. It constrains honest players and no one else. The daily cap is the only real ceiling on
what a bad day can cost, and the per-IP limit is what makes farming tedious enough not to bother.
Set `FAUCET_CODE` again if the faucet ever needs to be friends-only.

State lives in a **Durable Object**, not KV. The job is "has this address already been paid?", and
KV is eventually consistent — two requests landing in different colos can both read "no claim yet"
and both pay out. A Durable Object routes every claim to one instance. Being single-threaded is
still not enough on its own, because every `await` is a yield point, so the whole check-then-pay
sequence runs inside `blockConcurrencyWhile`. That also serialises the nonce, which ethers derives
from `eth_getTransactionCount` — two concurrent sends would otherwise reuse one and lose a
transaction. Verified: eight simultaneous claims for one address pay out exactly once.

The lock is held across the broadcast but not across confirmation, so claims don't queue a block
deep behind each other. A claim reserves its slot *before* broadcasting and hands it back if the
send fails.

Use a **dedicated** `FAUCET_PRIVATE_KEY`, never the deployer's — it is a hot key in a web process
and should not be able to touch the game bankroll if it leaks.

## Why the answers aren't static files

Each `web/data/*.reveal.json` holds `eraLabel`, the accepted `answers`, and `hidden` — the future
price path, which is to say the winning band. Served as static assets they were one fetch away:
`windows.json` lists every window id, so `data/<id>.reveal.json` handed over the answer before a
single bet was placed. That is strictly worse than the reverse-image-search the decision timer
exists to prevent, and it only became exploitable once there was a public URL.

So they are excluded from upload (`web/.assetsignore`), bundled into the Worker, and released
through `/api/reveal/:id?roundId=N` only once that round is `Settled` on-chain — meaning the bets
are committed and can no longer change.

**Known residual:** there are only six windows. Settling six minimum rounds harvests the whole
catalogue, after which every hand is known. The gate raises the cost from "free and instant" to
"six antes", but the real fix is many more windows, not a cleverer gate.

## Scope and honesty

- **Testnet only.** CTC here has no value, so this is game mechanics, not a gambling operation.
  Bankroll controls (dynamic bet limit, per-round exposure cap, drawdown breaker) are implemented
  because getting them right is the interesting engineering.
- **Bot resistance is future scope**, documented in the spec. The strongest available layer is
  Attestcoin wallet-age gating: creating 99 addresses takes 30 seconds, making them look two years
  old takes two years.
- **On-chain price data starts ~2021** (Uniswap V3 launched May 2021), so pre-2021 eras are not
  reachable via swaps.
- **Reverse-searching the chart is priced, not prevented.** A prepared attacker can screenshot the
  canvas and cross-correlate it against public price history in seconds. What the design does is
  make that cost something: the ante is already committed before the chart appears, the catalogue
  is never shown, and the on-chain decision window is ~2 minutes. Against a determined bot this is
  a tax rather than a wall — the actual answer is the wallet-age and behavioural layers in the spec.
