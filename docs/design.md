# Design

This document explains the choices in the chain adapter kit: what was decided, what the
alternatives were, and why. `docs/walkthrough.md` follows one withdrawal through the code
and is not repeated here; `docs/prior-art.md` compares the interface with existing
projects; the build spec and its numbered design calls are in `docs/superpowers/specs/`.
Measured numbers are in `docs/results.md` and `docs/adding-a-chain.md`, both produced by
scripts, and this document quotes none.

The kit runs against local test chains only (anvil with chain id 31337, Bitcoin Core in
regtest), with test keys only. It is not a custody product, and both adapters refuse to
start against any other network.

Code is referenced by file and function name. Test ids (C4, P8, F3, R16, B7, ...) are the
prefixes of test names in `test/` and `src/conformance/suite.ts`.

## 1. The two claims

1. **Adding a chain is implementing one interface and passing one test suite.** Nothing
   outside the adapter changes but a registry entry.
2. **A withdrawal is sent exactly once, even though every step of it can run more than
   once.**

The first is checked by the code's shape and by two suites. `ChainAdapter` in
`src/core/adapter.ts` is the whole contract; `src/pipeline/` names no chain (its one
chain-flavoured value is the asset id `'native'`, in which fees are booked); and
`src/chains.ts` maps chain names to adapter factories. `runConformanceSuite`
(`src/conformance/suite.ts`) runs against each devnet from `test/*.conformance.test.ts`,
and `runPipelineSuite` (`test/pipeline-suite.ts`) runs the same pipeline tests on each
chain. `docs/adding-a-chain.md` measures from git what Bitcoin, the second chain, took,
with every file it touched outside `src/adapters/bitcoin/` and why.

The second is checked by `scripts/fault-run.ts`, which kills worker processes at each
crash point and at random, injects duplicate requests, a drop, a reorg and a stuck fee,
grades every scenario by destination balances read from the chain, then reconciles, and
writes `docs/results.md`. The pipeline suite isolates one mechanism per test (P5, P7, P8,
F1 to F6), and `reconcile` (`src/pipeline/reconcile.ts`) checks the ledger against the
chain and against itself.

## 2. The adapter interface

Seven decisions shape `ChainAdapter`. All follow from one requirement: the pipeline must
be able to die at any line and carry on, without knowing which chain it drives.

### 2.1 Building and signing are separate

`buildTransfer` returns an `UnsignedTx`: an opaque `body`, and `signingPayloads`, the exact
bytes to sign, as lower-case hex without a prefix. The pipeline (`signTx` in
`src/pipeline/steps.ts`) passes each payload to `Signer.sign` under a key id and hands the
signatures to `attachSignatures`, which returns the final bytes. Neither the adapter nor
the pipeline sees a key.

Payloads are a list because chains differ: EVM has one per transaction, the keccak of the
serialised EIP-1559 transaction; Bitcoin has one BIP-143 digest per input, each committing
to that input's amount (`digests` in `src/adapters/bitcoin/adapter.ts`). The encoding is
fixed for every chain because a payload is the one encoded value the pipeline decodes.

Why: in a real platform the key lives in a separate system, an HSM, an MPC cluster or a
signing service, which signs a digest with a key it never exports and knows nothing of
EIP-1559 serialisation or sighashes. An adapter that signs (`signTransfer(intent,
privateKey)`) has to be taken apart the day the key leaves the process. Handing the
signer the whole transaction means every signer must understand every chain. Digests out
and signatures in is the shape a local test key and a remote signer can both serve. Its
cost, a signer that signs whatever digest it is given, is the subject of section 7.

### 2.2 The transaction id is known before broadcast

`attachSignatures` is pure and returns `{ txid, raw }` with the id computed locally: on
EVM the keccak of the signed bytes; on Bitcoin (P2WPKH) the double SHA-256 of the
transaction without its witness, fixed before anything is signed. C5 checks purity, C6
that the chain reports the same id, and both `broadcast` implementations throw if the node
names another one.

Why: the pipeline stores the id with the signed bytes before sending (3.1), and after a
crash the stored id is the question it asks the chain. An id learned from the node's
answer leaves nothing to ask about if the process dies before the answer. (On EVM the id
depends on the signature, so a signer with random nonces gives two ids for two signings;
harmless, since only stored bytes are sent.)

### 2.3 Broadcast is safe to repeat, and it classifies by lookup

`broadcast` returns `accepted`, `already_known`, or `rejected` with the node's text. It
throws when the node did not answer: a refused connection, a timeout, an HTTP error page,
or on EVM a JSON-RPC error with a non-2xx status, which is a proxy talking (`nodeAnswer` in
`src/adapters/evm/adapter.ts`). Bytes the node already has, in its mempool or in a block,
are `already_known`.

Both adapters look the transaction up by id before sending and again after any error
answer (`nodeHas` in each). The node has the id: `already_known`; it does not: `rejected`.
Neither reads the error text to decide, because the text does not say which case it is:

- On EVM, "nonce too low" answers both a resend of these exact bytes after they were mined
  and a different transaction reusing the nonce. One is success; the other means this
  attempt can never confirm.
- On Bitcoin, `-25 bad-txns-inputs-missingorspent` answers both a mined transaction whose
  outputs have since been spent and a real double spend (B4).
- The harmless case is worded differently by different nodes ("already known",
  "transaction already imported", "txn-already-in-mempool") and between versions.

`rejected` is not final either. The pipeline records it and keeps tracking the attempt,
because a node can refuse what it later accepts, for example once an empty wallet is
funded (F5).

### 2.4 Status describes the current canonical chain only

