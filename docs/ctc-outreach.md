# CTC outreach — drafted issues, questions, and intro

Drafts only. **Nothing here has been posted.** Review, then file them yourself.

Two halves: **A–D are bug reports** to file on GitHub, and the **Questions** section is for
conversation. Every claim in both is something measured against the live chain or read out of the
SDK source — nothing here is inferred. If someone pushes back on any of it, the reproduction is in
the text.

Every claim below was checked against `@gluwa/usc-sdk@0.18.0` source on 2026-08-21 — the version
pinned in this repo since its first commit. Three further claims we previously held were withdrawn
after failing that check; see the *Withdrawn* section of
[ATTESTCOIN_INTEGRATION.md](ATTESTCOIN_INTEGRATION.md). Do not resurrect them.

**Where to file**

| Item | Repo | Notes |
|---|---|---|
| A, B, D | [gluwa/cc-next-query-builder](https://github.com/gluwa/cc-next-query-builder) | The SDK repo, per `package.json` `repository`. Issues enabled, **zero issues filed to date**. |
| C | [gluwa/creditcoin3](https://github.com/gluwa/creditcoin3) | Node/chain behaviour, not SDK. No existing `prevrandao` issue. |

Lead with C. It has a reproduction, it blocks a standard toolchain, and it is the one their team
can act on immediately.

---

## C — `forge script` cannot deploy to Creditcoin: `prevrandao` not set

**Repo:** `gluwa/creditcoin3`

> ### Summary
> Foundry's `forge script` cannot run against Creditcoin RPC endpoints. It fails during script
> deployment, before any user transaction is attempted, because the chain does not populate
> `prevrandao` in its block headers. `forge create` is unaffected, so this is specifically the
> script runner's header validation.
>
> ### Environment
> - Chain: CC3 Testnet, chainId 102031, `https://rpc.cc3-testnet.creditcoin.network`
> - Foundry: `forge 1.5.1-stable` (commit `b0a9dd9`)
> - Solidity: 0.8.24
>
> ### Reproduction
> No private key, no funds and no `--broadcast` required — it fails on a read-only dry run.
>
> ```solidity
> // script/PrevrandaoProbe.s.sol
> // SPDX-License-Identifier: MIT
> pragma solidity ^0.8.24;
> import {Script, console} from "forge-std/Script.sol";
>
> contract PrevrandaoProbe is Script {
>     function run() external view {
>         console.log("chainid    :", block.chainid);
>         console.log("prevrandao :", block.prevrandao);
>     }
> }
> ```
>
> ```
> forge script script/PrevrandaoProbe.s.sol:PrevrandaoProbe \
>   --rpc-url https://rpc.cc3-testnet.creditcoin.network
> ```
>
> ### Actual result
> ```
> Compiling 1 files with Solc 0.8.24
> Solc 0.8.24 finished in 1.27s
> Compiler run successful!
> Error: Failed to deploy script:
> EVM error; header validation error: `prevrandao` not set
> ```
>
> ### Root cause
> CC3 block headers carry no `mixHash` field and report `difficulty: 0x0`:
>
> ```
> curl -s -X POST https://rpc.cc3-testnet.creditcoin.network \
>   -H 'Content-Type: application/json' \
>   --data '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",false],"id":1}'
> ```
>
> `mixHash` is absent from the response. Post-Merge EVM exposes `mixHash` as `PREVRANDAO`, and
> Foundry's script runner validates the header before executing.
>
> ### Impact
> `forge script` is the standard Foundry deployment path, so most Solidity teams hit this on
> first contact and have no obvious diagnosis — the error names `prevrandao`, which is not
> something a deploy script references. It is a rough first-run experience for exactly the
> audience the hackathon is recruiting.
>
> ### Workaround
> Deploy with `forge create` instead, linking libraries explicitly:
> ```
> forge create src/MyContract.sol:MyContract \
>   --rpc-url $CC3_RPC_URL --private-key $KEY \
>   --libraries src/MyLib.sol:MyLib:0x...
> ```
>
> ### Suggested fix
> Populate `mixHash` in the RPC block response (zero is acceptable and is what several
> non-PoS EVM chains return). Failing that, documenting the workaround in the getting-started
> guide would save every Foundry user the same hour.

---

## A — Shipped examples call the deprecated `waitUntilHeightAttested`

**Repo:** `gluwa/cc-next-query-builder`

> The SDK ships two implementations of `waitUntilHeightAttested`. The one on
> `PrecompileChainInfoProvider` is marked legacy in its own docstring
> (`src/chain-info/index.ts`, and `dist/chain-info/index.d.ts:212` in the published package):
>
> > "This is a legacy implementation! Left unchanged to avoid impacting existing users. For
> > determining when to submit a proving request at a particular height, use the implementation of
> > `waitUntilHeightAttested` in src/proof-provider/service/index.ts"
>
> Both shipped examples call precisely that legacy method:
>
> - `examples/end-to-end.ts:19` — `await chainInfoProvider.waitUntilHeightAttested(chainKey, txHeight);`
> - `examples/supported-chains-attestation-information.ts:22` — same call
>
> Since the end-to-end example is the natural starting point, a new integrator adopts the
> deprecated path by default and never sees the notice, which lives on the method they are being
> steered away from. (We did exactly this.)
>
> The two also differ in substance, not just in age — the `ProofBuilder` implementation notes it
> relies on the proof builder service's attestation cache rather than on-chain data, so they can
> disagree near the head. Worth stating which is authoritative for which purpose.
>
> **Suggested fix:** update both examples to the `ProofBuilder` implementation, or, if the legacy
> one is correct for the example's purpose, add a line saying so — right now the docstring and the
> examples contradict each other.

---

## B — Default proof-builder timeout of 10s is too short for deep history

**Repo:** `gluwa/cc-next-query-builder`

> `ProofBuilder`'s constructor defaults `timeout` to 10 000 ms:
>
> ```
> // dist/proof-provider/service/index.js:108
> constructor(chainKey, builderUrl, timeout = 10000) {
> ```
>
> Proof size scales with continuity-root count, and that count depends on how far the source block
> sits from a sparse checkpoint — not on transaction age. Across five historical Ethereum blocks we
> sampled, it ranged from 1 to 601 roots. At the upper end, proof requests time out intermittently
> at the default; we pass `300_000` explicitly and the intermittency disappears.
>
> The failure is confusing because it is load-dependent rather than deterministic: the same code
> succeeds against a checkpoint-aligned block and fails against its neighbour.
>
> **Suggested fix:** raise the default, or note in the README that deep-history proving needs an
> explicit timeout. A one-line mention next to the constructor signature would be enough.

---

## D — Documentation suggestion: say that verification is a view path

**Repo:** `gluwa/cc-next-query-builder` (or docs)

> `verifySingle` and `verifyBatch` are implemented as `staticCall`
> (`dist/block-prover/index.js:114` and `:220`) and take no `Signer`, unlike `verifyAndEmit*`.
>
> The practical consequence is worth stating explicitly in the quickstart: **the entire proof
> pipeline can be built and tested with a zero balance.** Only `verifyAndEmit*` needs funds.
>
> It is inferable from the type signatures, but stating it removes a real barrier — we assumed we
> needed faucet CTC before we could start, and did not.

---

## Questions to ask — every one backed by something measured

These are not bug reports. They are roadmap and infrastructure questions where the answer changes
what wen can be built into. Each has evidence attached, so none of them is a guess.

**Context worth knowing before the conversation:** the node reports
`creditcoin3/v131.0/fc-rpc-2.0.0-dev` — `fc-rpc` is **Frontier**, the Substrate EVM layer. CC3 is
not a Geth-family chain. That single fact explains three otherwise-confusing things: no
`prevrandao` (BABE consensus rather than Ethereum PoS), `forge script` failing header validation,
and block times of exactly 15.00s with zero variance (Substrate slots, not a gas-market target).

```bash
curl -s -X POST https://rpc.cc3-testnet.creditcoin.network -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"web3_clientVersion","params":[],"id":1}'
```

---

### 1. Randomness — what should a game actually use?

**Measured.** Inside a transaction (not an `eth_call` — that distinction matters, see below):

| | |
|---|---|
| `block.prevrandao` | **0** |
| `blockhash(block.number)` — self | **0** |
| `blockhash(number - 1)` | real hash |
| `blockhash(n-256)` / `n-257` | works / zero — standard 256 window |

Chainlink VRF lists nine networks and Creditcoin is not among them. Creditcoin *does* appear in
Chainlink's ecosystem directory, which is a partnership listing, not a coordinator deployment —
easy to conflate.

So `blockhash` is the only verified option, and wen depends on it: the chart is drawn from
`keccak(blockhash(dealBlock), player, roundId)`.

> **"My game picks its chart from `blockhash`, because `prevrandao` returns 0 and Chainlink VRF
> isn't deployed here. Is that the recommended approach? Is `blockhash` a stability guarantee or
> incidental to the current client? And is a VRF or randomness feature planned?"**

**Have ready if pushed:** `prevrandao` returns 0 *from inside a transaction*. An `eth_call` probe
is misleading here — it executes against an already-mined block, so `blockhash(block.number)`
returns a real hash there and looks like it works.

**Why it matters to us:** if `blockhash` ever returned zero, the seed collapses to
`keccak(0, player, roundId)` — both knowable in advance — and every chart becomes predictable
before paying. Not degraded fairness; the game simply ends.

---

### 2. Block time — it is our load time

**Measured:** 40 blocks sampled, mean 15.00s, min 15s, max 15s. Not congestion; a fixed cadence.

Click-to-chart is 16.7s, of which 15s is one block. There is no application-side fix left.

> **"Blocks look like exactly 15s on CC3 testnet. Is that the same on mainnet, and is it likely to
> change? My game has to wait one block before it can show anything, so block time is basically my
> load time. Is there any way to know a transaction will be included before the block lands?"**

Frame it as *"block time is my load time"*, not *"15s is too slow"*. Same information, invites help
rather than defensiveness.

---

### 3. Account abstraction — the difference between two prompts and zero

A round needs two signatures, and that is the structural floor: the player pays **before** seeing
the chart and bets **after**. Information arrives in between; that gap is the game. The only way
below two prompts is signature delegation.

**Both routes are currently closed, measured:**

| | status |
|---|---|
| ERC-4337 EntryPoint (v0.6 / v0.7 / v0.8 canonical addresses) | none deployed |
| EIP-7702 (type-4 transaction) | `decode transaction failed` |

The 7702 probe used a control to be sure the method was sound: an unfunded **type-2** fails on
*funds* (so the node decodes it fine), while **type-4** fails on *decode* (the node does not know
the format).

**These are two different asks, and conflating them wastes the conversation:**

**EIP-7702 is entirely theirs.** It adds a transaction type the node itself must parse, shipping
with Prague/Pectra. No contract can add a transaction type — there is no deploying around it.

> **"Is Pectra / EIP-7702 on the roadmap for CC3?"**

**ERC-4337 is mostly ours, blocked on one node capability.** The contracts — EntryPoint, account
factory, paymaster — we can deploy. The **bundler** is the problem: it must simulate every
UserOperation before bundling, or it can be griefed into paying gas for operations that fail. That
simulation needs tracing, and:

```
debug_traceCall          Method not found
debug_traceTransaction   Method not found
eth_createAccessList     Method not found
txpool_content           OK          <- control: the RPC is healthy, these specifically are absent
```

> **"Three things on 4337: is there a `debug_traceCall`-enabled RPC endpoint, public or private?
> Do you plan to deploy the canonical EntryPoint, or should apps deploy their own? And is any
> bundler provider already supporting CC3?"**

The canonical-address point is the one people miss: smart wallets look for the *canonical*
EntryPoint. An app that deploys its own at a different address builds a closed system no existing
wallet recognises.

---

### 4. Softer ones, for when the technical thread runs out

- **"What have you seen this hackathon that surprised you?"** — cheap to answer, and people enjoy it.
- **"What does the CEIP fast-track actually involve?"** — signals you are thinking past the deadline.
- **"Is anyone else using attestation for history rather than live data?"** — if no, you are the
  case study; if yes, you have found your peers.
- **"What do proofs actually cost on mainnet?"** — and offer your gas distribution across 4,706
  proven candles in exchange. Ours are modelled, not billed; theirs will be real.

---

## Intro message (Discord / Telegram)

Keep it short. The issues are the credential; the message just points at them.

> Building on Attestcoin for BUIDL CTC (Gaming track) — a game that deals real slices of Ethereum
> price history and asks you to guess *when* it is, with every candle proven onto Creditcoin.
> Needed deep historical attestation specifically, so I've been fairly deep in the SDK.
>
> Filed a few things along the way — the one worth a look is that `forge script` can't deploy to
> Creditcoin at all (`prevrandao` not set); minimal repro in the issue, no key or funds needed.
> Also a contradiction between the SDK's examples and its own deprecation notice.
>
> Is there a channel where SDK issues get triaged, or is GitHub the right place?

**Verify the invite link from creditcoin.org or their X account before joining** — cloned Discords
and Telegram groups are the standard phishing play, and you'd be joining from a machine with funded
testnet wallets on it.

## Things NOT to claim

Checked and false, or unverified — see [ATTESTCOIN_INTEGRATION.md](ATTESTCOIN_INTEGRATION.md):

- ~~`waitUntilHeightAttested` doesn't exist on `ProofBuilder`~~ — it does, `service/index.d.ts:158`
- ~~`getBatchProof`'s nested Map is undocumented~~ — `examples/batch-proof-validation.ts` shows it
- ~~Batching is "10× cheaper"~~ — that ratio is the cost model divided by itself; it returns the
  batch size by construction
- Per-proof **CTC costs are modelled, not billed.** The constants are hardcoded and unvalidated.
  Quote root counts (measured); do not quote CTC amounts as measurements.
- Not re-verified this pass: the 37-block attestation lag, the 462k–1.3M gas range, and the
  "docs say so in bold" attribution on `receiptStatus`.
- **Do not say "Creditcoin has no randomness."** Say what was measured: `prevrandao` returns 0,
  Chainlink VRF is not deployed, `blockhash` works. Whether a native source exists somewhere we
  could not find is exactly what the question asks.
- **Do not claim the precompile set was audited.** A `cast code` scan finds nothing because native
  precompiles carry no bytecode — the known-good `0FD2` and `0FD3` also report `0x`. That scan
  proves nothing either way.
- **Do not say "4337 just needs a bundler."** It needs a bundler *and* the tracing RPCs a bundler
  depends on, which are absent from the public endpoint. Those are different asks.
