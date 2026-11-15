# Adding a chain

Bitcoin was the second chain, after EVM. This note measures from git what adding it took and
explains every file it touched outside `src/adapters/bitcoin/`. Then it lists the conformance
checks that needed something special on Bitcoin, gives a checklist for the next chain, and
says which chain that would be.

## What adding Bitcoin took

`scripts/chain-cost.ts` reads the numbers from git, with `git show --numstat` for each commit.
It takes the adapter's directory and the commits that make up the work, listed one by one
rather than as a range, because other work landed between them. `make chain-cost` runs it on
the seven commits of milestone 4: the regtest node and its devnet controls, then the fix from
their review; the adapter's first part, then its fix; the second part, then its fix; and the
pipeline and fault run on regtest.

Two kinds of commit are left out. `ee6d484` and `428ceae` landed between those seven, but they
are fault-run fixes from the previous milestone, not Bitcoin work. The code commits after
`10ef314` (from `ad1cadc` on) hardened both adapters and the pipeline after a review of the
whole repository; they are not part of the measurement, and
[After the measurement](#after-the-measurement) says what they changed outside the adapters.

It needs the repository's history: in a shallow clone git cannot show these commits.

```text
$ make chain-cost
npx tsx scripts/chain-cost.ts src/adapters/bitcoin dfc12c8 df96c74 a4e163c 14f50c3 4361425 c6fcb73 10ef314
Adapter directory: src/adapters/bitcoin/
Commits: 7, by author time
  dfc12c8  2026-11-12T14:37:57+05:30  feat(bitcoin): regtest node from the official release, RPC client, devnet controls
  df96c74  2026-11-12T14:51:04+05:30  fix(bitcoin): test the drop's survivor logic, clearer RPC errors, no image volume
  a4e163c  2026-11-12T15:04:19+05:30  feat(bitcoin): P2WPKH adapter with external signing, conformance C1-C10, C13, C16
  14f50c3  2026-11-12T15:38:57+05:30  fix(bitcoin): cover multi-input transfers, fund C13 twice in the suite, startup checks
  4361425  2026-11-12T15:57:02+05:30  feat(bitcoin): replace-by-fee, block scan; conformance C11-C15
  c6fcb73  2026-11-12T16:14:00+05:30  fix(bitcoin): build replacements from the previous attempt and check them against the reservation
  10ef314  2026-11-12T17:07:15+05:30  feat(bitcoin): pipeline and fault run on regtest

Files outside src/adapters/bitcoin/, lines summed over the commits:
  category                   added  removed  file
  conformance suite              2        0  src/conformance/suite.ts
  chain registry and config     31        8  src/chains.ts
  chain registry and config     11        3  src/config.ts
  test harness                 126       81  scripts/fault-run.ts
  test harness                  60        0  scripts/lib/bitcoin-env.ts
  test harness                   8        2  scripts/lib/env.ts
  test harness                   2        0  scripts/lib/evm-env.ts
  test harness                  41       14  scripts/lib/results.ts
  test harness                  12        2  scripts/lib/sandbox.ts
  test harness                 113       40  scripts/lib/scenarios.ts
  test harness                   4        3  scripts/lib/supervisor.ts
  test harness                 537        5  test/bitcoin.adapter.test.ts
  test harness                  59       16  test/bitcoin.conformance.test.ts
  test harness                 274       19  test/bitcoin.devnet.test.ts
  test harness                  46        0  test/bitcoin.pipeline.test.ts
  test harness                  60       10  test/fault-run.test.ts
  test harness                   4        2  test/pipeline-suite.ts
  test harness                  48        0  test/runtime.test.ts
  infrastructure                19        0  docker-compose.yml
  infrastructure                37        1  docker/bitcoind/Dockerfile
  infrastructure                 1        1  Makefile
  infrastructure                49        0  package-lock.json
  infrastructure                 1        0  package.json

Totals:
  inside src/adapters/bitcoin/   3 files   +734 -116
  outside src/adapters/bitcoin/  23 files  +1545 -207
    core and pipeline            0 files   +0 -0
    conformance suite            1 file    +2 -0
    chain registry and config    2 files   +42 -11
    test harness                 15 files  +1394 -194
    infrastructure               5 files   +107 -2
    other                        0 files   +0 -0

First commit: 2026-11-12T14:37:57+05:30 (dfc12c8)
Last commit:  2026-11-12T17:07:15+05:30 (10ef314)
Elapsed:      2 h 29 min 18 s, author time, first to last commit
```

Lines are summed over the commits, so a line that one commit added and a later one changed
counts in both.

What the numbers say:

- `src/core/` and `src/pipeline/` did not change. The interface, the signer, the state
  machine, the ledger and the schema served a coin chain as they were: the coin table
  (`chain_coins` in `migrations/001_init.sql`) and the Postgres store that reserves coins
  (`src/pipeline/input-store.ts`) were built with the EVM work, before Bitcoin (`41b1eef`).
- Outside the adapter, it took a registry entry and its configuration, one change to the
  conformance suite (C13 funds its wallet twice: a UTXO chain needs two coins for two
  concurrent reservations), and test-harness work. The node's container and one dependency
  are the infrastructure rows.
- Most of the lines outside the adapter are in the test harness. Four of its files are
  Bitcoin's own tests and one is its test environment; the others are the shared harness
  learning to run on more than one chain.

The elapsed time is author time from the first commit to the last. Coding agents did the
work, with review rounds between commits and other work interleaved (the two fault-run fixes
above landed inside the window). It is an upper bound on the effort, not a measure of a
person's hours.

### Why each file outside the adapter changed

**Conformance suite**

- `src/conformance/suite.ts`: C13 funds its wallet a second time. On EVM one balance pays for
  two transfers in flight; on a UTXO chain each needs a coin of its own. This is the one change
  to the suite.

**Chain registry and config**

- `src/chains.ts`: the `bitcoin-regtest` entry. Like the EVM entry, it builds its adapter from
  the environment it is given and checks the settings (URL scheme, finality depth) before it
  connects. Those two checks became helpers shared with the EVM entry, which is where the
  removed lines come from.
- `src/config.ts`: the default node URL (`http://127.0.0.1:58443`) and the regtest node's
  test-only RPC credentials, which the last commit moved into `defaults` so the registry entry
  reads them from there.

**Test harness: Bitcoin's own tests and test environment**

- `test/bitcoin.devnet.test.ts`: the devnet controls' tests (D1 to D8).
- `test/bitcoin.adapter.test.ts`: the adapter's own tests (B1 to B14), among them multi-input
  signing, change below dust, replacements and the start-up checks.
- `test/bitcoin.conformance.test.ts`: `runConformanceSuite` on regtest, with Bitcoin's harness:
  the addresses it must reject (other networks and other encodings of one key) and the
  replacement form. Until `4361425` it also skipped C14 and C15, not yet written.
- `test/bitcoin.pipeline.test.ts`: `runPipelineSuite` on Bitcoin, and a P4 variant that checks
  that twelve concurrent withdrawals reserved twelve disjoint coin sets and that each
  transaction spent exactly its own.
- `scripts/lib/bitcoin-env.ts`: Bitcoin's `PipelineEnv`, the test environment the pipeline
  suite and the fault run use.

**Test harness: shared files, so that they run on more than one chain**

- `scripts/lib/env.ts`: `PipelineEnv` gained two chain properties. `fundingPieces` is how many
  payments the sandbox funds the hot wallet with, because a coin chain needs a free coin for
  every withdrawal in flight. `reorgKeepsMempool` says whether a reorg puts the removed
  block's transactions back in the mempool (bitcoind) or forgets them (anvil).
- `scripts/lib/evm-env.ts`: EVM's values for the two (1 and false).
- `scripts/lib/sandbox.ts`: funds each float and each deposit in `fundingPieces` payments.
- `scripts/lib/scenarios.ts`: the reorg and stuck-fee scenarios check what the node should
  hold by `reorgKeepsMempool` and `stuckEvicts`. Reorg runs the workers without blocks until
  each withdrawal has recorded its block as reorganised out, because a transaction back in the
  mempool could otherwise be mined again before a worker saw it leave. A scenario can declare
  itself not applicable to a chain, with a reason (no scenario does yet). And random kills now
  submits withdrawals in batches until enough kills have caught a worker holding one, because
  on a fast machine a fixed count could finish before many kills happened; that change is not
  specific to Bitcoin.
- `scripts/lib/supervisor.ts`: the work a supervised run submits can read the kills so far,
  for that batching.
- `scripts/lib/results.ts`: the results table has a chain column and not-applicable rows, and
  the header names every chain's node version.
- `scripts/fault-run.ts`: runs every scenario on each chain in its `envs` map; `--chain` picks
  one.
- `test/fault-run.test.ts`: X4 runs the script on both chains; X6 checks the chain column and
  a not-applicable row.
- `test/runtime.test.ts`: a worker built from Bitcoin's variables refuses bad ones and builds
  the same hot wallet, node and finality depth as the sandbox.
- `test/pipeline-suite.ts`: F5 (an underfunded hot wallet delays a withdrawal and does not
  fail it) checked the state the withdrawal waits in, and that depends on the chain: on EVM it
  is signed and sent and the node refuses it; on Bitcoin no coin can be reserved and it stays
  `APPROVED`. The check became "never terminal". A later commit (`881ed0d`) made the waiting
  states a per-chain option, `underfundedWaitsIn`.

**Infrastructure**

- `docker-compose.yml`: the `bitcoind` service, regtest only, published on `127.0.0.1:58443`,
  with a healthcheck.
- `docker/bitcoind/Dockerfile`: the node image, built from the official Bitcoin Core release
  tarball with its SHA-256 pinned per architecture, since the spec allows only official images
  or official release tarballs (design call 17). Its fix dropped the `VOLUME` the image
  declared.
- `Makefile`: `make up` passes `--build`, so Compose builds the local bitcoind image.
- `package.json`, `package-lock.json`: the one new dependency, `@scure/btc-signer`, for
  addresses, transaction encoding and the BIP-143 signing digests.

### After the measurement

The code commits after `10ef314` came from a review of the whole repository and are not
counted above. Outside the adapters:

- `ad1cadc` changed comments only in `src/core/adapter.ts` and `src/core/signer.ts` (broadcast
  decides `already_known` by lookup and throws on a transport failure; a signer may return
  either S form) and in `src/conformance/harness.ts` (what `pendingFrom` counts on a UTXO
  chain). It also added F7 to the pipeline suite.
- `881ed0d` changed `src/pipeline/`. One of its fixes matters only once there is more than one
  chain: `claim` (`src/pipeline/worker.ts`) now takes only rows of the chains the worker has a
  runtime for, where before a worker could lease another chain's row, fail on it and back off.
  The others concern approvals, the 24-hour limit, error bookkeeping and reconciliation.
- `62c1d4f` changed the fault run, among other things funding the Bitcoin hot wallet in one
  payment. `3e6c182` changed CI, and how empty settings are read in `src/config.ts`,
  `src/chains.ts` and `src/pipeline/runtime.ts`. `9c935ac`, an EVM fix, changed a comment in
  `src/pipeline/worker.ts`.

## Conformance checks on Bitcoin

None needed a capability flag. The Bitcoin harness declares the `conflict` form of the
replacement check, as EVM's does, and the suite has no other switch, so every check runs on
both chains. What needed something special:

- **C11, drop.** bitcoind has no RPC that removes one transaction from its mempool, so the
  devnet's `dropFromMempool` (`src/adapters/bitcoin/devnet.ts`) uses the mempool's expiry: it
  moves the node's clock past the expiry with `setmocktime`, submits one payment so that expiry
  runs, puts the clock back, and sends the other transactions that were in the pool again (a
  child of the dropped one cannot come back, as on a real eviction). While it runs, nothing
  else may submit a transaction or mine.
- **C12, reorg.** The devnet's `reorg` invalidates the last blocks and mines empty ones at the
  same heights. bitcoind puts the removed blocks' transactions back in its mempool, so after a
  reorg the transaction is pending, not unknown, and the re-send finds it already known. C12
  already accepted either `accepted` or `already_known` for that re-send. The fault run states
  the same difference as `reorgKeepsMempool`.
- **C13, two reservations.** Two coins, the one suite change above.
- **C14, replacement.** BIP-125: the replacement spends the same coins and pays the same
  payment; only the change pays the higher rate.
- **C16, `pendingFrom`.** On a UTXO chain it counts the mempool transactions that spend the
  address's confirmed coins (`scantxoutset`, then `gettxspendingprevout`).

## How to add the next chain

1. **The adapter.** `src/adapters/<chain>/adapter.ts`: a factory that returns a `ChainAdapter`
   (`src/core/adapter.ts`) and refuses any node that is not a local dev chain, as both adapters
   do (EVM checks the chain id, Bitcoin that `getblockchaininfo` reports `regtest`). A chain
   with nothing to reserve returns `{}` from `reserveInputs`.
2. **The devnet.** `src/adapters/<chain>/devnet.ts`: the `Devnet` controls
   (`src/conformance/harness.ts`): `fund`, `mine` (blocks appear only when it is called),
   `dropFromMempool`, `reorg`, and `pendingFrom`, the number of transactions from a sender the
   node holds unmined. The fault run fails a scenario if the hot wallet's `pendingFrom` is not
   zero once its final blocks are mined.
3. **The conformance test file.** `test/<chain>.conformance.test.ts` calls
   `runConformanceSuite(name, makeHarness)` with a `ConformanceHarness`: the adapter, a signer
   (`LocalSigner.random()`), the devnet, the assets with `native` first, a transfer unit per
   asset, addresses the chain must reject, a transaction id it has never seen, and the
   replacement form (`conflict` or `after-expiry`). The `after-expiry` form of C14 is not
   written yet; the first chain that needs it adds it to the suite. The adapter's own tests go
   beside it.
4. **The registry entry and config.** An entry in `src/chains.ts` that builds the adapter from
   the environment it is given, never from `process.env`, checks the settings before it
   connects, and names the assets the kit serves; the default node URL on `127.0.0.1` in
   `src/config.ts`.
5. **The pipeline and the fault run.** A `PipelineEnv` in `scripts/lib/<chain>-env.ts` (its
   properties are explained in `scripts/lib/env.ts`), `test/<chain>.pipeline.test.ts` calling
   `runPipelineSuite`, and an entry in the `envs` map of `scripts/fault-run.ts`.
6. **The Compose service.** In `docker-compose.yml`: an official image, or a Dockerfile that
   downloads the official release and checks its hash; ports published on `127.0.0.1` only; a
   healthcheck, so that `docker compose up -d --wait` waits for the node.
7. **If the chain has no mempool or no forks.** The conformance harness has no capability
   flags today, only the replacement form. The first such chain adds flags to
   `ConformanceHarness` and skips, with the reason, the checks that need a transaction to stay
   pending until `mine` (for example C10's `pending` step, C11 and C16) or a fork (C12, and the
   reorg in C15); the pipeline suite's drop and reorg tests (F1, F2) need the same. In the
   fault run, the scenario gets a `notApplicable(env)` that returns why the chain cannot
   produce its fault, read from a new `PipelineEnv` property; the run then lists the scenario
   as not applicable on that chain, with the reason, and leaves it out of the totals.
8. **Measure it.** `npx tsx scripts/chain-cost.ts src/adapters/<chain> <commit>...` with the
   commits of the work, and update this note.

## Next chain

Solana was the first choice for a third chain, because a signed transaction carries a recent
blockhash and expires with it, which would exercise the `null` branch of `buildReplacement`.
It was ruled out because the kit's chains must run in Docker on linux/arm64 from official
artifacts, and Solana's do not (checked 2026-11-12, spec section 7): Agave v4.4.1 and the 30
releases before it publish Linux tarballs for x86_64 only, the official image `anzaxyz/agave`
is amd64 only, and run under emulation, `solana-test-validator` stops with
`assertion failed: io_uring_supported()`. Community arm64 images exist; design call 17 rules
them out.

Algorand's official `algorand/algod` image in dev mode was checked instead, and it runs
natively on arm64. What an Algorand adapter would exercise:

- **An expiry-model replacement.** A transaction has no account nonce; it names a first and a
  last valid round and is dead after the last. Signing a second transaction while the first
  can still be included would be a double payment, so `buildReplacement` returns `null` until
  the previous attempt's last valid round has passed, and the pipeline keeps polling. That is
  the `after-expiry` form of C14.
- **Capability flags.** Dev mode has no mempool and no forks, so the flags and not-applicable
  scenarios of step 7 above.
- **A lookup limit.** algod answers a lookup by transaction id only while it still remembers
  the transaction, and a node that is not an archiver keeps only recent blocks; a validity
  window spans at most 1000 rounds. So before `buildReplacement` returns a fresh transaction,
  it must scan the old attempt's validity window for that attempt (it receives the previous
  attempt's body, and so its rounds): an attempt that confirmed but is reported `unknown` would
  otherwise be paid a second time. `getTxStatus` receives only an id; `docs/design.md` section
  12 weighs an indexer against passing it the stored body.
- **ed25519.** The `Curve` type and `LocalSigner` already have it; no chain uses it yet.

It is not built in v1.