`getTxStatus` returns `unknown`, `pending`, or `confirmed` with the block, the
confirmation count, whether the transaction succeeded, and the fee the chain charged. It
keeps no memory: a transaction whose block was reorganised away reports `pending` or
`unknown`, never a stale `confirmed`. The caller detects a drop or a reorg by comparing
with what it stored last time (`seen_block` on `tx_attempts`). The alternative, an adapter
that reports "dropped" or "reorged" events, needs the adapter to remember what it saw,
which puts durable state in two places.

Each chain needed care to meet this. **EVM** reads the receipt, then the tip, and reports
`confirmed` only if the tip is at or above the receipt's block; a lower tip means a
rollback between the two reads. **Bitcoin** looks transactions up through the node's
transaction index, and the adapter refuses a node without a synced `-txindex`. The index
still returns a transaction whose block was reorganised out, with the stale block's hash
and 0 confirmations, and the node reports that block with -1. So for this adapter
confirmed means at least one confirmation; below that it asks the mempool and answers
`pending` or `unknown` (B5).

### 2.5 Inputs are reserved through an `InputStore` the adapter drives

Chains differ most in what a transaction consumes:

| Chain                   | A transfer consumes                     | Reserved through                        |
| ----------------------- | --------------------------------------- | --------------------------------------- |
| EVM                     | the sender's next nonce                 | a counter: `nextSequence`               |
| Bitcoin                 | specific unspent outputs                | a coin set: `freeCoins`, `reserveCoins` |
| expiry model (Algorand) | nothing; validity is a window of rounds | nothing; `reserveInputs` returns `{}`   |

The pipeline provides both primitives as one `InputStore` bound to its database
transaction (`pgInputStore` in `src/pipeline/input-store.ts`, over `chain_sequences` and
`chain_coins`), and the adapter uses the one it needs in two steps. `syncInputs` may read
the chain: EVM seeds the counter from the node's pending nonce, Bitcoin inserts the
address's confirmed coins from a UTXO-set scan. `reserveInputs` does no network I/O and
returns an opaque reservation, `{ nonce }` or `{ coins }`. The `reserve` handler calls the
first outside any transaction and the second inside the one that commits `RESERVED`, so
reservation and state change commit or roll back together. The no-I/O rule exists because
`reserveInputs` holds row locks, and a network call would hold them for a round trip.

The alternative was a declared model (`'nonce' | 'utxo' | 'none'`) with the pipeline doing
the reservation. That moves chain knowledge into the pipeline: coin selection (here,
largest first until they cover the amount and the fee for that many inputs), what a fee
depends on, what is dust; and a fourth model is a pipeline change. With an `InputStore` the
pipeline has no per-model branch, and the suite tests reservations against
`MemoryInputStore`, without a database (C13). Opaque values are JSON with bigints as
decimal strings, handed back unchanged; since the pipeline uses `null` for "not set yet",
an adapter with nothing to reserve returns `{}`.

### 2.6 One rule for replacements

`buildReplacement(intent, reservation, previous)` returns a transaction that can never
confirm together with the previous attempt, or `null` when none can exist yet. The
pipeline relies on one sentence, "at most one attempt of a withdrawal can ever confirm",
and leaves how it holds to the chain:

| Chain        | Why both cannot confirm      | The replacement                                             |
| ------------ | ---------------------------- | ----------------------------------------------------------- |
| EVM          | same nonce                   | same body; both fee fields up an eighth, and to the quote   |
| Bitcoin      | same inputs (BIP-125)        | same coins and payment; the change pays a higher rate       |
| expiry model | the previous one has expired | `null` until its last valid round; then a fresh transaction |

Both conflict-rule adapters build from the previous attempt's stored body, not from the
arguments: EVM takes the nonce and every other field from it; Bitcoin decodes the coins
and payment from it and throws if the reservation or intent it was given differs (B13).
The rule then cannot depend on the caller passing the right reservation. The eighth is
because geth requires a 10% raise on both fee fields while anvil accepts any increase. On
Bitcoin the rate rises by at least an eighth and 1 sat/vB, and to at least the quote; only
the change pays, and with none left `buildReplacement` throws rather than repeat the
transaction (B6, B14).

In the expiry model the risk moves to the replacement: signing a second transaction while
the first can still be included is a double payment. So the adapter returns `null` until
the first one's last valid round has passed, and the pipeline keeps polling (`replace`
returns false). No expiry-model adapter exists yet; the spec moved from Solana, whose
local validator does not run on linux/arm64 from official artifacts, to Algorand (see
section 12).

### 2.7 Why Bitcoin recovers the public key from the signature

A P2WPKH witness holds a signature and the public key, but `attachSignatures(unsigned,
signatures)` receives no key, and the body names only the sender's address, a hash of the
key. Three ways to get the key there:

1. Add it to the interface. Every chain pays for one chain's need.
2. Put it in the body. `buildTransfer` receives an address, not a key, so the key would
   have to reach it some other way.
3. Recover it from the signature. The `Signer` contract already returns r, s and a
   recovery id, because EVM needs the recovery id as `yParity`.

The adapter does the third, and checks that the recovered key's hash160 is the input
owner's key hash. A signature from the wrong key then fails in `attachSignatures`, before
anything is stored, not as a rejection from the node (B7). Both adapters refuse a recovery
id other than 0 or 1; on EVM a signer using the 27/28 convention would otherwise sign as
another address, since viem reads any non-zero value as 1.

## 3. The withdrawal state machine

```
submitWithdrawal ──> REJECTED                 (policy or insufficient funds; no hold)
        │
        ├─> AWAITING_APPROVAL ──> REJECTED    (an approver rejects; hold released)
        │           │
        v           v
      APPROVED ─> RESERVED ─> SIGNED ─> BROADCAST ─> SETTLED
                                ^           │   └──> FAILED (confirmed but reverted)
                                └───────────┘
                             replacement stored
```

