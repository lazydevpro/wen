# Hindsight

**Bet on what already happened.**

You ante up and are dealt a random slice of Ethereum's real price history — but not told when it
is. A riddle is your only clue. Work out where you are, then bet on where the chart goes next.
You get 45 seconds.

Every candle is a real Uniswap V3 swap, cryptographically proven onto Creditcoin through the
Attestcoin Protocol. Nothing is simulated.

> *"Something that promised to always be worth a dollar stopped being worth a dollar."*
> — one of six eras

**BUIDL CTC 2026 Fall · Gaming track · CC3 Testnet**

---

## Why the proof matters

If the chart could be fabricated, *"which era is this?"* would have no answer. The riddle only
means something because the candles genuinely came from that moment in Ethereum's history.

That makes Attestcoin load-bearing rather than decorative — and it needs **Creditcoin
specifically**, because Hindsight's core axis is depth into the past:

- **No lookback limit.** We prove transactions from October 2021 — 1,731 days old — at the same
  cost as recent ones.
- **Flare's FDC, the closest comparable attestation layer, has a hard 14-day request window.**
  This game cannot be built there.

## Deployed (CC3 Testnet, chainId 102031)

| Contract | Address |
|---|---|
| `ChartVerifier` | `0x6eeeA8340195B1eE41883AA2F489a9259ab238cF` |
| `ChartRegistry` | `0x5263dd64098e545235e9184A31aF6aDb4d3AB119` |
| `GridGame` | `0x5659942E63a62017c11E8668abbD8FbfEb335939` |
| `EvmV1Decoder` (lib) | `0xcba2A0C9CBbbA5179fCCd2f5049Ea37D2BB939C7` |

Six eras registered: Oct 2021 (the run to the ATH), Luna, the Merge, FTX, the ETF era, peak gas.

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

- You are **never shown the catalogue**. A window is picked on-chain and you cannot know which
  until the ante transaction lands.
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

`DECISION_BLOCKS = 8` (~2 min) enforces the countdown on-chain. That budget covers the deal
confirming, the 45s client clock, and the settle being mined — it is not just thinking time.

### One constraint worth knowing

The per-round exposure cap (bankroll ÷ 50) applies to the **worst case where every cell hits**.
A 250× cell can therefore only carry `cap / 250` CTC — which can be *less than the ante*, forcing
bets to be spread rather than concentrated. The UI surfaces this before you can hit the revert.

## House edge — and the bug worth reading about

Target RTP is 96.3% (3.7% edge). The arithmetic was exact from the start. It was still wrong.

The grid was priced from a normal random walk fitted to the visible candles, spanning ±3σ. Real
price paths travel nowhere near that far, so the outer bands were unreachable — players were buying
cells that **could not win**. Realised house edge: **56%**.

Testing against real historical outcomes (rather than resampling the model that set the odds)
caught it. Sweeping the grid width gave a clean curve:

| Grid width | Realised RTP |
|---|---|
| 6.0 σ | 44.3% |
| 3.0 σ | 78.6% |
| **2.55 σ** | **95.3%** ✅ |
| 2.0 σ | 111.4% (house loses) |

Now at a **4.66% realised edge** with outcomes spread across all twelve bands.

I had assumed the failure mode would be fat tails *underpricing* the tails. It was the exact
opposite. Run it yourself: `pnpm --dir worker simulate`.

## Repo

```
contracts/   Foundry — ChartVerifier, ChartRegistry, GridGame  (33 tests)
worker/      TypeScript — indexer, prover, window builder, calibration harness
web/         Client — canvas chart, multiplier grid, reveal
docs/        Spec, Attestcoin integration, research
```

## Running it

```bash
cp .env.example .env       # add DEPLOYER_PRIVATE_KEY + an archive-capable ETH_MAINNET_RPC_URL
pnpm --dir worker install
pnpm --dir contracts install && forge build --root contracts

forge test --root contracts               # 33 tests against real proven mainnet data
pnpm --dir worker spike                   # prove a real swap (needs no CTC — view call)
pnpm --dir worker build-window all        # rebuild all six eras from Ethereum
pnpm --dir worker simulate                # house-edge calibration
pnpm --dir worker verify-onchain          # read candles back, compare to Ethereum

cd web && python3 -m http.server 5173     # play it
```

An **archive-capable** Ethereum RPC is required — historical eras are unreachable otherwise. Free
tiers work but cap `eth_getLogs` at a 10-block range, which the indexer chunks around.

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
