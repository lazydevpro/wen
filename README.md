# wen

**Bet on what already happened.**

You ante up and are dealt a random slice of Ethereum's real price history — but not told when it
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

That makes Attestcoin load-bearing rather than decorative — and it needs **Creditcoin
specifically**, because wen's core axis is depth into the past:

- **No lookback limit.** The pool reaches back to May 2021, over five years, and proving a swap
  from then costs the same as proving one from last week.
- **Flare's FDC, the closest comparable attestation layer, has a hard 14-day request window.**
  This game cannot be built there.

## Deployed (CC3 Testnet, chainId 102031)

| Contract | Address |
|---|---|
| `ChartVerifier` | `0x6eeeA8340195B1eE41883AA2F489a9259ab238cF` |
| `ChartRegistry` | `0xA7d01c898b4Ea2143c4Af3Ec52Bd0C8DBCB1BE61` |
| `GridGame` | `0x0e60CdA4959849244095D1f0ED0F787e8Da39Ac3` |
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
connect wallet → deposit once → pick an ante → DEAL
   └─ startRound() lands on-chain, assigning a RANDOM window
      └─ only now is the chart drawn — 45s on the clock
         └─ place bets → settleRound() → resolveRound() → reveal
```

- You are **never shown the catalogue**. There is no index to download: the client fetches the
  single window it was dealt, keyed by a windowId that only exists once the ante is mined. It
  cannot enumerate the pool, or even learn how large it is.
- **Visible 20%** of a ~10-day window is drawn; the rest is hidden.
- **A grid of (time × price) cells** sits over the future, each printed with its multiplier.
- **Multipliers are computed from the visible candles only** — the odds cannot leak the hidden path.
- The chart plays forward; cells the real price path crosses pay out.

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

`DECISION_BLOCKS = 20` (~5 min at 15s blocks) enforces the countdown on-chain. That budget covers
the deal confirming, the 45s client clock, and the settle being mined — it is not just thinking
time. Earlier values of 4 and 8 both stranded real testers whose settle missed the window.

### One constraint worth knowing

The per-round exposure cap (bankroll ÷ 20) applies to the **worst case where every cell hits**.
A 250× cell can therefore only carry `cap / 250` CTC — which can be *less than the ante*, forcing
bets to be spread rather than concentrated. The UI surfaces this before you can hit the revert.

## House edge — calibrated twice, because once was not enough

Target RTP is 96.3% (3.7% edge). The arithmetic was exact from the start. It was wrong twice.

**First miss.** The grid was priced from a normal random walk fitted to the visible candles,
spanning ±3σ. Real price paths travel nowhere near that far, so the outer bands were unreachable
and players were buying cells that **could not win**. Realised edge: **56%**. Narrowing to 2.55σ
brought it to ~95% against the six windows that existed then.

**Second miss, found by building this pool.** 2.55σ was fitted to *six price paths*. Measured
against 120 windows and 960 real outcomes it returns **87%** — a 13% house edge, more than three
times the target. Six paths cannot pin a distribution. The first calibration corrected an obvious
56% error and stopped there, which felt like enough and was not.

| Grid width | RTP over 960 real outcomes |
|---|---|
| 2.55 σ | 86.9% (13.1% edge — gouging) |
| 3.0 σ | 88.6% |
| **3.4 σ** | **97.6%** ✅ |
| 3.7 σ | 98.2% |
| 4.5 σ | 106.9% (house loses) |

Now at a **2.41% realised edge**, with 117 of 960 columns being total losses for a uniform bettor
(the price left the grid entirely).

**The harness was lying too.** `simulate.ts` skipped columns where the price left the grid —
removing them from the denominator as well as the numerator, and so discarding precisely the
columns where the house wins every unit. It overstated RTP by about 20 points, and briefly had me
reporting that the house was losing money when it was in fact overcharging by 4×.

I had assumed the failure mode would be fat tails *underpricing* the tails. It was the exact
opposite, both times. Run it yourself: `pnpm --dir worker simulate`, and re-sweep with
`pnpm --dir worker sweep-span` whenever the pool changes.

## Repo

```
contracts/     Foundry — ChartVerifier, ChartRegistry, GridGame  (33 tests)
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

forge test --root contracts               # 33 tests against real proven mainnet data
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
