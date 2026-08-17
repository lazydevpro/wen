# Competitive Landscape

Research compiled 2026-08-16 for BUIDL CTC 2026 Fall. Figures are as-reported by cited sources;
crypto metrics vary by tracker, so treat single figures as order-of-magnitude. Dead and shrinking
products are included deliberately — the failure patterns are more instructive than the wins.

---

# 1. Attestation / cross-chain verification — Attestcoin's actual peer group

## 1a. Flare Network ⚠️ **the closest competitor**

Flare runs near-identical architecture to Attestcoin, enshrined at the consensus layer.

| Product | Detail |
|---|---|
| **State Connector** | Original protocol. Decentralized Attestation Providers reach consensus on external chain data. No capital requirement to run one. Now superseded. |
| **Flare Data Connector (FDC)** | Replacement, live via FIP.12. Requires 50%+ signature weight. Merkle tree with only the root on-chain; proofs served off-chain via a Data Availability Layer. **35% of network inflation** funds providers. |
| **FTSO** | Price feed oracle, enshrined at protocol level |
| **FAssets** | Flagship consumer: brings **BTC, DOGE, XRP** — non-smart-contract chains — into EVM smart contracts, overcollateralized by BTC/stablecoins/ETH/FLR |

**FDC attestation types:** `AddressValidity`, `BalanceDecreasingTransaction`,
`ConfirmedBlockHeightExists`, `Payment`, `ReferencedPaymentNonexistence`, plus a generic
**EVMTransaction** type covering any other EVM chain.

### Why this matters more than anything else in this document

1. **Flare can prove non-existence.** `ReferencedPaymentNonexistence` proves an agreed payment was
   *not* made by a deadline. Attestcoin structurally **cannot** prove absence — inclusion proofs
   only. Flare built a purpose-made attestation type for exactly the gap that kills Attestcoin's
   monitoring and default-detection use cases.
2. **Flare covers non-EVM chains** (BTC, DOGE, XRP). Attestcoin covers Ethereum.
3. **Proofs valid for states no older than 14 days**, but once constructed remain available
   indefinitely — a cleaner model than Attestcoin's cost curve that rises ~12× with age.
4. **New attestation types can be added by provider consensus** — extensible without a chain fork.
5. Flare markets the same differentiator Creditcoin does: protocol-level, not bolted on at the
   application layer like an oracle, so it inherits the whole network's economic security.

## 1b. zk light clients

| Player | Traction | Key metric |
|---|---|---|
| **Succinct (SP1)** | $1B+ secured | IBC Eureka: 120+ Cosmos chains → Ethereum at ~200k gas (25× reduction). Cut ZK Tendermint proving 2.2h → 4.6min |
| **Polyhedra (zkBridge)** | 40M+ proofs, 25+ chains | 80M → 230k gas (350× reduction). $75M raised, $1B valuation (Polychain). deVirgo distributed prover |

Production migrations: **Gnosis OmniBridge** ($40M TVL, $1.5B+ stablecoin flow) replaced its
multisig with SP1. **IoTeX IIP-57** (2026) proposes the same after the ioTube exploit.

## 1c. zkTLS / web proofs — adjacent attestation primitive

Proves facts from ordinary HTTPS sessions. Complements rather than competes: oracles publish
public data; zkTLS proves private, session-gated data without the source's cooperation.

| Player | Funding | Detail |
|---|---|---|
| **Reclaim Protocol** | — | Proxy model, furthest along. 2–4s mobile proofs, no app/extension. **889 community data sources**. Break probability 10⁻⁴⁰ per "Proxying is Enough" |
| **zkPass** | $17M total ($12.5M Series A Oct 2024; $100M FDV Nov 2025) | 3P-TLS + hybrid ZK. **10M+ ZKPs, 300+ schemas, 80+ integrations** |
| **Opacity** | $12M seed | MPC + FHE. 1.4s mobile proofs. Hired six ex-zkPass core contributors Oct 2025 |
| **TLSNotary** | — | Open-source verifier infrastructure |
| **vlayer** | — | Web proofs |
| **DIA ZK** | — | zkTLS + TEE + signed attestations for stablecoins, RWAs, vaults |