| State               | Meaning                                                          | Durable                          |
| ------------------- | ---------------------------------------------------------------- | -------------------------------- |
| `REJECTED`          | terminal; refused before any on-chain action                     | the reason                       |
| `AWAITING_APPROVAL` | hold placed; needs M approvals                                   | the hold                         |
| `APPROVED`          | ready for a worker                                               | the hold                         |
| `RESERVED`          | nonce or coins assigned                                          | hold, reservation, fee quote     |
| `SIGNED`            | latest attempt stored; no broadcast of it recorded               | the attempt: `raw`, `txid`, body |
| `BROADCAST`         | a broadcast of the latest attempt recorded; tracking to finality | attempts, the block last seen    |
| `SETTLED`           | terminal; one attempt final and succeeded                        | `settled_txid`, settlement       |
| `FAILED`            | terminal; one attempt final and reverted                         | hold released, fee booked        |

Each arrow is one database transaction that changes the state through a compare-and-swap
and writes the data that goes with it, or it does not happen. Between arrows a worker talks
to the chain and the signer, and those calls can repeat. `submitWithdrawal` and
`decideApproval` (`src/pipeline/requests.ts`) own the first three states; the worker's
`handlers` (`src/pipeline/steps.ts`) own the rest.

### 3.1 Why store before broadcast

A worker signs, records and sends. Three orders, compared by what a crash between the send
and the record leaves behind:

| Order                                | The database then holds | The next worker                                                                         |
| ------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------- |
| send, then record                    | "not sent"              | signs and sends again; with a fresh nonce from the node, or other coins, pays twice     |
| record an intent, then send          | "maybe sent", no id     | searches the chain for something that looks like it: slow, ambiguous for equal payments |
| store signed bytes and id, then send | the bytes and the id    | asks the chain about the id; if missing, sends the same bytes: the same transaction     |

The third is used, as two transactions around one network call. `sign` commits the attempt
(`raw`, `txid`, the unsigned body, the fee) in the transaction that moves the withdrawal to
`SIGNED`. `broadcast` reads the latest attempt back from `tx_attempts`, asks the chain
about its id, sends only if the chain lacks it, then moves to `BROADCAST`. A kill after the
send and before the record (`after_broadcast`) leaves `SIGNED`, and the next worker finds
the id on the chain and records the broadcast without sending (P8). If the first send is
only slow to appear, sending the same bytes again is still one transaction.

### 3.2 Where exactly-once actually comes from

The pipeline is at-least-once: any handler may run again after a crash or a lost lease,
and nothing makes a network call and a commit atomic. The exactly-once effect comes from
the chain's de-duplication: a nonce is used once, an output is spent once, the same bytes
are the same transaction. The pipeline's job is narrower than "never repeat a step": make
every repeat present the same key to the chain. Five rules do it:

1. Only stored attempts are broadcast: `broadcast` and `track` send `raw` read from
   `tx_attempts`.
2. Every attempt descends from the withdrawal's one reservation: the first is built from
   it, each replacement from the previous attempt (expiry model: only once that is dead).
3. A reservation belongs to one withdrawal. It is taken under row locks in the
   transaction that commits `RESERVED`, and a rollback hands it back.
4. A request maps to one withdrawal through the unique `(user_id, idempotency_key)`. A
   replay with the same parameters returns the stored withdrawal, rejection included; one
   with other parameters throws `IdempotencyKeyReuse` (R2, R8, R9).
5. Ledger postings happen in the transaction of the state change that causes them, under
   a unique reference (section 5).

`track` watches rule 2 from the outside: if two attempts of one withdrawal ever confirm, it
throws on every run and never settles, and reconciliation reports `one_confirmed_attempt`.

### 3.3 Leases are for efficiency, not for safety

`claim` (`src/pipeline/worker.ts`) takes one due row in a single statement, `for update
skip locked`, and sets a lease; until it expires, other workers pass the row over (P7). The
classic failure of lease-based systems is a worker that pauses (garbage collection, a
stalled disk, a suspended VM, a slow signer), loses its lease without knowing, and carries
on while another worker does the same step. The usual cure is a fencing token, which works
only if the resource checks it, and a blockchain node does not.

Here a paused worker is harmless wherever it wakes. In `reserve` or `sign` its
compare-and-swap matches no row: `LostRace`, a rollback that returns its nonce or coins,
and signatures dropped unsent (P5). In `broadcast` or `track` it can send only stored
bytes, which conflict with anything else sent for the withdrawal, and any state change it
attempts goes through a compare-and-swap that one worker wins (in `broadcast`, plus the
latest-attempt check of 3.4). Its release matches only its own `lease_owner`. Clocks
decide when work happens, never whether it is safe, and they are all the database's
`now()`.

### 3.4 Compare-and-swap first, then the unique insert

Every state change goes through `transition` (`src/pipeline/steps.ts`): `update
withdrawals ... where id = $1 and state = $from`, plus a `state` event. It comes first in
its transaction, so a second worker on the same withdrawal waits on the row lock, matches
no row and throws `LostRace`, which `runOnce` releases without recording an error.

With the insert first, the loser would hit the unique indexes of `tx_attempts`, and a
conflict on the unique `txid` is how the schema catches a real fault: two withdrawals
that produced the same bytes, so shared a reservation. With the compare-and-swap first, a
race never reaches the insert, so a `txid` violation always means a fault; `storeAttempt`
does not target it, and it is recorded as an error, never taken for a race (the
duplicate-txid test). `reserve` is the one exception, since the reservation is what its
transition saves; its loser's rollback hands the nonce or coins back.

