# Walkthrough: one withdrawal, crash point by crash point

A guided read of one withdrawal through the code, about 30 minutes with the repo open
beside it. It follows a single request from `submitWithdrawal` to `SETTLED` and stops at
every place where a worker can die. The design doc carries the wider reasoning and the
trade-offs; this document stays on the path of one withdrawal. The kit is a reference
that runs against local test chains only. It is not a custody product.

Code is referenced by file and function name. Test ids (R2, P8, F3, X1, ...) are the
prefixes of the test names, so `grep -rn "'P8 " test/` finds one.

## What you will follow

A user with a credited native balance asks to withdraw an amount of native ETH on the
local anvil chain (chain id 31337) to an address on their allowlist, below the approval
threshold. `submitWithdrawal` accepts it as `APPROVED`; a worker takes it through
`RESERVED`, `SIGNED` and `BROADCAST` to `SETTLED`. Then the same withdrawal is killed at
each of the nine crash points in `src/pipeline/crash.ts`, and inside open transactions.

## The tables you need

All in `migrations/001_init.sql`.

- `withdrawals`: one row for this withdrawal. The request, `state`, `reject_reason`;
  from `RESERVED` on, the `fee` quote and the `reservation` as `jsonb` (on EVM the nonce
  and the address it was reserved for, `{"nonce": "...", "from": "0x..."}`);
  `settled_txid` at the end; and the worker's bookkeeping: `lease_owner`,
  `lease_expires_at`, `next_run_at`, `error_count`, `last_error`.
- `tx_attempts`: one row per signed transaction, keyed `(withdrawal_id, attempt_no)`,
  with a unique `txid`. It holds `raw`, the `unsigned` body and signing payloads, the
  `fee`, `created_at` (what "stuck" is measured from), `broadcast_at` and `seen_block`.
  One row normally; each replacement adds one.
- `withdrawal_events`: the history. Every state change (`{from, to}`), `broadcast`
  (`txid`, `sent`, `outcome`), `rebroadcast`, `replacement`, `reorg`, `reorged_out`, and
  `crash_injected` from the fault run.
- `ledger_accounts`, `ledger_txs`, `ledger_entries`: double entry. Each account has a
  `balance` with `check (balance >= 0)`. Each posting is one `ledger_txs` row with a
  unique `ref` (`hold:<id>`, `fee:<id>`, `settle:<id>`, `release:<id>`) and its lines.
- `chain_sequences`: one row per hot address, key `evm-anvil:<address>`, holding the next
  nonce to hand out.

`approvals` and `allowlist` matter only at the request. `chain_coins` is the UTXO store;
the EVM adapter does not use it.

## Stop 1: the request

`src/pipeline/requests.ts`, `submitWithdrawal`; tests in `test/requests.test.ts`.

Before a transaction opens, an amount of zero or less throws `RangeError`, and so does a
user id containing `:`, which ledger account names use as a separator (R23). The policy
is read with `deps.policy(chain, asset)` (an unknown asset throws there), and
`assertValidPolicy` checks that the minimum amount is a bigint of at least 1, that M is an
integer between 1 and the number of approvers, and that no approver is listed twice. A
configuration error writes nothing; it never becomes a rejection row (R20, R21). Then one
transaction:

1. **Idempotency.** The row is inserted with state `'APPROVED'` and
   `on conflict (user_id, idempotency_key) do nothing returning *`. No row back means the
   key is taken: `replay` returns the stored row as is, rejection included (R8), if
   chain, asset, address and amount match, and throws `IdempotencyKeyReuse` otherwise
   (R9). A concurrent insert with the same key waits on the unique index until the first
   transaction commits, so `replay` reads the final row, never the provisional one (R2).
2. **The account lock.** `lockAccount` (`src/pipeline/ledger.ts`) creates
   `user:<id>:evm-anvil:native` if needed and selects it `for update`. That serialises
   this user's requests for this asset, so two requests cannot both pass the 24-hour
   check on the same headroom (R15). Its comment gives the lock-order rule: afterwards,
   post only to accounts that sort at or after the locked one, as `user:...` and
   `withdrawals_in_flight:...` do.