Devconnect now runs a dedicated **zkTLS Day**. 3Jane uses zkTLS for off-chain VantageScore.

⚠️ Same fundamental limit as Attestcoin: *a proof binds a value to its source but does not make
the source honest.*

## 1d. On-chain attestation registries

| Player | Detail |
|---|---|
| **EAS (Ethereum Attestation Service)** | Public good, token-free, permissionless. Two contracts: schema registry + attestation. Natively integrated into the **OP Stack**. Millions of attestations. Optimism RetroPGF runs on it |
| **Verax** | Linea's registry. Passport writes full attestation to EAS, partial to Verax |
| **Human/Gitcoin Passport** | Stamp + score attestations minted on-chain via EAS. **$2 mint fee**, entirely opt-in |

EAS ecosystem: Superchain attestoooors, Receipts.xyz, Bountycaster, Impact Garden, KarmaHQ,
Icebreaker, DeVouch.

---

# 2. Oracles

| Player | TVS share (Q4'25) | Value secured |
|---|---|---|
| **Chainlink** | 73.1% | $48.2B |
| **Chronicle** | 12.8% | $8.4B |
| **RedStone** | 7.8% | $5.2B |
| **Pyth** | 6.3% | $4.2B (**−32% QoQ**) |

## Chainlink — full product catalog

**Data:** Data Feeds · Data Streams · SmartData · **Proof of Reserve** ($17B+ verified, 40+ feeds)
· NAVLink Feeds (tokenized fund NAV)

**Compute:** VRF (v2.5, randomness) · Automation (v2, formerly Keepers) · Functions · **DECO**
(privacy, playground stage)

**Interop:** **CCIP** — $18B Q1'26 volume, 70+ chains, Swift's 11,500 banks, canonical bridge for
Coinbase cbBTC/cbETH · **DvP** (atomic delivery-versus-payment)

**Institutional:** **CRE** (Runtime Environment — sign-ups +50% MoM Q1'26; Aave, Midas; ISO 20022
formatting) · **ACE** (Automated Compliance Engine) · **DTA** (Digital Transfer Agent standard —
UBS Asset Management first adopter)

**Value capture:** **SVR (Smart Value Recapture)** — $18.3M all-time, **$8.3M in Q1'26 alone**,
**99% of oracle-related MEV capture**. Built via acquisition of Atlas (FastLane Labs)

**Programs:** SCALE · BUILD

**Business:** ~$75M annualised fees. 505+ protocols. $28T+ cumulative transaction value.
SOC 2 Type 2 + Type 1 + ISO/IEC 27001. **Listed on AWS Marketplace** (Apr 2026). Bank of England
Synchronisation Lab, DTCC Collateral AppChain (Q4'26 target), US Dept. of Commerce.
Amundi (€2.3T AUM) / Spiko fund hit **$400M AUM in three weeks**.

## API3 — the SVR comparison that teaches the most

| Product | Detail |
|---|---|
| **dAPIs** | First-party oracle feeds. 200+ feeds, 40+ chains, 40+ dApps |
| **OEV Network** | ZK-rollup order-flow auction selling rights to execute feed updates. **80% of OEV revenue to partner dApps**; API3 fee → buyback and burn |

Integrations: Compound, Yearn, Moonwell, Lendle, INIT Capital.

⚠️ **OEV Network has redistributed ~$281,000 total.** Chainlink SVR did **$8.3M in one quarter**.
Same idea. ~30× difference. API3 arguably shipped the concept first.

## Others

**Pyth** — pull model, 545 → 2,800+ feeds during 2025, sub-second, favoured by HFT. Pyth Pro
targets the $50B+ TradFi market-data industry; fixed income live with Fenics, OpenYield, Tradeweb.
PYTH Reserve recycles revenue. **Chronicle** — Proof of Asset; BlackRock BUIDL (Mar 2026).
**RedStone** — only provider with hybrid push/pull; fastest-growing 2025–26.

Push-model holdouts: Aave, Compound, Venus, Morpho, Pendle.
Cost: Pyth ~$100/day per 10k reads (~$0.01/update); RedStone Core $10–50/day.

---

# 3. Cross-chain messaging

## LayerZero
**Products:** OApp (messaging) · **OFT** (Omnichain Fungible Token) · OFT Adapter (for
already-deployed tokens) · ONFT · Executor (gas abstraction) · DVN framework (**~49 DVNs**,
"X of Y of N" security stacks) · LayerZero Scan

**Scale:** ~75% of bridge volume, $7.2B TVL, 60–150 chains, 733+ OFTs deployed, $166.9B cumulative.
**Revenue ~$33.4M** (~151 employees). Raised $300M+ (Sequoia, a16z, PayPal Ventures, Tiger, Samsung
Next, Circle). Revenue routed to ZRO buybacks; one post-snapshot month collected only $670k.

**OFT adopters:** Tether (USDT0) · PayPal (PYUSD, 12 chains, "bridge-less") · Wyoming Stable Token
Commission (FRNT) · Ethena (USDe)

## Wormhole
Messaging · Portal (token bridge) · **NTT** (Native Token Transfers, no pooled liquidity) ·
Settlement (intent-based) · **Queries** (cross-chain data reads) · CCTP integration ·
**MultiGov** (hub-and-spoke multichain governance) · Connect (drop-in UI widget) · WTT ·
WormholeScan. 40+ chains, $1B+ daily.

⚠️ MultiGov requires upgrading the token to NTT *and* adding Flexible Voting to the Governor — a
three-product dependency chain. Note this is the closest existing product to a "cross-chain
governance" idea.

## Axelar
GMP · **ITS** (Interchain Token Service, canonical addresses across 15+ chains) · **Interchain
Amplifier** (4 contracts + 1 relayer to add a chain) · Mobius Development Stack · **Squid** router.
$13B moved. **Circle acquired Interop Labs** (early 2026); AXL and the network continue under
community governance with Common Prefix developing.

⚠️ Squid has diverged — Squid Intents runs its own TEE settlement; Axelar isn't in the execution
path for intent-routed swaps. It now aggregates Axelar, CCTP, IBC, Chainflip, *and LayerZero*.

## Others
**Hyperlane** — permissionless deployment, 7 VM types (EVM, CosmWasm, Move, Starknet).
**Circle CCTP** — burn-and-mint native USDC, no locked reserves. **IBC Eureka** — Cosmos↔Ethereum
via SP1.

---

# 4. RWA / private credit

Category: ~$14B active on-chain loans, 8–15% APY; ~2/3 in the top three. Tokenized treasuries
~$15B (from ~$1B two years prior).

## Tokenized treasuries

| Product | AUM | Notes |
|---|---|---|
| **Circle USYC** | ~$3B | Category leader |
| **Franklin Templeton BENJI** | ~$2.3B | '40 Act fund, broader access, from $20 via consumer app |
| **BlackRock BUIDL** | ~$2.3B | Mar 2024, BNY Mellon administrator, Securitize transfer agent. Qualified purchasers only. 6 chains. T+0 USDC redemption via Circle |
| **Ondo OUSG** | ~$670M | Migrated 2024 to BUIDL + USYC + Superstate USTB |
| **Ondo USDY** | — | ~4.8% APY, non-US retail, price-appreciating, Reg S 40-day seasoning |
| **Superstate USTB** | — | Invesco Advisers took over portfolio management Q2'26 |

BUIDL held as reserve collateral by Ethena, Sky, Frax; accepted as margin by Crypto.com and Deribit.

## Private credit

| Player | Scale | Model |
|---|---|---|
| **Maple** | $2.2B deposits | Institutional underwriting; syrupUSDC |
| **Centrifuge** | Large by TVL | Senior/junior tranching |
| **Huma** | $1.5B+ processed, **$17M annualised revenue** | PayFi |
| **Wildcat** | $103M | Permissionless, no oversight. $3.5M seed ext. (Robot Ventures). Borrowers: Wintermute, Amber, Keyrock, Selini |
| **Clearpool** | $23M | Institutional pools |
| **TrueFi** | $8M | Was $1.7B+ originations in Aug 2022 |
| **3Jane** | — | Cred Protocol + Blockchain Bureau scores + zkTLS VantageScore. Collections-agency auctions for NPLs |
| **Goldfinch** | ☠️ **WOUND DOWN** | ~$100M originated, ~$50M defaults |

---

# 5. Risk, security & monitoring

| Player | Scale | Model |
|---|---|---|
| **Hypernative** | $40M Series B (Jun 2025); $65–107M total; **200+ protocols, $100B+ protected, 70+ chains, 300+ risk types** | SaaS + automated on-chain response. Products: Guardian (blind-signing protection), ION (AI security agent). Detected $2.2B in 2024 losses |
| **Hexagate** | **Acquired by Chainalysis, ~$60M** (Dec 2024) | Raised only $8.6M seed. Customers: Coinbase, Consensys, Polygon, EigenLayer, Uniswap, Securitize, Immutable. Saved $1B+; 98%+ of known hacks detected pre-event |
| **Gauntlet** | **~$32M/yr** (Morpho curation) | 8–15% performance fee + token emissions, 13 chains |
| **Chaos Labs** | Exited Aave Apr 2026 | Risk Oracles, Chaos Vaults, Edge |
| **Forta** | — | OpenZeppelin/a16z incubated. Firewall: blocks malicious txs pre-execution |
| **Blockaid** | — | Scans 15M+ sites daily, 500+ new malicious apps detected |
| **Ironblocks** | — | Modular security layer, on-chain compliance |
| **Tenderly / Guardrail** | — | Developer monitoring |

Other exits: Blowfish→Phantom · Wallet Guard→ConsenSys · Staging Labs→Merkle Science ·
Transpose→Chainalysis.

**Aave economics:** paid Gauntlet + Chaos **$3.2M/yr**. Offered Chaos **$5M/yr**; Chaos walked,
citing 3 years of operating losses. Gauntlet exited Compound 2023. Four contributors left Aave
(BGD Labs, ACI, Gauntlet, Chaos). A Mar 2026 Chaos CAPO misconfiguration caused **$26.9M in
erroneous liquidations** — no settled liability framework exists.

---

# 6. Settlement & dispute-resolution oracles

| Player | Detail |
|---|---|
| **UMA** | Optimistic Oracle + DVM. **99.8%** of requests resolve without dispute. MOOv2 (Nov 2025) restricted proposals to **37 pre-approved addresses**. Powers Polymarket, bridges, insurance |
| **Kleros + Reality.eth** | Subjective oracle. Multi-round bond escalation (bonds double each round) vs UMA's single round, plus appeals. Atlas architecture 2024–25 |
| **Azuro** | Settlement + liquidity layer. **4.28% take rate**, $358M volume, 4.8M txs, **$3.4M revenue**, 28 apps, $11M raised (Gnosis-led) |
| **Hyperliquid HIP-4** | Removed the oracle entirely — validator set settles from newsfeeds |

**UMA's documented weakness:** WSJ found >half of votes in disputed markets came from the 10
largest wallets; ~60% of active UMA voters linked to Polymarket accounts; ~1 in 5 disputes had a
conflicted voter. A 25% stake controlled a $7M resolution (Ukraine minerals, Mar 2025). ~$60M
Strategy Bitcoin dispute (2026). $750 bond gates participation to well-funded actors.

---

# 7. On-chain credit scoring

| Player | Raised | Status |
|---|---|---|
| **Spectral** | ~$30M (General Catalyst, Social Capital, Circle, Franklin Templeton, Samsung Next, Jump, Gradient, Section 32) | MACRO score (350–850). 30k+ users checked scores. **Pivoted** to B2B / AI agents |
| **Cred Protocol** | — | ML liquidation-propensity model. 30+ protocols, 300M+ scorable addresses. **Pivoted** to B2B API. x402 integration |
| **RociFi** | $2.7M seed (Arrington, GoldenTree, NEXO, LD, Skynet) | NFCS ERC-721 score. Enforcement was **social** — publish defaulter info to social channels |
| **ARCx** | — | DeFi passport; liquidation deducted 250 points |
| **Credora / ChainAware / Providence / Blockchain Bureau** | — | Ratings and analytics |

**Documented failure modes:** thin data chicken-and-egg · sybil/score transferability · selection
bias (only opt-in borrowers present scores) · output is a number, not a lending decision · no fraud
signal · **loan data manipulable by self-lending in loops** (0xngmi, DefiLlama).

---

# 8. ☠️ The graveyard

## Bridges — >$1.2B across four events

| Bridge | Loss | Cause | Outcome |
|---|---|---|---|
| **Ronin** | ~$625M (Mar 2022) | 5 of 9 multisig keys compromised via fake job offer. **Undetected for 6 days** | Restarted after 3 months; refinanced |
| **Nomad** | ~$190M (Aug 2022) | Upgrade initialised trusted root to **zero** → copy-paste free-for-all. Days after announcing a $22M seed (Polychain, Coinbase Ventures, Crypto.com) | Partial white-hat returns |
| **Harmony Horizon** | $100M (Jun 2022) | 2-of-5 multisig. No exploit needed | ☠️ Dead. $10M bounty failed; community rejected ONE-issuance reimbursement |
| **Multichain** | — (Jul 2023) | Keys **all controlled by the CEO** | ☠️ Permanent shutdown |
| **Wormhole** | ~$320M (Feb 2022) | VAA verification bypass, unbacked wETH on Solana | Jump Crypto replaced funds |
| **Orbit Chain** | — (Jan 2024) | 7 of 10 multisig keys | — |
| **Secret/Axelar** | $4.67M | Infinite mint; found a week later via an "insufficient funds" error | — |
| **Polkadot–Ethereum** | ~$237k realised (Apr 2026) | Minted **1B DOT**; thin liquidity capped damage | — |
| **KelpDAO rsETH** | $292M (Apr 2026) | **1-of-1 DVN**, RPC nodes poisoned, forged burn on Unichain. Pause came 46 min late | $177M bad debt at Aave |

2026 YTD: ~$328.6M across 8 bridge incidents; ~$606M stolen in April alone.

## DeFi insurance — a one-protocol category

| Player | Peak | Now |
|---|---|---|
| **Nexus Mutual** | — | $81.6M–$123.5M TVL = **~85% of the entire sector** |
| **InsurAce** | $150M | **$132,000** (−99.9%) |
| **Sherlock** | $60M | **$505,000** (−99.2%) — now a *security partner* to Nexus, not a competitor |
| **Unslashed** | — | A few $M stuck in code not updated since late 2024 |

Sector TVL ~$123.5M across 28 tracked protocols = **0.14% of DeFi**. Peak was $1.89B (Nov 2021).
**Under 2% of DeFi's $83B is insured** against $7.7B of cumulative lending exploits.
Nexus: covered $6.5B, paid just **$18.5M** in claims over 7 years — top three being FTX (~$7.3M),
TribeDAO ($5M), Euler ($3.4M). Nexus is pivoting upstream to Bug Bounty Cover with Immunefi.

**Diagnosis:** a public-goods problem — the lighthouse can't charge passing ships. Demand is
theoretically obvious; willingness to pay premiums never materialised.

## Credit / lending blowups
**Maple/Orthogonal** — $36M across 8 loans (**30% of protocol active loans**); $31M in the M11 USDC
pool = **~80% loss** for remaining LPs. Orthogonal claimed $2.5M FTX exposure through November, then
defaulted Dec 3; "operating while effectively insolvent"; BVI provisional liquidation.
Earlier: Babel (Jun 2022). **TrueFi** — Blockwater, Invictus defaults. **Auros** — $7.5M.
**Goldfinch** — Tugende ($5M, $1.9M diverted Kenya→Uganda, found at quarterly reporting), Stratos
($20M, $7M written to zero, underwriter unaware of a $2M POKT position), Almavest ($2.1M late) →
wound down. **Centrifuge** — ~$5.8M overdue 2023, French consumer microloan pool ended in litigation.

## Context
Total DeFi TVL fell **37% in 2026** to $71.77B (from $109.69B in Jun 2025). Q1'26 losses from
hacks/exploits/fraud ~$482M.

---

# What works — and why

## ✅ Sit in the liquidation/settlement path
Chainlink's moat isn't data quality; feeds are wired into liquidation engines, so switching risks
insolvency rather than costing migration effort. 73% TVS, ~$75M fees.
**Contrast:** credit scores are advisory → zero switching cost → zero pricing power → Spectral and
Cred both pivoted despite ~$30M raised.

## ✅ Own the standard, price the transaction at ~zero
LayerZero: $7.2B TVL, ~$33.4M revenue, deliberately. OFT is **lock-in, not a revenue line** — once
Tether or PayPal deploys canonical supply via OFT contracts, leaving means re-architecting supply
accounting. Burn $300M of VC to become the default rail. Circle CCTP, Wormhole NTT, Axelar ITS all
run the same play.

## ✅ Capture a value stream nobody was capturing
Chainlink SVR: oracle updates *create* MEV; they now recapture and share it. $8.3M in one quarter,
99% share.
**But see API3 OEV: same idea, ~$281k total.** The concept wasn't the moat — occupying the position
where value leaked was.

## ✅ Be a principal, not an advisor
Gauntlet: $1.6M/yr as Aave advisor → **~$32M/yr** as Morpho curator. Same firm, ~20×. Chaos walked
from $5M/yr because it still lost money. Governance-funded retainers are dead; performance fees on
routed capital are not.

## ✅ Distribution beats technology
Chainlink's 2026 wins are procurement wins — AWS Marketplace, SOC 2 Type 2, ISO 27001, Swift, DTCC,
Bank of England. **Counter-example:** Pyth has better HFT architecture and 2,800+ feeds and lost
**32% of TVS in one quarter**; RedStone passed it with hybrid push/pull by meeting protocols where
they already were.

## ✅ Get acquired by compliance incumbents
Hexagate: $8.6M seed → **~$60M exit** to Chainalysis in ~2 years. Security monitoring has a real
exit path into the compliance stack.

---

# What consistently fails

| Pattern | Evidence |
|---|---|
| Advisory products with no enforcement hook | Spectral (~$30M), Cred, RociFi, ARCx — all pivoted or faded |
| Service retainers paid by DAO governance | Chaos exited Aave; Gauntlet exited Aave *and* Compound |
| Lending against unverifiable off-chain counterparties | Goldfinch wound down; Maple −80% pool; TrueFi $1.7B→$8M; Centrifuge litigation |
| Selling protection nobody buys | Insurance: $1.89B → $123M; InsurAce −99.9%; Sherlock −99.2% |
| Superior technology without distribution | Pyth −32% TVS; API3 OEV $281k vs SVR $8.3M/quarter |
| Trustlessness as the primary pitch | Majority of bridge TVL still flows through trusted systems |
| Multisig/committee custody of bridged value | >$1.2B across Ronin, Nomad, Harmony, Multichain |

---

# Implications for Attestcoin

**Attestcoin's true peer group is Flare, Succinct and Polyhedra — not Chainlink or LayerZero.**

Against them:

| | Attestcoin | Flare FDC | Succinct SP1 | Polyhedra |
|---|---|---|---|---|
| Source chains | **Ethereum only** | BTC, DOGE, XRP + any EVM | 120+ via IBC Eureka | 25+ |
| Prove non-existence | ❌ | ✅ `ReferencedPaymentNonexistence` | — | — |
| Flagship consumer app | ❌ none | ✅ FAssets | ✅ Gnosis OmniBridge | ✅ zkBridge |
| Write path | ❌ not live | ✅ | ✅ | ✅ |
| Funding/validation | CEIP $10M fund | 35% of inflation | $1B+ secured | $75M @ $1B val |

Three structural problems:

1. **Late entrant, narrowest coverage.** One source chain against 25–120+.
2. **Weakest capability.** Flare shipped an attestation type for exactly the exclusion-proof gap
   Attestcoin cannot close.
3. **The pitch is the one that doesn't sell.** Creditcoin markets *"No bridges. No oracles. No
   trust assumptions."* Every pattern above says trustlessness is bought reactively, post-incident,
   by ideologically-aligned buyers. Both category leaders won on configurability, reliability,
   compliance and distribution instead.

**And note what died:** DeFi insurance is a one-protocol category down 93% from peak — which
independently kills the parametric-insurance idea from the earlier pressure test.