`broadcast` needs one more check, because the state does not say which attempt was sent. A
slow worker holding attempt N can reach its transition after a replacement stored N+1 and
moved the state back to `SIGNED`. Its update of `broadcast_at` matches only if N is still
the highest attempt; otherwise it throws `LostRace` and the transition rolls back with it.

### 3.5 Tracking: drop, reorg, stuck

`track` asks the chain about every attempt on every run. More than one confirmed: it
throws and settles nothing. An attempt seen in a block and not confirmed now was
reorganised out: it clears `seen_block` (`reorged_out` event). Exactly one confirmed: it
records the block (a new hash is a reorg that kept the transaction, a `reorg` event), and
settles or fails at `finalityDepth` confirmations. None confirmed and the latest
`unknown`: dropped, evicted or reorganised out and forgotten, so it sends the same stored
bytes again. None confirmed and the latest stored more than `stuckAfterMs` ago, with fewer
than `maxAttempts` attempts: `replace` builds, signs and stores the next attempt and moves
the state back to `SIGNED`, and `broadcast` sends it with the same code and crash recovery
as a first send.

Stuck looks different on the two nodes. Anvil evicts a pending transaction priced below a
newly mined block's base fee and then refuses it at send: `unknown`, re-send rejected,
replaced. Bitcoin Core keeps an underpriced transaction in its mempool (`stuckEvicts:
false` in its `PipelineEnv`): `pending`, replaced. Reorgs differ too: anvil forgets the
replaced blocks' transactions, Bitcoin Core puts them back in its mempool. The pipeline
needs to know none of it. `unknown` leads to a re-send, age to a replacement, and every
path ends with one confirmed attempt.

### 3.6 Confirmed but reverted

An EVM transaction can be included and still fail, for example a token transfer that
reverts; the nonce is consumed and the fee paid. `settle` ends the withdrawal `FAILED`,
books the fee and releases the hold to the user (F4; a real revert in
`test/evm.pipeline.test.ts`). Retrying is left to a person: an automatic retry of a revert
pays fees in a loop while the cause persists. A Bitcoin transaction in a block cannot
fail, so that adapter always reports success.

### 3.7 What a handler failure does

A handler that throws leaves the state alone; whatever it had open rolls back. `runOnce`
records the message in `last_error`, increments `error_count`, and pushes `next_run_at`
out by `retryBaseMs` doubled per failure, up to 2^6 times. An exception never produces a
terminal state: the only ways to `REJECTED`, `SETTLED` and `FAILED` are a policy outcome,
an approver's rejection, or one attempt at finality depth. An unreachable node delays a
withdrawal and never ends it (P6), and so does an empty hot wallet (F5): on EVM its send is
rejected and re-sent each poll, on Bitcoin `reserveInputs` finds no coin and throws.

## 4. Nonce management trade-offs

Choosing the nonce for a hot wallet that several workers use:

| Option                    | How                                          | Cost                                                                                                                           |
| ------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| ask the node at send time | `eth_getTransactionCount(pending)`           | two workers get one number; nodes behind a load balancer disagree; a crash leaves it unknown whether the number was used       |
| one writer per address    | one process owns the address                 | simple; one build in flight per address; failover needs leader election, and a paused leader is the paused lease holder of 3.3 |
| counter in the database   | `nextSequence` in the `RESERVED` transaction | used here; a reserved nonce must be used; reserves on one address queue on its row                                             |
| several hot addresses     | N addresses, a counter each                  | more parallelism; more addresses to fund, refill and reconcile, and a rule to pick one                                         |

The counter row is updated, and so locked, in the transaction that commits `RESERVED`.
Concurrent reserves for the address queue behind it and get consecutive numbers (I3); a
rollback undoes the increment and the number goes to the next reserve (I4); a worker that
dies after the commit leaves the number on the withdrawal row for the next worker. The
counter is seeded once from the node's pending count, since `seedSequence` inserts only if
absent (I5).

The rule that comes with a counter: **a reserved nonce must be used.** A gap stalls every
later transaction from the address, so there is no cancel after `RESERVED`. A system that
needs one fills the nonce with a zero-value transfer to self at a higher fee, which is a
replacement under the same rule (2.6). Two more consequences:

- **Head-of-line blocking.** If nonce 7 is stuck on a low fee, 8 and 9 wait behind it
  whatever they pay, and only replacing 7 helps; that is why a bump replaces by the same
  nonce. The pipeline judges staleness per withdrawal, so 8 and 9 get bumped too once old
  enough, for nothing.
- **The counter assumes the key is used nowhere else.** A transaction sent from the hot
  address by anything else desynchronises it. The kit does not repair that;
  reconciliation shows it as drift.

The UTXO counterpart is coin reservation: the transaction that changes the state marks
specific coins with the withdrawal's id (`reserved_by`). `reserveCoins` is one statement
that locks the wanted rows and updates them only if every id matched, so a failed call
reserves nothing even if the caller catches the error (I7b), and duplicate ids fail the
count. Its failure modes differ from a counter's: fragmentation (the fee grows with the
inputs); unconfirmed change (`syncInputs` adds confirmed coins only, so change cannot fund
the next withdrawal until mined, and throughput is bounded by spendable coins, which is
why the pipeline tests fund the Bitcoin hot wallet in many coins); and coins a reorg takes
away (section 12). Platforms consolidate and pre-split coins; the kit does neither. The
expiry model reserves nothing, and its whole risk sits in the replacement (2.6).

## 5. Ledger and reconciliation

