# BUIDL CTC — Hackathon Intel

Researched 2026-08-16. Sources: DoraHacks, Blockscout, GitHub API, npm registry API, DefiLlama API,
CoinGecko, penguinbase.com.

---

## Past winners — BUIDL CTC Spring 2026

Only **two** editions have ever run; Spring 2026 was the inaugural one. Winners are published
**only** on [DoraHacks](https://dorahacks.io/hackathon/buidl-ctc/winner) — no blog post, no press,
no X announcement.

**Spring 2026:** Feb 1 – Mar 7, winners announced Mar 21. **189 registered devs · 76 approved
projects · $15,000 pool.** Track split: **DeFi 33 · RWA 30 · Gaming 10 · DePIN 3**.

| Place | Project | Track | Team |
|---|---|---|---|
| **Grand $10k** | [CrediKye](https://dorahacks.io/buidl/40170) — on-chain ROSCA savings circles | **Gaming** | Choguun + Sarah |
| 2nd $3k | [HashCredit](https://dorahacks.io/buidl/40363) — BTC miner revenue financing | DeFi | StudioLIQ |
| 3rd $2k | [SnowBall](https://dorahacks.io/buidl/39899) — CDP + vaults + AMM | DeFi | HypurrQuant (KR) |

**CrediKye** — Telegram Mini App digitising ROSCA/chit-fund savings circles. 3–10 members,
smart-contract payout rotation, reputation points, trust ranks (Bronze→Diamond), soulbound
achievement NFTs, XP/daily quests/streaks, referrals. Next.js 14 + wagmi v2 + viem + Tailwind +
Framer Motion; Solidity/Foundry with EIP-1167 clones; Grammy bot. Received **2 upvotes**.
Demo still live at [credi-kye-web.vercel.app](https://credi-kye-web.vercel.app).

**HashCredit** — Revenue-based financing for Bitcoin miners. BTC SPV proofs (checkpointed headers +
Merkle inclusion + ≥6 confs) → USDT credit lines on Creditcoin. BIP-137 sig → `ecrecover` for
address ownership. Notably: *"USC was not live during development, so we implemented the same
pattern ourselves"* — and hid verification behind an `IVerifierAdapter` so USC would be "a wiring
task, not a rewrite."

**SnowBall** — sbUSD CDP against wCTC/lstCTC (110–120% CR), stability pools, 6 auto-compounding
vaults, isolated lending, concentrated-liquidity AMM, AI rebalancing agent via Privy.

### What this teaches

- **The grand prize went to the least technically deep project.** A Telegram Mini App beat a Bitcoin
  SPV verification protocol and a full DeFi stack. It won on consumer UX, gamification,
  distribution, and a legible real-world story.
- **It won in the emptiest track.** Gaming: 10 entries. DeFi: 33. Track choice was worth more than code.
- **It didn't meet the stated requirements.** Rules mandate a GitHub URL with README; CrediKye's
  `githubUrl` is `null`. Not enforced.
- **☠️ The "on-chain credit score" field is a graveyard.** 20+ near-identical entries — CredLink,
  CreditLens, CredGate, CreditX, CrediFi, CreditVault, ProofOfCredit, BorrowIQ, TrustCredit AI,
  CrediX, CreditFlow, RealCredit, Wikshi… **every single one lost.** The obvious "it's Creditcoin,
  so credit scoring" instinct is the most crowded and least successful play available.
- ROSCA/savings-circles was *also* crowded (CrediQuest, TrustCircle, Moigye, e-Equb) — the one with
  the best polish won.
- 2nd and 3rd were **experienced teams with existing products**, both Korea-based/adjacent.
- Both explicitly narrated USC alignment even though USC wasn't live. Signalling protocol-fit mattered.
- **No judge commentary, rubric, or panel is published anywhere.** DoraHacks' prize APIs return empty.

---

## Fall 2026 (current edition)

Aug 13 – **Sept 6 23:59 ET** · winners **Sept 18** · CTC Ignition Seoul **Sept 28**. Same $15k (10/3/2).

- **5 tracks — AI was added.**
- **Hard gate: every submission must integrate Attestcoin.** "Depth of Attestcoin Protocol
  utilization will be evaluated as one of the core scoring criteria." Working code + technical docs
  required. *This is new — Spring had no such requirement because USC wasn't live.*
- All winners get CertiK: 8K audit credits + 3 months Skynet Boost.
- As of Aug 16: **69 registered hackers, 0 submissions posted.**

### Live competitor intel

GitHub search for `attestcoin`: **14 repos, 12 created Aug 3–16** — i.e. this cycle's field.

| Repo | Created | Angle |
|---|---|---|
| [darkty0x/proofyield](https://github.com/darkty0x/proofyield) | 08-03 | RWA yield vault (57MB — most built-out) |
| [0xConsole/attestflow](https://github.com/0xConsole/attestflow) | 08-12 | Cross-chain DeFi sentinel / AI agent |
| [thesithunyein/spark](https://github.com/thesithunyein/spark) | 08-13 | DeFi credit gated by USC proofs |
| [OoJae/crosscredit](https://github.com/OoJae/crosscredit) | 08-13 | Cross-chain credit reputation |
| [dolepee/ruledrop](https://github.com/dolepee/ruledrop) | 08-13 | Cross-chain claims settlement |
| [PhiBao/unbridged](https://github.com/PhiBao/unbridged) | 08-14 | Trustless cross-chain credit line |
| [rudimentall1/AttestGuard](https://github.com/rudimentall1/AttestGuard) | 08-15 | AI-gated trade finance |
| [luongs3/ctc-settlement-rail](https://github.com/luongs3/ctc-settlement-rail) | 08-15 | Invoice financing |
| [bymichaelmann/backstop](https://github.com/bymichaelmann/backstop) | 08-15 | Deposit insurance via Attestcoin |
| [Anand-0038/loomcredit](https://github.com/Anand-0038/loomcredit) | 08-15 | Supplier finance + AI |
| [ikemeanthony40-collab/credit-reputation-agent](https://github.com/ikemeanthony40-collab/credit-reputation-agent) | 08-15 | Credit reputation agent |

**The field is re-converging on cross-chain credit reputation and invoice/trade finance — the exact
category that went 0-for-20 in Spring.** Nobody visible is doing Gaming or consumer.

---

## ☠️ CEIP — zero disclosed investments

- $10M fund, $25k–250k, equity *or* token, managed by Credit Labs, CIO Sung Choi. Applications
  opened **Jan 27, 2025**.
- **Zero named portfolio companies anywhere, 19 months later.** No portfolio page.
  `creditcoin.org/CEIP` returns **HTTP 404**. Only launch-cycle press exists, recycled across outlets.
- **No evidence any Spring 2026 winner received CEIP funding** despite the advertised fast-track.
  SnowBall's repo went quiet 2026-04-01; HashCredit's demo 404s.

**Treat the CEIP fast-track as marketing, not a funding pipeline, until proven otherwise.**

---

## Chain reality

### DefiLlama does not track Creditcoin at all
Not low TVL — **absent**. `api.llama.fi/v2/chains` → 461 chains, no Creditcoin.
`api.llama.fi/protocols` → 8,058 protocols, none list it. "creditcoin" absent from `config`.

### On-chain (Blockscout, 2026-08-16)

| Metric | Value |
|---|---|
| Total transactions | 12,267,946 |
| Total addresses | 1,488,500 |
| **Network utilization** | **0.0%** |
| Smart contracts | 3,760 (**422 verified**) |
| New contracts, 24h | **0** |

**Daily tx, last 31 days:** mean 3,939 but **median 1,344** — mean inflated by campaign spikes
(Aug 7: 29,836; Aug 6: 24,667). **Last four days: 215, 278, 343, 866 → ~426/day.**

**CTC:** $0.0654 · mcap $35.97M · rank #542 · 24h vol $585k · −99.2% from ATH.

### The dApp roster is 6 items, all first-party
[penguinbase.com/dapp](https://penguinbase.com/dapp) — statically bundled, nothing hidden:
SpaceRouter (Spacecoin) · Credit Wallet · PenguinBridge · PenguinSwap · Staking $SPACE · Staking $CTC.

Four are Gluwa's own infrastructure; two are Spacecoin — **founded by Tae Oh, the same founder**.
**Zero independent third-party dApps on the official ecosystem portal.**

---

## Developer activity

**GitHub [gluwa](https://github.com/gluwa):** 79 repos, **43 followers**.

| Repo | Stars | Contributors | Last push |
|---|---|---|---|
| creditcoin3 | 15 | 17 | 2026-08-14 |
| creditcoin | 36 | — | 2026-07-28 |
| usc-testnet-bridge-examples | **0** | 12 | 2026-08-12 |
| USC-Builder-Examples | **0** | 5 | 2026-08-05 |
| usc-message-relayer | 0 | 4 | 2026-08-07 |
| usc-sdk-rs | 1 | 6 | 2026-08-01 |

Actively maintained, but **every contributor checked is Gluwa staff or a bot**. External
contribution ≈ zero. USC example repos have **0 stars**.

**npm `@gluwa/usc-sdk`:**
- **2,442 downloads last month**; 19,585 total since 2026-03-23
- By month: Mar 2,156 · Apr 5,983 · May 2,823 · Jun 3,960 · Jul 3,558 · Aug (partial) 1,105 —
  **peaked in April, flat-to-declining since**. Largely CI/mirror traffic at this scale.
- **v0.18.0 published 2026-06-22 — ~2 months stale** going into a hackathon that mandates it
- **Zero published packages depend on it**
- No `gluwa/usc-sdk` repo exists; package points at `gluwa/cc-next-query-builder`

**Discord:** 60,006 members, **330 online** (0.55% — airdrop-farmed). **Telegram: 4,124.**

---

## Attestcoin production usage: none

- USC went live on **Creditcoin mainnet 2026-06-18** — **reads only, Ethereum mainnet only**. Writes
  and additional chains not live. First time attestors ran on mainnet.
- The launch post **names zero projects, partners, or usage metrics.**
- **No production or testnet user found outside the tutorials**, other than the ~12 Fall hackathon
  repos from the last two weeks.
- Spring's 2nd-place team deliberately did *not* use USC — it wasn't live — and reimplemented BTC SPV.

**You would be in the first cohort to ever ship anything real on Attestcoin.** Rough SDK and no prior
art, but "depth of Attestcoin utilization" is winnable precisely because nobody has experience.