3. **Policy, in order** (`checkRequest` in `src/pipeline/policy.ts`, first failure
   wins): `invalid_address`, `not_allowlisted`, `below_minimum` (under `minAmount`,
   which a deployment sets at least to the chain's smallest transferable amount, such as
   Bitcoin's 294 sat dust limit, so nothing the chain cannot carry is accepted; R24),
   `over_withdrawal_limit`, `over_24h_limit`. The 24-hour total (`recentTotal`) sums
   the user's other withdrawals of the same chain and asset created in the last 24 hours
   by `now()`, the database clock, not the process clock, leaving out `REJECTED` and
   `FAILED` ones, whose holds were never placed or were released (R5, R6, R6b).
4. **The hold, in a savepoint.** `placeHold` posts `hold:<id>`: debit the user, credit
   `withdrawals_in_flight`. A short balance fails the check constraint, which `post`
   turns into `InsufficientFunds`. A failed statement aborts a Postgres transaction, so
   without `tx.savepoint` the rejection itself could not be written (R7). The constraint
   is also the overdraft guard under concurrency (R19).
5. **The provisional state.** `setState` moves the row to `REJECTED` with the reason, or
   to `AWAITING_APPROVAL` when `amount >= approvalThreshold` (R10). Otherwise the row
   stays as inserted. `'APPROVED'` at insert time is safe because the row is uncommitted
   and invisible to `claim` until the transaction has set its final state.

A kill anywhere in `submitWithdrawal` rolls the whole transaction back. The caller got no
answer, retries with the same key, and either inserts afresh or, if the commit had
landed, gets the stored row.

**Approvals.** `decideApproval` locks the withdrawal row `for update`. A withdrawal that
has left `AWAITING_APPROVAL` is returned unchanged (R14). The requester and anyone outside
the approver set get `NotAnApprover` (R13). One `approvals` row per approver; the
`on conflict ... do update` clause only ever turns an `approve` into a `reject`. A reject
posts `release:<id>` and moves to `REJECTED`; an approve recounts and moves to `APPROVED`
at M distinct approvers, counting only those the policy lists now, so one removed after
approving no longer counts (R11, R17, R17b). A reject vetoes even from an approver who
approved earlier (R16, design call 21): a veto must never be dropped silently, and every
held withdrawal needs a way out inside the system. The row lock orders an approve that
races a reject, so the withdrawal ends in one consistent state (R21b).

## Stop 2: the claim and the lease

`src/pipeline/worker.ts`, `claim` and `runOnce`.

`claim` is one `update ... where id = (select ... for update skip locked)`. It picks a
row in `APPROVED`, `RESERVED`, `SIGNED` or `BROADCAST`, of a chain this worker has a
runtime for, whose `next_run_at` has passed and whose lease is empty or expired, and sets
`lease_owner` and `lease_expires_at = now() + leaseMs`. Choosing and leasing are one
statement, on the database's clock. `skip locked` passes over a row another worker is claiming, or whose
handler holds its row lock mid-transition.

`runOnce` runs `handlers[w.state]` with the row as read at claim time, then releases with
an update matched on `lease_owner = workerId`, so a worker whose lease was taken over
leaves the new owner's lease alone:

- success: lease cleared, `error_count = 0`, `next_run_at` untouched, so the next step is
  due at once; only `track` delays itself, through `poll`. If the step changed the state,
  an old `last_error` is cleared too.
- `LostRace`: lease cleared, nothing recorded. Another worker made this step.
- any other error: `error_count + 1`, `last_error`, and `next_run_at` moved out by
  `retryBaseMs * 2^min(error_count, 6)`. The state is unchanged (P6).

A killed worker never releases; its lease expires and the row is claimable again (P7). No
handler reads the lease. Stop 8 says why.

## Stop 3: reserve (APPROVED to RESERVED)

`src/pipeline/steps.ts`, `reserve`.

It asks the chain twice, outside any transaction: `quoteFee` (EVM: `estimateFeesPerGas`,
gas limit 21000 for native) and `syncInputs` (EVM: the hot address's pending nonce,
passed to `seedSequence`, which inserts only if the key is absent). Then one transaction:

```ts
const reservation = await rt.adapter.reserveInputs(pgInputStore(tx, w.id), intent, fee);
await transition(tx, w.id, 'APPROVED', 'RESERVED', { fee, reservation });
```

On EVM `reserveInputs` is `nextSequence` (`src/pipeline/input-store.ts`):
`update chain_sequences set next = next + 1 ... returning next - 1`. The update holds the
row lock until commit, so concurrent reservations queue and get consecutive values, and a
rollback undoes the increment (I3, I4 in `test/input-store.test.ts`).

Why this order:

- Network I/O stays outside the transaction, so no lock is held while waiting on a node.
- The nonce is taken in the same transaction as the state change that saves it. Both
  commit or neither does; a nonce cannot be handed out unrecorded or recorded twice. "P4
  on EVM" (`test/evm.pipeline.test.ts`) checks twelve distinct nonces and exactly twelve
  transactions from the hot wallet.
- The seed happens once per address (I5). From then on Postgres, not the node, decides
  the next nonce.
- Here the compare-and-swap comes second, unlike in `sign`, `replace` and `settle`. A
  worker that loses the race takes the next nonce, fails its `transition` with
  `LostRace`, and the rollback hands the nonce back.

**Crash points in this stop.**

- `after_reserve`. Durable: `RESERVED`, the fee and the nonce on the row, the counter
  advanced, the `APPROVED>RESERVED` event. Nothing has left the process. The next worker
  runs `sign` from its first line with the stored reservation: nothing was sent, and the
  nonce belongs to this withdrawal alone. Pinned by P3 (`RESERVED` with reservation and
  fee, no attempt) and the fault run's `kill at after_reserve`.
- A kill inside the transaction. The server rolls back: `APPROVED`, counter unchanged.
  The next worker re-runs `reserve`: a new quote, a no-op seed, the same nonce (I4).

## Stop 4: sign (RESERVED to SIGNED)

`sign`. It calls `buildTransfer` with `w.reservation` and `w.fee` from the row; the EVM
adapter returns an EIP-1559 body, which records the sender as `from`, and one signing
payload, the keccak of the serialised unsigned transaction. `signTx` calls
`signer.sign(hotKeyId, curve, payload)` per payload, and `attachSignatures` builds `raw`
(sending a high-S signature in its low-S form) and computes `txid = keccak256(raw)`
locally. Nothing has gone to the chain. Then:

```ts
await deps.db.begin(async (tx) => {
  await transition(tx, w.id, 'RESERVED', 'SIGNED'); // first: see transition
  await storeAttempt(tx, w.id, 1, signed, { unsigned, fee: w.fee });
});
await deps.crash('after_store', w.id);
```

Why this order:

- **Only stored inputs.** Every re-run builds the same transfer: same nonce, recipient,
  amount and fee.
- **Store before send.** `attachSignatures` returns the id the chain will report
  (contract note in `src/core/adapter.ts`, conformance check C6), so the attempt is
  committed with its id before any send. From here on, only bytes read back from
  `tx_attempts` are ever broadcast.
- **The compare-and-swap first.** `transition`'s update takes the withdrawal's row lock.
  A second worker in the same handler waits there, then matches no row and throws
  `LostRace` before it reaches the insert (P5). `storeAttempt` also turns an
  `attempt_no` conflict into `LostRace`, as a backstop. A `txid` conflict is left
  untargeted on purpose: it would mean two attempts share their bytes, so it fails loudly
  and backs off (test "an attempt whose txid another withdrawal already stored is an
  error, not a lost race").
- **The sender is part of the attempt.** A nonce belongs to one address. The reservation
  names the address it was taken for, `buildTransfer` refuses an intent from any other,
  and `attachSignatures` recovers the signer from the signature and refuses anyone but
  `from`. A worker with another seed or a rotated key fails here, with `last_error`,
  instead of spending this nonce from another address ("buildTransfer refuses a
  reservation made for another address" in `test/evm.adapter.test.ts`; F7 in Stop 7).
  Bitcoin gets the same by checking that the recovered key owns the inputs.

**Crash points in this stop.**

- `after_sign`: signed in memory, nothing stored. Durable: as at `after_reserve`. The next
  worker signs again from the stored reservation. The first signature died with the
  process and was never sent. X3 (`test/fault-run.test.ts`) kills a real worker process
  here and finds `RESERVED` with no attempt, then a clean finish.
- A kill inside the transaction. X3b holds a share lock on `tx_attempts`, so the sign
  transaction stops after its state change and before its insert, then SIGKILLs the
  worker. The server rolls back: `RESERVED`, no attempt, no `RESERVED>SIGNED` event.
- `after_store`. Durable: `SIGNED`, attempt 1 with `txid` and `raw`, `broadcast_at` null.
  Nothing sent. The next worker runs `broadcast`, which sends the stored bytes. P3 shows
  this state; the fault run kills there.

## Stop 5: broadcast (SIGNED to BROADCAST)

`broadcast`. It takes the latest stored attempt, asks the chain about its txid, sends
only if the node has no record of it, and then records:

```ts
if ((await rt.adapter.getTxStatus(stored.txid)).state === 'unknown') {
  await deps.crash('before_broadcast', w.id);
  // A transport error throws here and leaves the state SIGNED for a retry. 'rejected' is
  // recorded and still moves on: tracking re-sends the attempt, or replaces it once stale.
  result = await rt.adapter.broadcast(stored);
  sent = true;
  await deps.crash('after_broadcast', w.id);
}
```

The record is one transaction: `transition` from `SIGNED` to `BROADCAST`, `broadcast_at`
set on the attempt only while it is still the latest (Stop 8), and a `broadcast` event
with `txid`, `sent` and the outcome.

Why this order:

- **Ask the chain before sending.** The one dangerous kill is between the send and the
  record. Asking first turns the re-run into a record with no send. The EVM adapter's
  `broadcast` also looks the txid up first (`nodeHas`), and after an error it tells
  `already_known` from `rejected` by looking the txid up again, never by the error text
  (design call 22). The handler does not depend on that.
- **Record after sending.** The event holds the node's answer, which exists only after
  the call. A transport error throws and leaves `SIGNED` for a retry (P6). `rejected` is
  not final under the adapter contract, so it is recorded and tracking takes over.

**Crash points in this stop.**

- `before_broadcast`: the check said `unknown`, nothing sent. Durable: as at
  `after_store`. The next worker makes the same check and sends. Fault run.
- `after_broadcast`: sent, not recorded. Durable: `SIGNED` and the attempt; the node has
  the transaction. The next worker's `getTxStatus` says `pending` (or `confirmed`), so it
  does not send, and records `sent: false, outcome: already_known`. P8 recreates this
  in-process with a `broadcast` spy that is never called; X1 kills real processes here
  and every `broadcast` event reads `sent: false`.
- A kill inside the record transaction: rolled back to `SIGNED`, the same as
  `after_broadcast`.
- `after_broadcast_recorded`. Durable: `BROADCAST`, `broadcast_at`, the event. The next
  worker runs `track`, which sends nothing while the transaction is pending, and only the
  same stored bytes if the node has lost it. P3, fault run.

## Stop 6: track and settle (BROADCAST to SETTLED)

`track`. It reads every attempt with a `stale` flag (older than `stuckAfterMs` by the
database clock) and calls `getTxStatus` on each. The EVM adapter reads the receipt first
(`confirmations = tip - receipt block + 1`), then the mempool for `pending` or `unknown`.
Then:

1. More than one attempt confirmed: throw and settle nothing. The adapter promised that
   cannot happen; if it does, it shows as `last_error` on every retry, not in the ledger.
2. An attempt with `seen_block` set that is not confirmed now was reorganised out:
   `setSeenBlock(..., null)` and a `reorged_out` event.
3. One confirmed: record its block hash if it changed (a `reorg` event when it moved
   from one block to another). At `finalityDepth` confirmations, `settle`; below it,
   `poll`.
4. None confirmed: if the latest is `unknown`, broadcast the same stored bytes again (a
   `rebroadcast` event only if accepted; a rejection goes to `last_error` through
   `poll`, or into the `replacement` event if one follows). If the latest is stale and
   there are fewer than `maxAttempts` attempts, `replace`. Otherwise `poll` sets
   `next_run_at` one `pollMs` out.

`settle` runs one transaction. `transition` from `BROADCAST` to `SETTLED` (or `FAILED`)
with `settled_txid` comes first, then the postings through `postOnce`, which throws if a
ref already exists, since the transition has just ruled that out. The fee is posted
before the amount: `fee:<id>` (debit `network_fees`, credit `custody`, native), then
`settle:<id>` (debit `withdrawals_in_flight`, credit `custody`), or `release:<id>` on a
revert.

Why this order:

- **Settle only at finality.** Below `finalityDepth` a reorg can still undo the transfer
  (F2).
- **State and postings in one transaction**, behind the compare-and-swap, so a second
  settler waits, gets `LostRace` and posts nothing.
- **Fee first.** `post` locks accounts in name order within one posting; across postings
  the order is the code's. The comment in `settle` gives the case: with settle first, a
  native `FAILED` locks user, in-flight, then custody, while a native `SETTLED` locks
  custody, then in-flight, and the two can deadlock. With the fee first, every settle or
  fail locks `custody` (native) before anything else.

**Crash points in this stop.**

- `before_settle`. Durable: `BROADCAST`; `seen_block` may be set, since `setSeenBlock`
  commits on its own. The transfer is final on-chain and not yet in the ledger. The next
  worker's `track` finds the same confirmed attempt and settles. Meanwhile
  reconciliation counts it as explained, not drift (Q2 in `test/reconcile.test.ts`
  covers the not-yet-final case).
- A kill inside the settle transaction: rolled back to `BROADCAST` with no postings, the
  same as `before_settle`.
- `after_settle`. Durable: `SETTLED`, `settled_txid`, the fee and settle postings. The
  state is terminal and `claim` never selects it. The row keeps the dead worker's lease
  fields; nothing reads them. P1 checks this end state against the chain.

**Replacement.** `replace` calls `buildReplacement` with the stored reservation and the
previous attempt's unsigned body and fee. On EVM that is the same body, so the same nonce
and the same `from`, with both fee fields raised by at least one eighth and at least to
the current market quote (`bumped`, design call 24). It refuses a sender (in the intent
or the reservation) or a nonce other than the previous body's, so a replacement always
conflicts with what it replaces. It signs, then in one transaction: `transition` from
`BROADCAST` back to `SIGNED` first, `storeAttempt` with the next `attempt_no`, and a
`replacement` event. The `broadcast` handler then sends it exactly as it sends a first
attempt (design call 4: one send path, one recovery path).

- `after_replacement_store`. Durable: `SIGNED`, attempt N+1 stored and unsent; attempt N
  may still be pending, or evicted. The next worker's `broadcast` takes the latest
  attempt, finds it `unknown`, and sends it. If attempt N confirms instead, attempt N+1
  is rejected for its used nonce, the rejection is recorded, and `track`, which checks
  every attempt, settles with N's txid. Same nonce, so at most one confirms. The fault
  run sets `stuckAfterMs` to 1500 and holds blocks back until every withdrawal has a
  second attempt; F3 covers the path in-process.

## Stop 7: when the chain misbehaves

These tests in `test/pipeline-suite.ts` run in-process on both chains: against anvil from
`test/evm.pipeline.test.ts` and against bitcoind from `test/bitcoin.pipeline.test.ts`,
each with `finalityDepth: 2` from its env (`scripts/lib/evm-env.ts`,
`scripts/lib/bitcoin-env.ts`). This stop follows anvil and says where bitcoind differs.

**Dropped (F1).** The test removes the broadcast transaction from the mempool. `track`
sees `unknown` and sends the same stored bytes; the withdrawal settles with its single
attempt, and the event list shows one `rebroadcast`. Bitcoin Core cannot remove one
transaction, so its devnet expires the whole mempool by moving the node's clock and puts
the others back (`dropFromMempool` in `src/adapters/bitcoin/devnet.ts`).

**Reorganised out before finality (F2).** One block gives one confirmation; `track`
records `seen_block`. `reorg(1)` (anvil's `anvil_reorg`) replaces that block with an
empty one. Anvil forgets the removed block's transaction, so `track` sees `unknown`,
clears `seen_block` (`reorged_out`) and sends the same stored bytes again; they are mined
in a block with another hash and the withdrawal settles with the same txid. Bitcoin Core
puts the transaction back in its mempool instead: nothing is sent again, and depending on
whether `track` runs before the next block it records `reorged_out` or a `reorg` from the
old block to the new one. On both: one attempt, and one of those two events.

**Stuck or evicted (F3, F6).** `makeStuck` raises the base fee to 100 gwei before every
block. anvil evicts a pending transaction priced below a mined block's base fee, so the
attempt becomes `unknown` and its re-send is rejected. Once it is stale, `replace` builds
attempt 2 from the same reservation (the test checks the reservation did not change) at a
higher fee and moves back to `SIGNED`. Attempt 2 settles; attempt 1 never confirms. On
bitcoind the env's `mine` takes only transactions paying at least 1 sat/vB over the
adapter's rate (`mineAtLeast`), and the node keeps attempt 1 pending: no re-send, and the
`replacement` event records no refusal. F6: with `maxAttempts` 3 the pipeline stops at
three attempts, keeps polling, and still settles exactly one.

**Reverted (F4).** The test makes `getTxStatus` report every confirmation as reverted.
`settle` takes the `FAILED` branch: the fee is posted, since the gas was spent, and
`release:<id>` returns the amount to the user. `FAILED` is terminal (design call 18). A
real revert is in `test/evm.pipeline.test.ts`: the tokens are burnt after `RESERVED`, so
the stored token transfer reverts when mined.

**Underfunded hot wallet (F5).** On EVM the node rejects the send. The rejection is
recorded and the state moves to `BROADCAST`; `track` re-sends every poll and keeps the
rejection in `last_error`, with no event per poll. On Bitcoin no coin can be reserved,
so `reserve` fails and the withdrawal waits in `APPROVED`, backing off. Once the wallet is
funded the withdrawal settles: delayed, never failed.

**Another signing key (F7).** After the first broadcast, two workers try to replace the
attempt: one started with another seed, so another hot address, and one with another key
behind the same address. `buildReplacement` refuses the first (its sender differs from
the previous attempt's) and `attachSignatures` the second (the signature is not the
sender's). Each run fails with `last_error` and the state stays `BROADCAST`; no second
attempt is stored and the node holds only the first. A worker with the right key then
settles that first attempt alone.

## Stop 8: two workers on one withdrawal

What a lease does: while it is unexpired, `claim` passes the row over (P7). What it does
not do: prove that the holder is dead when it expires, or stop it. A process paused by a
slow signer, a slow node or the garbage collector carries on after its lease is gone, so
two workers can run the same handler. What happens then:

- **Same state change.** The compare-and-swap lets one through. P5 holds the row lock so
  that two `sign` handlers reach it together: one succeeds, the other gets `LostRace`, one
  attempt is stored.
- **Same insert.** A second `storeAttempt` for an `attempt_no` that exists is `LostRace`.
- **Both in `broadcast`.** Both may send, but only the stored bytes: one txid, one
  transfer. One of them records it.
- **A stale attempt.** A reads attempt 1 and pauses. B records it, tracks it and replaces
  it, which moves the state back to `SIGNED`. A sends attempt 1 (same nonce as attempt 2,
  so at most one confirms), and its `SIGNED` to `BROADCAST` transition succeeds because
  the state is `SIGNED` again. The update after it catches the stale attempt:

```ts
const rows = await tx`
  update tx_attempts set broadcast_at = now()
   where withdrawal_id = ${w.id} and attempt_no = ${latest.attempt_no}
     and attempt_no = (select max(attempt_no) from tx_attempts where withdrawal_id = ${w.id})`;
```

A count of zero throws `LostRace` and rolls the transition back. Without the check,
`BROADCAST` would record a broadcast of attempt 2 that never happened.

- **Same reorg seen twice.** `setSeenBlock` updates only if `seen_block` still holds the
  value read at the start of `track`, so one worker writes the event.

No step trusts the lease. Safety comes from the compare-and-swap on state, from sending
only stored bytes, and from attempts that exclude each other on the chain because they
spend the same nonce or coins of the same sender (design call 5; Stop 4). On the worker
path, clocks appear only in `claim`, `poll`, the backoff and the `stale` flag: they decide
when work happens, never whether it is safe. One documented exception is test-only:
`killOnce` assumes one worker per withdrawal, which the fault run respects.

## Stop 9: the ledger after settlement

Before the withdrawal, the sandbox (`scripts/lib/sandbox.ts`) posts
`fund:<hot address>:native` (debit `custody`, credit `platform`, the gas float) and a
deposit (debit `custody`, credit the user). Then, for amount A and on-chain fee F, all in
`evm-anvil:native`:

| Posting (`ref`) | Where              | Debit                   | Credit                  | Amount |
| --------------- | ------------------ | ----------------------- | ----------------------- | ------ |
| `hold:<id>`     | `submitWithdrawal` | `user:<id>`             | `withdrawals_in_flight` | A      |
| `fee:<id>`      | `settle` (first)   | `network_fees`          | `custody`               | F      |
| `settle:<id>`   | `settle` (second)  | `withdrawals_in_flight` | `custody`               | A      |

Net: the user is owed A less, `withdrawals_in_flight` is back where it was, `custody` is
down by A + F and `network_fees` up by F, as the hot wallet on-chain is down by A + F.
P1 checks that `custody` equals the hot wallet's on-chain balance.

`reconcile` (`src/pipeline/reconcile.ts`) only reads. In one repeatable-read snapshot it
reads the `custody` balances, the attempts of `SIGNED` and `BROADCAST` withdrawals, and
three self-checks: debits equal credits per asset, each balance equals the sum of its
entries, and `withdrawals_in_flight` equals the amounts of non-terminal withdrawals. Then
it asks the chain for each attempt's status (a confirmed one is "explained": minus its
amount if it succeeded, minus its fee in native) and for the hot wallet's balance.
`drift = onchain - ledger - explained` must be zero. It also flags two confirmed attempts
of one withdrawal and a non-zero `custody` account that no row covers. After settlement
nothing is explained and drift is zero (Q1); between confirmation and settlement the
transfer is explained (Q2).

## How the claim is tested

`scripts/fault-run.ts` runs every scenario of spec section 11 on each chain in turn,
`evm-anvil` and then `bitcoin-regtest`, each in a fresh schema with a freshly funded hot
wallet (`openSandbox`) and worker processes (`scripts/worker-main.ts`) under a supervisor
(`scripts/lib/supervisor.ts`). The scenarios are in `scripts/lib/scenarios.ts`:

- **Kill at each crash point** (nine scenarios). One worker at a time runs with
  `KIT_CRASH_AT` set and a one-second lease. `killOnce` records a `crash_injected` event
  in its own autocommit statement, then sends its own process SIGKILL; the server rolls
  back whatever was open. The supervisor starts a fresh worker, which passes that point
  for that withdrawal because the event exists, until every withdrawal is terminal. The
  kills must match the events, and at `after_broadcast` the restarted worker must have
  found every first attempt on the node and recorded it with `sent: false`.
- **Random kills.** Several workers, no crash point; the supervisor SIGKILLs a random one
  at random intervals, and withdrawals are submitted in batches until a minimum number
  of kills caught a worker holding a withdrawal (its lease still in the dead worker's
  name).
- **Duplicate requests.** Each request is submitted several times at once with one key,
  over separate connections, and again afterwards; two more are refused by policy and
  must stay refused.
- **Dropped, reorg, stuck fee.** No blocks until every withdrawal is broadcast; the fault
  is made with the workers stopped; then workers and blocks resume. Each checks that its
  fault happened and was handled the way its node requires: every dropped attempt sent
  again; every withdrawal recording `reorged_out`, with a re-send only where the node
  forgot the transaction; every first attempt replaced, and none confirmed, after the
  stuck fee.

Each withdrawal goes to its own fresh allowlisted address for its own amount, alternating
native and the test token on EVM, so a transfer to the wrong place shows as one sent twice
and one lost; a token float in the hot wallet lets a duplicated token transfer land
rather than revert. `grade` (`scripts/lib/grading.ts`) mines `finalityDepth + 1` blocks
and requires that the node holds nothing more from the hot wallet (`Devnet.pendingFrom`,
C16). `verifyAgainstChain` then grades by what each destination holds on the chain: more
than the amount, or anything at a `REJECTED` or `FAILED` destination, is sent twice; a
`SETTLED` withdrawal whose destination holds less is lost; a non-terminal one is
unfinished. Then `reconcile`. A scenario fails on any of those, on an outcome other than
the expected settled and rejected counts, on drift or a failed check, or on its own
check; any failure makes the exit code 1.

```sh
make up       # Postgres, anvil and bitcoind, building the bitcoind image
make faults   # npx tsx scripts/fault-run.ts: every scenario on both chains
npx tsx scripts/fault-run.ts --chain bitcoin-regtest --quick --only after_broadcast
```

The results table is in `docs/results.md`, written only by the full matrix at default
counts on both chains when every scenario passed and the checkout did not change during
the run; this document quotes no numbers.

## Questions a reviewer is likely to ask

**Why not record the broadcast before sending?** The record is the node's answer
(`sent`, `outcome`), which exists only after the call. Safety does not rest on the order:
only stored bytes are sent, and the handler asks the chain first (`broadcast` in
`src/pipeline/steps.ts`; P8).

**What if the signer is slow and the lease expires?** A second worker claims the row and
signs too. In the sign transaction `transition` lets one through; the other waits on the
row lock, matches nothing and gets `LostRace`, so its signature is dropped unsent (P5).
If the slow step is the send, both send the same stored bytes: one transfer.

**Why is the nonce in Postgres and not read from the node?** Two workers reading the
pending nonce at once get the same value. `nextSequence` hands it out under a row lock in
the transaction that commits `RESERVED`, and a rollback returns it (I3, I4). The cost
(design call 6): a reserved nonce must be used, so there is no cancel after `RESERVED`;
and since the node is read only for the first seed (I5), a transaction sent from the hot
address outside the pipeline would leave the counter behind.

**What changes for Bitcoin?** In the pipeline, nothing: the same handlers run it
(`test/bitcoin.pipeline.test.ts` runs the pipeline suite on bitcoind, where only P2, a
token withdrawal, skips, plus "P4 on Bitcoin", which checks that each transaction spent
exactly its own reserved coins). The
adapter (`src/adapters/bitcoin/adapter.ts`) differs where the chain does. `syncInputs`
calls `putCoins` with the hot address's confirmed coins; `reserveInputs` picks from
`freeCoins` (row-locked, `skip locked`), largest first, and calls `reserveCoins`, which is
all or nothing (I6, I7, I7b); there is one signing payload per input (B9); the public key
is recovered from the signature and must own the inputs (B7); a replacement spends the
same coins with less change and is refused if the reservation or intent differs from the
previous attempt (B6, B8, B13, B14). Outside the adapter it took a registry entry, the
node's image and Compose service, one conformance-suite change and test-harness work;
`docs/design.md` section 1 says which, and `docs/adding-a-chain.md` measures it.

**Where would an HSM or MPC signer plug in?** Implement `Signer` (`src/core/signer.ts`):
`publicKey`, and `sign` over the adapter's payload (a 32-byte digest for secp256k1),
returning r, s and a recovery id of 0 or 1; S may be high or low, since both adapters
send the low-S form. `buildRuntime` in `src/pipeline/runtime.ts` builds the `LocalSigner`
today; `signTx` and `hotWallet` are the pipeline's only callers. Signing happens before
the store transaction, so a slow or failing signer only delays a step, and a signature by
the wrong key is refused in `attachSignatures` before anything is stored (Stop 4).
`docs/design.md` section 7 sketches one.

**What stops one request from being paid twice?** The unique `(user_id,
idempotency_key)`, `on conflict do nothing`, and `replay`'s parameter check (R2, R9).
After that, one withdrawal has one reservation, and all its attempts share it.

**Why is the compare-and-swap first in its transaction?** Its row lock makes a second
worker wait and then fail with `LostRace` before any insert, so a unique violation only
ever means a real fault (`transition`'s comment; the duplicate-txid test). `reserve` is
the one exception, and its rollback returns the nonce.

**Can a reorg cause a double send or a wrong settlement?** Status is about the canonical
chain; `track` clears `seen_block`, sends only the same stored bytes, and settles only at
`finalityDepth` (F2). Nothing re-checks a `SETTLED` withdrawal, so a reorg deeper than
`finalityDepth` is outside what the pipeline handles.

**Why does a revert end `FAILED` instead of retrying?** The nonce is consumed, and a
blind retry of a revert is unsafe; an operator decides (design call 18, F4).

**Why SIGKILL and not an exception?** An exception runs `catch` blocks and `runOnce`'s
error path; a real crash runs nothing. SIGKILL leaves the server to roll back what was
open (design call 10, `killOnce`, X3b).

**What does reconciliation not prove?** It compares the ledger with the hot wallet, not
with destinations; that is `verifyAgainstChain`. Its chain reads are not pinned to its
database snapshot, so its own comment says to confirm a failure with a second run.

## Where the code differs from the spec

The spec in `docs/superpowers/specs/` was approved before the build and has since been
brought in line with the code, each change marked "(decided during the build)". The
changes, for a reader who knows the original:

1. The fault run covers every scenario of spec section 11 on both chains (nine crash
   points; random kills, until a minimum number caught a worker holding a withdrawal;
   duplicates; dropped; reorg; stuck fee). It writes `docs/results.md` only for the full
   default matrix on every chain, all passing, on a checkout that did not change.
2. Grading waits for `finalityDepth + 1` more blocks and a node holding nothing more from
   the hot wallet (`Devnet.pendingFrom`, C16). The hot wallet holds a token float. Each
   scenario also checks that its own fault happened, and a scenario can declare itself
   not applicable on a chain (none does yet).
3. Lost is a `SETTLED` withdrawal whose destination holds less than its amount (the spec
   said zero), non-terminal ones are unfinished, and sent twice also counts anything at a
   `REJECTED` or `FAILED` destination.
4. `reconcile(db, chains, assets)` reads the hot address only, explains only attempts of
   `SIGNED` and `BROADCAST` withdrawals, adds `custody_covered` and
   `one_confirmed_attempt`, and throws when asked to compare nothing.
5. `settle` posts the fee before the amount.
6. `track` stops replacing at `maxAttempts`, refuses to settle when two attempts confirm,
   writes `reorg` and `reorged_out`, and writes `rebroadcast` only when the re-send was
   accepted; the broadcast handler records only the latest attempt.
7. `Devnet` has `pendingFrom` (C16) and the harness `unknownTxid()`. C13 funds its
   wallet twice; Bitcoin needed no capability flag. C14's after-expiry form is not
   written, and C14 skips for such a harness.
8. Bitcoin: `@scure/btc-signer`; a node with `-txindex`; a fixed 2 sat/vB; dust refused at
   the quote; change under 294 sat folded into the fee; replacements rebuilt from the
   previous body and checked against the reservation and intent, at the highest of an
   eighth more, 1 sat/vB more and the quote, and refused when no change is left; the
   public key recovered from the signature; high S normalised; `scanBlock` reports
   coinbase and change outputs too.
9. `finalityDepth` defaults to 3; the tests, the fault run and the demo use 2. Each
   `PipelineEnv` says how its node behaves (`fundingPieces`, `stuckEvicts`,
   `reorgKeepsMempool`). On Bitcoin a stuck fee is the harness choosing what to mine.
10. Layout: `src/chains.ts`, `src/config.ts`, `src/pipeline/runtime.ts`,
    `src/pipeline/verify.ts`, `src/adapters/bitcoin/{adapter,devnet,rpc}.ts`,
    `scripts/lib/*` (with `grading.ts`), `docker/bitcoind/`, `scripts/demo.ts` and
    `scripts/reconcile.ts` exist; `src/core/json.ts` and `src/pipeline/config.ts` do not.
11. The demo, on EVM only, also replays a request and refuses its key reused for another
    amount, checks what it prints about the crash, the replay and the balances, and exits
    1 if one claim does not hold.
12. Make targets: `up` (building the bitcoind image), `down`, `test`, `typecheck`,
    `lint`, `migrate`, `conformance`, `faults`, `demo`, `reconcile`, `chain-cost`,
    `contracts`.
13. From the final review: `claim` takes only chains the worker has a runtime for; the
    24-hour limit leaves out `FAILED` as well as `REJECTED`; the EVM adapter normalises a
    high S and ties every attempt to its sender; only approvers the policy currently
    lists count toward M.
14. A minimum amount per asset (`minAmount`, rejected as `below_minimum` before the
    limits), so a Bitcoin withdrawal below the dust limit is refused at request instead of
    waiting in `APPROVED` with its hold.