The ledger is double entry in three tables (`migrations/001_init.sql`): `ledger_accounts`
with a `balance` and `check (balance >= 0)`, `ledger_txs` with a unique `ref`, and
`ledger_entries`. `post` (`src/pipeline/ledger.ts`) validates a posting before its first
write, then updates balances and writes lines inside the caller's transaction.

| Account                 | Normal side | Meaning                                         |
| ----------------------- | ----------- | ----------------------------------------------- |
| `custody`               | debit       | what the hot address holds on-chain             |
| `user:<id>`             | credit      | what the platform owes a user                   |
| `withdrawals_in_flight` | credit      | held for withdrawals that are not terminal      |
| `network_fees`          | debit       | fees paid to the network                        |
| `platform`              | credit      | the platform's own funds, such as the gas float |

Names end in `<chain>:<asset>`. A token withdrawal moves its amount in the token's
accounts and its fee in the native asset's, so each asset balances alone. The platform
pays every network fee; there is no user-facing fee.

**Why the database and not an `if`.** With the balance on the row, a concurrent update
waits for the first and sees its result, and the check constraint refuses an overdraft
when it would happen, from any code path (L4, L5). An `if (balance >= amount)` reads a
value another transaction can change before the write, and every path that moves money,
including future ones, must remember to lock first. The request path does lock (section
6), but the constraint is what makes an overdraft impossible.

**Idempotent by reference.** `post` inserts the `ledger_txs` row with `on conflict (ref) do
nothing`; a second transaction with the same `ref` waits for the first to commit, gets no
row and changes nothing (L3, L5b). The references are `hold:<id>`, `release:<id>`,
`fee:<id>` and `settle:<id>`. In `settle` an already-used reference is impossible after a
successful transition, so there it throws instead of passing silently.

**The fee is posted before the amount.** Within one posting, balances are updated in
account-name order, so two postings on the same accounts cannot deadlock (L5c). Across
postings in one transaction the order is a convention. `settle` posts the fee first so that
every settle or fail transaction locks native `custody` before any other account; with the
amount first, a native `FAILED` (user, in-flight, custody) and a native `SETTLED` (custody,
in-flight) finishing together could deadlock. `lockAccount` holds one account's row lock
for the rest of a transaction, with a rule: call it before any posting, then post only to
accounts that sort at or after it. The request path locks `user:...`, then posts to
`user:...` and `withdrawals_in_flight:...`.

**What reconciliation compares.** `reconcile` reads in one repeatable-read snapshot the
`custody` balances, the attempts of `SIGNED` and `BROADCAST` withdrawals and the ledger's
self-checks, then asks the chain for those attempts' status and the hot address's
balances. Per chain and asset, `ledger` is `custody`, `onchain` the hot address's balance,
and `explained` what the chain has done that the ledger posts only at finality: for each
confirmed attempt of an unsettled withdrawal, minus its amount if it succeeded and minus
its fee in native (Q2, Q6, Q12). `drift = onchain - ledger - explained`. Computing that
window instead of waiting it out lets reconciliation run at any time.

**Why drift must be exactly zero.** Amounts are integers in the smallest unit, and the fee
booked is the chain's own `feePaid`, not the quote, so a correct system has nothing to
round; a tolerance would be a leak of that size that no run could see. One caveat, stated
in `reconcile`: its chain reads are not pinned to its snapshot, so a transfer confirming
in between shows as drift once, and a failure is confirmed by a second run.

**The checks** besides drift: `debits_equal_credits`, `balances_match_journal` (Q4),
`in_flight_matches_withdrawals` (Q5), `custody_covered` (a non-zero `custody` account no
requested row covers, so a run that forgot an asset cannot pass by checking nothing, Q10)
and `one_confirmed_attempt` (Q8).

## 6. Policy and approvals

`submitWithdrawal` is one transaction. It inserts the withdrawal with `on conflict
(user_id, idempotency_key) do nothing`, so a replay waits for the first insert and returns
what it stored. A new request then locks the user's ledger account for the asset
(`lockAccount`). That lock serialises one user's requests for the asset, so the rolling
24-hour limit (the user's other non-rejected withdrawals of the asset in the last 24
hours, by the database clock) cannot be beaten by two racing requests (R15, R19). The
checks run in order and the first failure is the recorded reason: address format,
allowlist, per-withdrawal limit, 24-hour limit (`checkRequest` in
`src/pipeline/policy.ts`).

**The hold comes before approvals.** It is posted in the same transaction, in a savepoint,
so an overdraft becomes the recorded rejection `insufficient_funds` instead of aborting the
transaction. A withdrawal waiting for approvers has already reduced what the user can
spend; otherwise one balance could be requested twice and both approved.

**M-of-N.** Approvals are keyed by `(withdrawal_id, approver_id)`, so M counts distinct
approvers (R11). Only listed approvers decide, never the requester (R13). The count runs
again on a repeated approve, so a corrected policy takes effect (R17), and a decision on a
withdrawal that has left `AWAITING_APPROVAL` changes nothing (R14).

**A reject always vetoes,** even from an approver who approved earlier: the insert turns
that `approve` into `reject`, the hold is released, and the withdrawal ends `REJECTED`
(R16, R21b). Ignoring it would drop a veto silently, and every held withdrawal needs a way
out inside the system, since approvals never expire.

**Errors throw; outcomes are recorded.** An amount of zero or less, a policy whose M is
outside 1 to N, or a policy lookup that throws (`deps.policy`, for an asset with no policy)
is a caller or configuration error: `submitWithdrawal` throws before touching the database,
and the key is not consumed (R20, R21). A policy outcome (not allowlisted, over a limit,
short of funds) is a `REJECTED` row, returned again on every replay (R8). The line: could
the same request ever succeed if retried?

