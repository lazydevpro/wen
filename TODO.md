# TODO — Hindsight

**Deadline 2026-09-06 23:59 ET** · Gaming track · CC3 Testnet
Spec: [docs/plans/spec.md](docs/plans/spec.md) · Research: [docs/research/](docs/research/)

Legend: `- [ ]` open · `- [~]` in progress · `- [x]` done

---

## Now — de-risk the two things that could invalidate the build

- [~] **Get CC3 Testnet CTC — BLOCKING for on-chain writes.** Faucet is Discord-only. Address: `0xdb79Bf82610f12E549d1320a6FdC0dc3Be2c3CcE` #blocker
- [x] **Spike: prove one real historical Uniswap V3 `Swap`** — ✅ PASSED. Verified on CC3 Testnet, tampering rejected #spike
- [x] **Spike: batch path** — ✅ PASSED. 10 proofs / 1 shared continuity proof, 10× cheaper #spike
- [ ] **Get an archive-capable Ethereum RPC** (Alchemy/Infura free tier). Public RPCs reject any `getLogs` >~128 blocks from head, so historical eras are unreachable without one #blocker
- [ ] Attend the AMA (2026-08-18, 8pm KST) — ask about attestor set size, readability audit status, additional source chains #research
- [x] Scaffold Foundry project + worker, install `@gluwa/usc-sdk` 0.18.0, pull `USCBase.sol` + `VerifierInterface.sol` #setup

## Data pipeline

- [ ] Indexer: scan Uniswap V3 `Swap` events for a target window (fall back to V2 for pre-2021) #data
- [ ] Price extraction from `sqrtPriceX96` → OHLC bucketing #data
- [ ] Window selection: pick eras with dense liquidity and dramatic price action #data
- [ ] Prover worker: batch proof generation, submission, retry with backoff, restart recovery #worker
- [ ] Build a library of 20+ pre-verified windows spanning distinct eras #data

## Contracts

- [ ] `ChartVerifier.sol` extending `USCBase` — with all guards: `receiptStatus == 0x1`, `log.address_ == knownPool`, replay protection #contracts
- [ ] `sqrtPriceX96` decode + candle folding on-chain #contracts
- [ ] `ChartRegistry.sol` — verified windows, Merkle roots, era tags, riddle hashes #contracts
- [ ] Progressive candle reveal with Merkle inclusion proofs (anti-lookahead) #contracts
- [ ] `GridGame.sol` — bets, cell resolution, payouts, bankroll, per-round exposure cap #contracts
- [ ] **Multiplier engine — visible candles only.** Realised vol → cell-crossing probability → `(1/p) × (1 − edge)`. No future data may reach this function #contracts

## Game

- [ ] Chart rendering on `<canvas>` — pixels only, **no numeric series in the DOM** #frontend
- [ ] Grid overlay with per-cell multipliers #frontend
- [ ] Bet placement UX (multi-cell, sizing) #frontend
- [ ] Riddle panel #frontend
- [ ] Reveal animation — the chart plays forward, cells ignite #frontend
- [ ] Leaderboard #frontend
- [ ] Write riddles for each window; include bot-trap phrasing #content

## Verification — must pass before submitting

- [ ] Real historical Uniswap swap → verified candle in a registered window, visible on explorer
- [ ] ❌ Forged `Swap` from attacker-deployed contract → rejected
- [ ] ❌ Failed source tx (`receiptStatus == 0`) → rejected
- [ ] ❌ Proof replay → rejected
- [ ] ❌ Tampered candle → fails Merkle inclusion
- [ ] Audit that no future data reaches the multiplier function
- [ ] Simulate ≥1M rounds; empirical house edge matches target
- [ ] Full round playable end to end: load → riddle → bet → reveal → payout → leaderboard
- [ ] Worker survives restart without double-submitting

## Submission

- [ ] Technical doc on the Attestcoin integration — **explicitly a scoring criterion** #docs
- [ ] README: setup, architecture, deployed addresses #docs
- [ ] Demo video — must show a **real historical mainnet swap** becoming a playable candle #pitch
- [ ] Deck / whitepaper PDF #pitch
- [ ] Submit on DoraHacks **with GitHub URL** (Spring's winner omitted this; don't copy that) #pitch

## Future scope — documented in spec, not built

- [ ] Behavioural bot detection from input streams
- [ ] Attestcoin wallet-age gating (the one anti-bot layer where Attestcoin is load-bearing)
- [ ] World ID verified-human division
- [ ] Stake-and-slash forfeiture

## Decided — do not revisit

- **No writability.** Not live, no runtime pallets, no committed date.
- **Ethereum only.** Nothing else registered on either network.
- **Not a credit/reputation product.** ~20 such entries lost in Spring; ~11 of 12 known Fall repos are repeating it.
- **Multipliers never see the future.** Non-negotiable — it leaks the answer.
- **Testnet, no real money.** Sidesteps licensing entirely.
- **Pattern-matching the window is accepted**, not defended against. Era identification is the intended mechanic.
