import { hexToBytes } from '@noble/curves/utils.js';
import type { BroadcastResult, Json, TransferIntent, TxStatus } from '../core/adapter.js';
import type { Queryable, Tx } from './db.js';
import { pgInputStore } from './input-store.js';
import { acct, ledgerAsset, post } from './ledger.js';
import type { Withdrawal, WithdrawalState } from './requests.js';
import type { ChainRuntime, WorkerDeps } from './worker.js';

/** Another worker made this state change first. Not an error: the step happened once. */
export class LostRace extends Error {
  override name = 'LostRace';
}

interface Patch {
  fee?: Json;
  reservation?: Json;
  settledTxid?: string;
}

const jsonOrNull = (sql: Queryable, v: Json | undefined) => (v === undefined ? null : sql.json(v));

/**
 * The compare-and-swap every state change goes through, with its `state` event.
 * Call it before any insert with a unique key in the same transaction: its row lock makes a
 * second worker on the same withdrawal wait here, then match no row and throw LostRace,
 * instead of failing later on a unique violation.
 */
export async function transition(
  tx: Tx,
  id: string,
  from: WithdrawalState,
  to: WithdrawalState,
  patch: Patch = {},
): Promise<void> {
  // An absent patch field binds SQL null, and coalesce keeps the column as it is.
  const rows = await tx`
    update withdrawals
       set state = ${to}, updated_at = now(),
           fee = coalesce(${jsonOrNull(tx, patch.fee)}::jsonb, fee),
           reservation = coalesce(${jsonOrNull(tx, patch.reservation)}::jsonb, reservation),
           settled_txid = coalesce(${patch.settledTxid ?? null}::text, settled_txid)
     where id = ${id} and state = ${from}`;
  if (rows.count === 0) throw new LostRace(`withdrawal ${id} is no longer ${from}`);
  await event(tx, id, 'state', { from, to });
}

export async function event(sql: Queryable, id: string, kind: string, data: Json = {}) {
  await sql`insert into withdrawal_events (withdrawal_id, kind, data) values (${id}, ${kind}, ${sql.json(data)})`;
}

function runtime(deps: WorkerDeps, w: Withdrawal): ChainRuntime {
  const rt = deps.chains[w.chain];
  if (!rt) throw new Error(`no chain runtime for ${w.chain}`);
  return rt;
}

const intentOf = (rt: ChainRuntime, w: Withdrawal): TransferIntent => ({
  from: rt.hotAddress,
  to: w.to,
  asset: w.asset,
  amount: w.amount,
});

interface Attempt {
  attempt_no: number;
  txid: string;
  raw: string;
  seen_block: string | null;
}

const attempts = (sql: Queryable, id: string) => sql<Attempt[]>`
  select attempt_no, txid, raw, seen_block from tx_attempts
   where withdrawal_id = ${id} order by attempt_no`;

// APPROVED -> RESERVED. Nothing leaves the process, so a re-run from any point is harmless.
async function reserve(deps: WorkerDeps, w: Withdrawal): Promise<void> {
  const rt = runtime(deps, w);
  const intent = intentOf(rt, w);
  const fee = await rt.adapter.quoteFee(intent);
  // Network I/O stays outside the transaction; syncInputs only inserts what is missing.
  await rt.adapter.syncInputs(pgInputStore(deps.db, w.id), rt.hotAddress);
  await deps.db.begin(async (tx) => {
    // The reservation is taken under the store's row locks and saved by the transition in the
    // same transaction. A loser's transition throws LostRace, and the rollback hands its nonce
    // or coins back, so no reservation is ever lost or shared.
    const reservation = await rt.adapter.reserveInputs(pgInputStore(tx, w.id), intent, fee);
    await transition(tx, w.id, 'APPROVED', 'RESERVED', { fee, reservation });
  });
  await deps.crash('after_reserve', w.id);
}

// RESERVED -> SIGNED. Built only from the stored reservation and fee, so every re-run builds
// the same transfer. Signatures that die with the process were never sent anywhere.
async function sign(deps: WorkerDeps, w: Withdrawal): Promise<void> {
  const rt = runtime(deps, w);
  const unsigned = await rt.adapter.buildTransfer(intentOf(rt, w), w.reservation, w.fee);
  const signatures: Uint8Array[] = [];
  for (const payload of unsigned.signingPayloads) {
    signatures.push(await deps.signer.sign(rt.hotKeyId, rt.adapter.curve, hexToBytes(payload)));
  }
  const signed = rt.adapter.attachSignatures(unsigned, signatures);
  await deps.crash('after_sign', w.id);
  await deps.db.begin(async (tx) => {
    await transition(tx, w.id, 'RESERVED', 'SIGNED'); // first: see transition
    const body = { body: unsigned.body, signingPayloads: unsigned.signingPayloads };
    await tx`
      insert into tx_attempts (withdrawal_id, attempt_no, txid, raw, unsigned, fee)
      values (${w.id}, 1, ${signed.txid}, ${signed.raw}, ${tx.json(body)}, ${tx.json(w.fee)})`;
  });
  await deps.crash('after_store', w.id);
}