**What a real policy engine adds:** velocity rules across assets in a common currency,
address screening, a time lock for new allowlist entries, quorums that grow with the
amount, approval expiry, and policy checked again inside the signer.

## 7. The signer plug point

```ts
export interface Signer {
  publicKey(keyId: string, curve: Curve): Promise<Uint8Array>; // 33-byte compressed secp256k1, or 32-byte ed25519
  sign(keyId: string, curve: Curve, payload: Uint8Array): Promise<Uint8Array>;
  // secp256k1: payload is a 32-byte digest; returns 65 bytes r || s || recovery id
  // ed25519:   payload is the message;       returns 64 bytes
}
```

`LocalSigner` (`src/core/local-signer.ts`) derives each test key from a random run-time
seed and the key id, and stores none. The pipeline asks for a public key once per chain at
start-up, in `hotWallet` (`src/pipeline/worker.ts`, key id `hot:<chain>`), and signs in
`signTx`. The signer is built in one place, `buildRuntime` in `src/pipeline/runtime.ts`.

An HSM or MPC signer implements the same two methods. What changes:

- **Latency.** Signing becomes a network call that can take seconds or need a quorum.
  `sign` and `replace` call the signer before their transaction opens, so a slow signer
  holds no lock, and a failing one is a handler error retried with backoff.
- **Repeat signing is safe.** If a worker dies after the signer answers and before the
  attempt is stored, the next worker signs again. Nothing was sent, both signatures cover
  the same reservation, and only the stored one is ever sent.
- **The signer should decode and check the transaction itself.** A digest-only signer signs
  whatever it is handed, so a compromised pipeline can sign anything. A production signer
  receives the unsigned transaction and the withdrawal it serves, decodes the transaction
  with its own code, checks destination, amount and fee cap against the approved request,
  and computes the digest itself. That widens `sign` with a context argument, and it is the
  first change to make.
- **The output format is part of the contract.** Services usually return `(r, s)` or DER
  without a recovery id. The contract is 65 bytes with a recovery id of 0 or 1, and EVM
  accepts only low-S signatures; the Bitcoin adapter normalises S itself, the EVM adapter
  does not. The signer class does both.

Where a remote signer would go (a sketch, not in the repo):

```ts
// src/core/remote-signer.ts
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, concatBytes } from '@noble/curves/utils.js';
import type { Curve } from './adapter.js';
import type { Signer } from './signer.js';

/** The key service's own API: keys it never exports, signatures over digests. */
export interface KeyService {
  publicKey(keyRef: string): Promise<Uint8Array>; // 33-byte compressed
  signDigest(keyRef: string, digest: Uint8Array): Promise<{ r: bigint; s: bigint }>;
}

export class RemoteSigner implements Signer {
  constructor(
    private readonly service: KeyService,
    private readonly keyRef: (keyId: string) => string, // 'hot:evm-anvil' -> the service's name
  ) {}

  async publicKey(keyId: string, curve: Curve): Promise<Uint8Array> {
    if (curve !== 'secp256k1') throw new Error(`this service holds no ${curve} keys`);
    return this.service.publicKey(this.keyRef(keyId));
  }

  async sign(keyId: string, curve: Curve, digest: Uint8Array): Promise<Uint8Array> {
    const expected = bytesToHex(await this.publicKey(keyId, curve));
    const { r, s } = await this.service.signDigest(this.keyRef(keyId), digest);
    let sig = new secp256k1.Signature(r, s);
    if (sig.hasHighS()) sig = new secp256k1.Signature(r, secp256k1.Point.Fn.ORDER - s);
    // the contract wants the recovery id: the one that recovers this key
    for (const recovery of [0, 1]) {
      const key = sig.addRecoveryBit(recovery).recoverPublicKey(digest).toBytes(true);
      if (bytesToHex(key) === expected) {
        return concatBytes(sig.toBytes('compact'), Uint8Array.of(recovery));
      }
    }
    throw new Error(`the signature for ${keyId} was not made by its key`);
  }
}
```

`buildRuntime` would construct it instead of `LocalSigner.fromHex`; nothing else changes.

## 8. Hot, warm and cold

Not built. Where the tiers would sit:

- **Hot** is what this pipeline drives: keys online, a small float, automated, limited by
  policy. Its size comes from observed outflow, say a day of withdrawals at a high
  percentile, so a compromise loses a bounded amount.
- **Warm** refills hot: keys in an HSM or MPC cluster, a stricter policy, a human quorum.
- **Cold** holds the rest offline; movements are manual, rare and multi-party.

A warm-to-hot refill is just another withdrawal: the hot address as destination, a policy
with its own approvers and quorum, another key id served by another `Signer`. It runs
through the same state machine and inherits the exactly-once argument. What differs is the
ledger: a refill owes no user, so it moves funds from the warm tier's custody account to
the hot tier's, with the fee to `network_fees`. That needs `custody` split per tier
(`custody:hot:<chain>:<asset>`, ...), each tier reconciled against its own addresses
(today `reconcile` reads one hot address per chain), and "explained" counting incoming
refills as well as outgoing transfers.

## 9. How the claims are tested

