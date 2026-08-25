# CC3 platform notes

Things about Creditcoin CC3 Testnet that are not in the docs and that we had to measure. Every
figure here came from a probe against the live chain, and every probe is reproducible in under a
minute. Where a measurement could be taken the wrong way, the wrong way is written down too.

Chain: chainId 102031, `https://rpc.cc3-testnet.creditcoin.network`.

## It is Frontier, not a Geth-family chain

```bash
curl -s -X POST https://rpc.cc3-testnet.creditcoin.network -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"web3_clientVersion","params":[],"id":1}'
# creditcoin3/v131.0/fc-rpc-2.0.0-dev
```

`fc-rpc` is Frontier, the Substrate EVM layer. That one fact explains three things that otherwise
look like bugs: no `prevrandao` (BABE consensus rather than Ethereum PoS), `forge script` failing
header validation, and a block cadence that is exactly fixed rather than targeted.

## Randomness

Measured **inside a transaction**, which is the only context that counts:

| | |
|---|---|
| `block.prevrandao` | `0` |
| `blockhash(block.number)` — self | `0x000…0` |
| `blockhash(number - 1)` | real hash |
| `blockhash(n-256)` / `blockhash(n-257)` | works / zero — standard 256-block window |

**The trap:** an `eth_call` executes against an already-mined block, so probing
`blockhash(block.number)` that way returns a *real hash* and suggests the opposite conclusion. Only
a transaction that writes the value to storage tells you the truth.

Chainlink VRF is not deployed here — its v2.5 supported-networks page lists nine chains and
Creditcoin is not among them. Creditcoin does appear in Chainlink's *ecosystem directory*, which is
a partnership listing, not a coordinator deployment.

So `blockhash` is the only verified source. `GridGame` depends on it: the window is drawn from
`keccak(blockhash(dealBlock), player, roundId)`, and the security of that rests entirely on
`blockhash(block.number)` returning zero during `startRound` — which is why it is measured above
rather than assumed.

**Not established:** whether a native randomness precompile exists. A `cast code` scan cannot
answer this — native precompiles carry no bytecode, and the known-working `0FD2` and `0FD3` also
report `0x`.

## Block time is exactly 15s

40 blocks sampled: mean 15.00s, min 15s, max 15s. No variance at all, so this is configured
cadence rather than load.

It is the floor on anything that must wait for confirmation. wen's click-to-chart is 16.7s, of
which 15s is the block and ~1.7s is submission plus lookups.

## Account abstraction: 7702 is theirs, 4337 is ours

| | status |
|---|---|
| ERC-4337 EntryPoint, v0.6 / v0.7 / v0.8 canonical addresses | none deployed — but deployable by anyone |
| EIP-7702 type-4 transaction | `decode transaction failed` — needs a node upgrade |

The 7702 probe carries its own control: an unfunded **type-2** fails on *funds* — so the node
decodes it fine — while **type-4** fails on *decode*, meaning the node does not know the format.
7702 ships with Prague/Pectra and is a node-level change; no contract can add a transaction type.

4337 is different, and the first version of this note got it wrong. The contracts (EntryPoint,
account factory, paymaster) are deployable by anyone, but a bundler must simulate every
UserOperation before bundling or it can be griefed into paying gas for operations that fail. That
simulation needs tracing, and the **public** RPC has none of it:

```
debug_traceCall          Method not found
debug_traceTransaction   Method not found
eth_createAccessList     Method not found
txpool_content           OK          <- control: the endpoint is healthy
```

**That is a property of the public endpoint, not the chain.** Per Creditcoin's
[RPC guide](https://docs.creditcoin.org/rpc-guide#how-to-enable-evm-tracing), tracing is available
on a node you run yourself — add `--ethapi=debug,trace,txpool` to the `gluwa/creditcoin3` docker
run, keep `--pruning archive` so historical traces resolve, and point tooling at that endpoint. It
exposes `debug_traceCall`, `debug_traceTransaction`, `debug_traceBlockBy*`, `trace_filter` and the
txpool methods. Their docs advise against enabling it on validators or public RPCs because
replaying execution is CPU and IO intensive — which is why it is off by default rather than
missing.

So 4337 is **not blocked on Creditcoin**; it is blocked on running an archive node with tracing
plus a bundler service. Real ops, but ours to decide rather than theirs to ship.

Consequence for this project: **two wallet prompts per round is the floor, and we are choosing to
stay there.** The player pays before seeing the chart and bets after; information arrives in
between, and only signature delegation collapses that.

Three routes, and why each is or is not taken:

- **EIP-7702 — the one we want, not yet available.** The EOA becomes the account, so a delegated
  session spends straight from the wallet. No pre-funding, no commitment.
- **ERC-4337 — available, not worth it.** The canonical CREATE2 deployer is present at
  `0x4e59…4956C`, so the EntryPoint could go at its canonical address and existing smart wallets
  would recognise it. But bundlers need `debug_traceCall` with a JS tracer and this is Frontier,
  not Geth — untested, and Fantom is precedent for a client that had the method but still could
  not run bundlers. Cost is ~$60–120/mo self-hosted plus ops. A bundler only we use is a relayer
  with extra steps.
- **Custom session keys — rejected on product grounds.** A session key cannot touch the player's
  wallet balance, only credit already inside the contract, because the key is deliberately weak.
  That forces a deposit before the first round. We removed exactly that friction earlier in the
  project and are not reintroducing it to save a popup. This is the trap: session keys and 7702
  look interchangeable on a feature list, and are not — one demands commitment upfront, the other
  does not.

The third prompt is already gone: `resolveRound` is permissionless, so a keeper settles it and the
player never signs after the chart has played out.

## Foundry

`forge script` cannot deploy here — the runner rejects the header before executing. Reproduction in
[`contracts/script/tmp/PrevrandaoProbe.s.sol`](../contracts/script/tmp/PrevrandaoProbe.s.sol);
needs no key, no funds and no `--broadcast`.

```
Error: Failed to deploy script:
EVM error; header validation error: `prevrandao` not set
```

Use `forge create` with an explicit `--libraries` link instead. Note that `--constructor-args` is
variadic and will swallow a trailing `--broadcast`, which fails silently as "run again with
--broadcast" — put the flag first.

## Gas and throughput

- Block gas limit **75,000,000**; the chain sits idle at ~350k used.
- `ChartVerifier.recordCandle` costs 462k–1.3M gas depending on continuity-root count, so 57–162
  candles fit in one block. The chain was never the bottleneck when proving the corpus — the
  prover API was, at ~4s per proof.
- Proof cost in CTC is **not** measured anywhere in this repo. The figures in
  [ATTESTCOIN_INTEGRATION.md](ATTESTCOIN_INTEGRATION.md) come from a linear model whose constants
  are hardcoded and unvalidated.