// SIGNED -> BROADCAST. Sends only bytes read back from tx_attempts, which were committed
// before this handler could run.
async function broadcast(deps: WorkerDeps, w: Withdrawal): Promise<void> {
  const rt = runtime(deps, w);
  const latest = (await attempts(deps.db, w.id)).at(-1);
  if (!latest) throw new Error(`withdrawal ${w.id} is SIGNED but has no attempt`);
  const stored = { txid: latest.txid, raw: latest.raw };

  // Asking first is what makes a re-run after 'after_broadcast' send nothing: the node
  // already has the stored id, and the broadcast is recorded without another send.
  let result: BroadcastResult = { outcome: 'already_known' };
  if ((await rt.adapter.getTxStatus(stored.txid)).state === 'unknown') {
    await deps.crash('before_broadcast', w.id);
    // A transport error throws here and leaves the state SIGNED for a retry. 'rejected' is
    // recorded and still moves on: tracking re-sends or replaces.
    result = await rt.adapter.broadcast(stored);
    await deps.crash('after_broadcast', w.id);
  }
  await deps.db.begin(async (tx) => {
    await transition(tx, w.id, 'SIGNED', 'BROADCAST');
    await tx`
      update tx_attempts set broadcast_at = now()
       where withdrawal_id = ${w.id} and attempt_no = ${latest.attempt_no}`;
    await event(tx, w.id, 'broadcast', { txid: stored.txid, ...result });
  });
  await deps.crash('after_broadcast_recorded', w.id);
}

type Confirmed = Extract<TxStatus, { state: 'confirmed' }>;

// BROADCAST -> SETTLED or FAILED once one attempt is final; otherwise look again later.
async function track(deps: WorkerDeps, w: Withdrawal): Promise<void> {
  const rt = runtime(deps, w);
  const confirmed: { attempt: Attempt; status: Confirmed }[] = [];
  for (const attempt of await attempts(deps.db, w.id)) {
    const status = await rt.adapter.getTxStatus(attempt.txid);
    if (status.state === 'confirmed') confirmed.push({ attempt, status });
  }
  // The adapter promises at most one attempt of a withdrawal can confirm. If that ever
  // breaks, settle nothing and keep failing loudly.
  if (confirmed.length > 1) {
    const ids = confirmed.map((c) => c.attempt.txid).join(', ');
    throw new Error(`withdrawal ${w.id}: more than one attempt confirmed (${ids})`);
  }
  const hit = confirmed[0];
  if (hit) {
    if (hit.status.block.hash !== hit.attempt.seen_block) await rememberBlock(deps, w, hit);
    if (hit.status.confirmations >= rt.adapter.finalityDepth) {
      await settle(deps, w, hit.attempt.txid, hit.status);
      return;
    }
  }
  await deps.db`
    update withdrawals set next_run_at = now() + make_interval(secs => ${deps.timings.pollMs / 1000})
     where id = ${w.id} and state = 'BROADCAST'`;
}

// A block hash other than the one seen before means the confirming block was replaced.
async function rememberBlock(
  deps: WorkerDeps,
  w: Withdrawal,
  { attempt, status }: { attempt: Attempt; status: Confirmed },
): Promise<void> {
  await deps.db.begin(async (tx) => {
    await tx`
      update tx_attempts set seen_block = ${status.block.hash}
       where withdrawal_id = ${w.id} and attempt_no = ${attempt.attempt_no}`;
    if (attempt.seen_block !== null) {
      await event(tx, w.id, 'reorg', {
        txid: attempt.txid,
        from: attempt.seen_block,
        to: status.block.hash,
      });
    }
  });
}

async function settle(deps: WorkerDeps, w: Withdrawal, txid: string, s: Confirmed) {
  const a = ledgerAsset(w.chain, w.asset);
  const n = ledgerAsset(w.chain, 'native');
  await deps.crash('before_settle', w.id);
  await deps.db.begin(async (tx) => {
    await transition(tx, w.id, 'BROADCAST', s.succeeded ? 'SETTLED' : 'FAILED', {
      settledTxid: txid,
    });
    // The fee is posted first so that every settle or fail transaction locks custody(native)
    // before any other ledger account. With settle first, a native FAILED (user, in-flight,
    // then custody) and a native SETTLED (custody, then in-flight) could deadlock.
    if (s.feePaid > 0n) {
      await post(tx, `fee:${w.id}`, 'network_fee', n, [
        { account: acct.networkFees(n), side: 'debit', amount: s.feePaid },
        { account: acct.custody(n), side: 'credit', amount: s.feePaid },
      ]);
    }
    if (s.succeeded) {
      await post(tx, `settle:${w.id}`, 'settle', a, [
        { account: acct.inFlight(a), side: 'debit', amount: w.amount },
        { account: acct.custody(a), side: 'credit', amount: w.amount },
      ]);
    } else {
      await post(tx, `release:${w.id}`, 'release', a, [
        { account: acct.inFlight(a), side: 'debit', amount: w.amount },
        { account: acct.user(w.userId, a), side: 'credit', amount: w.amount },
      ]);
    }
  });
  await deps.crash('after_settle', w.id);
}

export const handlers: Record<
  'APPROVED' | 'RESERVED' | 'SIGNED' | 'BROADCAST',
  (deps: WorkerDeps, w: Withdrawal) => Promise<void>
> = { APPROVED: reserve, RESERVED: sign, SIGNED: broadcast, BROADCAST: track };