**The conformance suite.** `runConformanceSuite(name, makeHarness)` defines sixteen
checks that each adapter's test file runs against its devnet, broadcasting real
transactions: addresses, balances, ids, fees, repeated broadcast, status, drop, reorg,
reservations, replacement and block scan (C1 to C15), and the devnet's own `pendingFrom`,
which the fault run's grading relies on (C16). The harness (`src/conformance/harness.ts`)
supplies the adapter, a signer, assets, sample addresses and a `Devnet` that funds,
mines, drops and reorgs. It also declares the one thing the suite cannot discover, the
replacement rule (`replacement: 'conflict' | 'after-expiry'`). The after-expiry form of
C14 is to be written with the first chain that needs it, and until then C14 skips for such
a harness; EVM and Bitcoin both declare `'conflict'` and run all sixteen. Where a node
cannot produce a condition, its devnet emulates it rather than the suite skipping it:
Bitcoin Core cannot remove one transaction from its mempool, so `dropFromMempool` moves
the node's clock past the mempool expiry and resubmits the rest.

**The pipeline suite.** `runPipelineSuite(makeEnv)` runs P1 to P8 and F1 to F6 with
in-process workers on each chain's `PipelineEnv` (`scripts/lib/env.ts`). The env states
how its node behaves under a fault (`stuckEvicts`, for one) so each test asserts the path
its chain must take, and each chain's file adds what only it can check, such as distinct
nonces or coin sets for P4.

**The fault run.** `scripts/fault-run.ts` gives each scenario a fresh schema, seed and
funded hot wallet (`openSandbox` in `scripts/lib/sandbox.ts`) and runs the pipeline in
separate worker processes (`scripts/worker-main.ts`) under a supervisor
(`scripts/lib/supervisor.ts`) that replaces any worker that dies.

- **At each crash point.** `src/pipeline/crash.ts` names nine, from `after_reserve` to
  `after_replacement_store`. A worker started with one records a `crash_injected` event in
  its own autocommit statement and sends itself SIGKILL. No cleanup runs and the server
  rolls back what was open, whereas an exception would run `catch` blocks and `runOnce`'s
  error path. Each withdrawal dies once at the point; the kills must match the events.
- **At random.** Several workers, no crash point; the supervisor SIGKILLs a random worker
  at random intervals. A kill that leaves a lease in the dead worker's name interrupted a
  handler, and the scenario requires a minimum number of those.
- **Duplicate requests, dropped, reorg, stuck.** Each fault is made while no worker runs,
  so nothing races the reaction, and each scenario checks that its fault happened and was
  handled the intended way (a `rebroadcast` per dropped withdrawal; no first attempt
  confirmed after a stuck fee).

Grading reads the chain, so the system under test does not grade itself. Each withdrawal
goes to a fresh address, so a destination's balance is exactly what the pipeline sent it.
`grade` (`scripts/lib/scenarios.ts`) first mines `finalityDepth + 1` blocks and requires
that the node holds nothing more from the hot address, since a held transaction (behind a
nonce gap, say) could move money after the reading. `verifyAgainstChain`
(`src/pipeline/verify.ts`) counts more than the amount at a destination, or anything at a
`REJECTED` or `FAILED` one, as sent twice; less than the amount at a `SETTLED` one as lost;
anything non-terminal as unfinished. Then `reconcile` runs.

The property: every accepted request ends in exactly one on-chain transfer or a clean
rejection, and the ledger shows no drift. Scenarios reach the chain only through a
`PipelineEnv`, so a chain joins the fault run with an env, not new scenarios; a scenario a
chain cannot produce is listed as not applicable, with the reason, never dropped.
`docs/results.md` is written only by a full run in which every scenario passed on an
unchanged checkout, and names the commit, command, chain and node.

## 10. What changes at scale

- **Per-chain queues.** `claim` takes any due withdrawal of any chain, so a slow node ties
  up workers others need, and a worker whose `KIT_CHAINS` leaves a chain out still claims
  that chain's withdrawals, fails on the missing runtime and pushes them into backoff. A
  worker pool per chain and a claim filtered by chain fix both.
- **Wake-ups instead of polling.** An idle worker sleeps `pollMs` between claims;
  `LISTEN/NOTIFY` on inserts and state changes, or a queue, would wake it when a row is due.
- **Batching.** Many outputs in one Bitcoin transaction, or a multi-send contract on EVM. A
  batch is one attempt serving many withdrawals, so `tx_attempts` would belong to a batch,
  and the reservation, the states from `RESERVED` on and the one-confirms rule would move
  to it. The fee needs an allocation rule, and on EVM one revert fails the whole batch.
- **Fee markets.** Today one rule bumps by an eighth (or to the quote) whenever an attempt
  is older than `stuckAfterMs`. At scale: fee caps per asset, an escalation schedule from
  the first broadcast, urgency classes, bumps only for the lowest stuck nonce on EVM, and
  `estimatesmartfee` instead of a fixed Bitcoin rate.
- **More than one node.** A lagging node delays settlement; a lying one makes the pipeline
  settle a transfer that never happened. Status would need several nodes to agree before
  settling, and broadcasts would go to several.
- **Several hot addresses per chain**, for nonce parallelism and coin supply. Counters are
  keyed per address and coins carry their owner; missing is a rule to pick the address.
- **Table growth.** Events, attempts, ledger entries and spent coins only accumulate, and
  terminal rows would move to history tables. The partial index `withdrawals_due` covers
  only non-terminal states, so the claim stays small regardless.

## 11. What a time-to-broadcast target would need

Say the target is "p99 from approval to first accepted broadcast under N seconds".

**Where the time goes.** Each step is its own claim: after `reserve`, `sign` and
`broadcast` the worker releases the row and claims again, perhaps another row, though the
withdrawal keeps its old `next_run_at` and stays near the front. In order: waiting to be
claimed (up to `pollMs` when idle, more when busy); the fee quote and `syncInputs` (a node
call on EVM, a UTXO-set scan on Bitcoin that the node serves one caller at a time); the
reserve transaction; building and one signer call per payload; the store transaction; the
pipeline's status lookup, the adapter's own lookup, and the send; the record transaction.

