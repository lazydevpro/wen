# TODO — Hindsight

**Deadline 2026-09-06 23:59 ET** · Gaming track · CC3 Testnet
Spec: [docs/plans/spec.md](docs/plans/spec.md) · Research: [docs/research/](docs/research/)

Legend: `- [ ]` open · `- [~]` in progress · `- [x]` done

---

## Done — thesis validated end to end

- [x] **CC3 Testnet CTC** — ✅ funded 10,000 CTC at `0xdb79Bf82610f12E549d1320a6FdC0dc3Be2c3CcE` (the "~50M proofs' worth" once noted here divides the grant by a modelled per-proof cost, not a measured one)
- [x] **Spike: prove HISTORY** — ✅ 5 eras from Oct 2021 → Mar 2024 all verified, prices historically accurate #spike
- [x] **Spike: prove one real historical Uniswap V3 `Swap`** — ✅ PASSED. Verified on CC3 Testnet, tampering rejected #spike
- [x] **Spike: batch path** — ✅ PASSED. 10 proofs verified against 1 shared continuity proof (the "10× cheaper" once noted here was model arithmetic, not a billing result) #spike
- [x] **Archive-capable Ethereum RPC** — ✅ configured. Free tier caps `getLogs` at a **10-block range**, so the indexer must chunk #blocker
- [ ] Attend the AMA (2026-08-18, 8pm KST) — ask about attestor set size, readability audit status, additional source chains #research
- [x] Scaffold Foundry project + worker, install `@gluwa/usc-sdk` 0.18.0, pull `USCBase.sol` + `VerifierInterface.sol` #setup

## Data pipeline

- [x] Indexer with 10-block chunking + stratified sampling across the era #data
- [x] Price extraction from `sqrtPriceX96` → OHLC bucketing #data
- [x] Six eras selected and built: Oct 2021, Luna, Merge, FTX, ETF, peak gas #data
- [x] Prover worker with journalling, retry, 300s timeout for deep-history proofs #worker
- [~] 6 windows built and registered on-chain; more is just repetition of the same path #data

## Contracts

- [x] `ChartVerifier.sol` extending `USCBase` — all guards in place, 12 tests green against real proven mainnet data #contracts
- [x] `sqrtPriceX96` decode on-chain — matches Ethereum ground truth exactly #contracts
- [x] `ChartRegistry.sol` — deployed, 6 windows registered #contracts
- [x] Progressive candle reveal with Merkle inclusion proofs #contracts
- [x] `GridGame.sol` — deployed, 4000 CTC bankroll, all risk controls tested #contracts
- [x] **Multiplier engine — visible candles only.** Calibrated to 2.55σ after finding a 56% realised edge #contracts

## Game

- [x] Chart rendering on `<canvas>` — pixels only, no numeric series in the DOM #frontend
- [x] Grid overlay with per-cell multipliers #frontend
- [x] Bet placement UX (multi-cell, sizing) #frontend
- [x] Riddle panel with era-guess bonus #frontend
- [x] Reveal animation — the chart plays forward, cells ignite #frontend
- [x] Leaderboard (localStorage, top 10) #frontend
- [x] Riddles written for all six eras #content

## Verification — must pass before submitting

- [x] Real historical Uniswap swap → verified candle — 8 Luna candles on-chain, all match Ethereum
- [x] ❌ Forged `Swap` from attacker-deployed contract → rejected
- [x] ❌ `receiptStatus` guard implemented + precompile-rejection tested
- [x] ❌ Proof replay → rejected
- [x] ❌ Tampered candle → fails Merkle inclusion
- [x] Audited — sigma and grid derive from visible candles only
- [x] Calibrated against REAL outcomes (better test than resampling the model): 95.3% RTP
- [x] Full round playable end to end
- [x] Worker journals progress; restart never double-submits

## Submission — needs you

- [x] [ATTESTCOIN_INTEGRATION.md](docs/ATTESTCOIN_INTEGRATION.md) — explicitly a scoring criterion #docs
- [x] README with setup, architecture, deployed addresses #docs
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
