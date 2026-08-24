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

## Account abstraction is unavailable

| | status |
|---|---|
| ERC-4337 EntryPoint, v0.6 / v0.7 / v0.8 canonical addresses | none deployed |
| EIP-7702 type-4 transaction | `decode transaction failed` |

The 7702 probe carries its own control: an unfunded **type-2** fails on *funds* — so the node
decodes it fine — while **type-4** fails on *decode*, meaning the node does not know the format.
7702 ships with Prague/Pectra and is a node-level change; no contract can add a transaction type.

4337 is different: the contracts (EntryPoint, account factory, paymaster) are deployable by anyone,
but a bundler must simulate every UserOperation before bundling or it can be griefed into paying
gas for operations that fail. That simulation needs tracing, and the public RPC has none of it:

```
debug_traceCall          Method not found
debug_traceTransaction   Method not found
eth_createAccessList     Method not found
txpool_content           OK          <- control: the endpoint is healthy
```

Consequence for this project: two wallet prompts per round is the floor. The player pays before
seeing the chart and bets after; information arrives in between, and only signature delegation
could collapse that.

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