**How it would be measured.** Every worker state change writes a `state` event, and the
broadcast step writes `broadcast` with `sent` and `outcome`, timestamped by the database.
For a withdrawal approved at once the start is `withdrawals.created_at`:

```sql
select percentile_cont(0.99) within group (order by b.first_sent - w.created_at) as p99
  from withdrawals w
  join lateral (
    select min(e.created_at) as first_sent from withdrawal_events e
     where e.withdrawal_id = w.id and e.kind = 'broadcast'
       and e.data->>'outcome' in ('accepted', 'already_known')) b on b.first_sent is not null
 where w.created_at > now() - interval '1 day';
```

Gaps between consecutive `state` events split the time by step. One hole needs closing
first: the request path writes no events, so approval exists only as the last approver's
`approvals.created_at`, and `decideApproval` would write an event on `APPROVED`. Note too
that an event's `created_at` is the start of its transaction, after the network calls
before it.

**What would have to change:** wake-ups instead of polling, and one claim running
`reserve`, `sign` and `broadcast` back to back (safe, since no step relies on the lease); a
latency budget and an alert for the signer; fee quotes cached briefly, and Bitcoin coins
tracked from the kit's own transactions and block scans instead of a scan per
reservation; one status lookup before the send instead of two; and worker pools sized per
chain from the arrival rate, shedding visibly when the signer or a node is slow rather
than letting the queue age silently.

## 12. Known trade-offs in the code

- **Age counts from when an attempt was stored**, not last sent, so an attempt dropped and
  re-sent can be replaced at once: safe, since the two conflict, but it pays more sooner.
- **A rejected re-send repeats every poll, without backoff,** noisy while a wallet is
  empty or a withdrawal waits at `maxAttempts`; the reason lives in `last_error`. At
  `maxAttempts` a withdrawal waits, re-sending its latest attempt, and nothing alerts.
- **Every poll asks about every attempt,** so the cost grows with attempts times
  withdrawals in flight.
- **The nonce counter is seeded once,** though `syncInputs` asks the node for the pending
  count on every reserve. Another sender on the hot address breaks it, and shows as drift.
- **Bitcoin reserves on one address serialise.** `freeCoins` locks every free coin of the
  address for the reserve transaction, not only those it picks, so a concurrent reserve
  finds no coin, throws and backs off. Safe and brief, since the transaction does no
  network I/O, but concurrency becomes retries.
- **Reserved coins are never released,** and spent coins stay in `chain_coins`. A stored
  coin that a reorg takes away stays too; its withdrawal is refused on every re-send and
  its replacements spend the same coins, so it waits until the coin is mined again or an
  operator steps in. No money moves.
- **A Bitcoin bump needs change.** With none left, `buildReplacement` throws and the
  withdrawal waits on its previous attempt; child-pays-for-parent would need change too.
- **Bitcoin quotes a fixed rate,** because `estimatesmartfee` has no data on regtest, and
  scans the UTXO set for balances and coins, which the node serves one caller at a time.
- **Fees are booked in `'native'`.** Fee sponsorship, or fees in another asset, would
  change `settle` and `reconcile`.
- **Lock order is a convention** (sorted names, fee first, `lockAccount` before posting).
  A path that breaks it deadlocks, and Postgres aborts one side: visible, not prevented.
- **A `FAILED` withdrawal counts toward the 24-hour limit,** since the window sums every
  non-rejected withdrawal, though its hold was released. Conservative.
- **Approvals never expire;** a withdrawal holds its funds in `AWAITING_APPROVAL` until
  someone rejects it.
- **`killOnce` assumes one worker per withdrawal;** two at the same crash point could both
  insert the event. Test-only, and the fault run respects it.
- **An Algorand adapter would face a lookup limit.** `getTxStatus` receives only an id,
  and algod answers a lookup by id only while it remembers the transaction (in its pool or
  recently confirmed); after that, the answer looks like `unknown`. In the expiry model
  that is dangerous: a confirmed attempt reported `unknown` after its last valid round
  would let `buildReplacement` issue a fresh transaction, a second payment. The adapter
  needs a lookup that does not forget: the indexer, or a scan of the attempt's validity
  window (at most 1000 rounds), which an id alone does not give. Either an indexer
  dependency, or a `getTxStatus` that also receives the stored body.
- **A deposit scanner (not built) would face two traps.** `scanBlock` reports every output
  that pays an address, coinbase included, with no coinbase marker, and a coinbase output
  cannot be spent for 100 blocks, far beyond a usual `finalityDepth`. And deposits must be
  keyed on `(chain, txid, index, asset)`: on EVM a native transfer has index 0, and a token
  `Transfer` log in the same transaction can have log index 0 too.

## 13. What it does not do

- Custody of real funds. Local test chains only; adapters and devnets refuse anything else.
- Key management: ceremonies, backup, rotation, a real HSM or MPC signer.
- A third chain, and so the after-expiry form of C14.
- A deposit scanner; `scanBlock` exists and passes C15, but nothing consumes it.
- Sweeping deposits to the hot wallet, UTXO consolidation, batching.
- Cancelling a withdrawal once its nonce or coins are reserved.
- An HTTP API, authentication, users, a UI. `submitWithdrawal` and `decideApproval` are
  what such a handler would call.
- Deposits made by contract-internal transfers on EVM (that needs tracing), and tokens
  with unusual behaviour (fee on transfer, rebasing).
- Protection against a reorg deeper than `finalityDepth`: nothing re-checks a `SETTLED`
  withdrawal, and the loss would surface as drift.
- Alerting, operator tooling, more than one node per chain.
- Protection against someone with write access to the database.
