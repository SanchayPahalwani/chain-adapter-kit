import { hexToBytes } from '@noble/curves/utils.js';
import type {
  BroadcastResult,
  Json,
  SignedTx,
  TransferIntent,
  TxStatus,
  UnsignedTx,
} from '../core/adapter.js';
import type { Queryable, Tx } from './db.js';
import { pgInputStore } from './input-store.js';
import { acct, ledgerAsset, post, type Line } from './ledger.js';
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
  unsigned: UnsignedTx;
  fee: Json;
  seen_block: string | null;
  stale: boolean; // older than stuckAfterMs, by the database clock
}

type Built = { unsigned: UnsignedTx; fee: Json };

const attempts = ({ db, timings }: WorkerDeps, id: string) => db<Attempt[]>`
  select attempt_no, txid, raw, unsigned, fee, seen_block,
         now() - created_at > make_interval(secs => ${timings.stuckAfterMs / 1000}) as stale
    from tx_attempts where withdrawal_id = ${id} order by attempt_no`;

async function signTx(deps: WorkerDeps, rt: ChainRuntime, unsigned: UnsignedTx): Promise<SignedTx> {
  const signatures: Uint8Array[] = [];
  for (const payload of unsigned.signingPayloads) {
    signatures.push(await deps.signer.sign(rt.hotKeyId, rt.adapter.curve, hexToBytes(payload)));
  }
  return rt.adapter.attachSignatures(unsigned, signatures);
}

// The whole unsigned transaction is stored, so a replacement can be built from it later.
// An attempt_no already there means another worker stored this attempt first: LostRace. A txid
// already there is not targeted, so it fails loudly: it means two attempts share their bytes.
async function storeAttempt(tx: Tx, id: string, no: number, signed: SignedTx, built: Built) {
  const { body, signingPayloads } = built.unsigned;
  const unsigned = tx.json({ body, signingPayloads });
  const rows = await tx`
    insert into tx_attempts (withdrawal_id, attempt_no, txid, raw, unsigned, fee)
    values (${id}, ${no}, ${signed.txid}, ${signed.raw}, ${unsigned}, ${tx.json(built.fee)})
    on conflict (withdrawal_id, attempt_no) do nothing`;
  if (rows.count === 0) throw new LostRace(`attempt ${no} of withdrawal ${id} is already stored`);
}

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
  const signed = await signTx(deps, rt, unsigned);
  await deps.crash('after_sign', w.id);
  await deps.db.begin(async (tx) => {
    await transition(tx, w.id, 'RESERVED', 'SIGNED'); // first: see transition
    await storeAttempt(tx, w.id, 1, signed, { unsigned, fee: w.fee });
  });
  await deps.crash('after_store', w.id);
}

// SIGNED -> BROADCAST, for the first attempt or a replacement. Sends only bytes read back from
// tx_attempts, which were committed before this handler could run.
async function broadcast(deps: WorkerDeps, w: Withdrawal): Promise<void> {
  const rt = runtime(deps, w);
  const latest = (await attempts(deps, w.id)).at(-1);
  if (!latest) throw new Error(`withdrawal ${w.id} is SIGNED but has no attempt`);
  const stored = { txid: latest.txid, raw: latest.raw };

  // Asking first is what makes a re-run after 'after_broadcast' send nothing: the node
  // already has the stored id, and the broadcast is recorded without another send.
  let result: BroadcastResult = { outcome: 'already_known' };
  let sent = false;
  if ((await rt.adapter.getTxStatus(stored.txid)).state === 'unknown') {
    await deps.crash('before_broadcast', w.id);
    // A transport error throws here and leaves the state SIGNED for a retry. 'rejected' is
    // recorded and still moves on: tracking re-sends the attempt, or replaces it once stale.
    result = await rt.adapter.broadcast(stored);
    sent = true;
    await deps.crash('after_broadcast', w.id);
  }
  await deps.db.begin(async (tx) => {
    await transition(tx, w.id, 'SIGNED', 'BROADCAST');
    // The state alone does not say which attempt this is: a slow worker holding attempt N can
    // get here after a replacement stored N+1 and moved the state back to SIGNED.
    const rows = await tx`
      update tx_attempts set broadcast_at = now()
       where withdrawal_id = ${w.id} and attempt_no = ${latest.attempt_no}
         and attempt_no = (select max(attempt_no) from tx_attempts where withdrawal_id = ${w.id})`;
    if (rows.count === 0)
      throw new LostRace(`attempt ${latest.attempt_no} of ${w.id} was replaced`);
    await event(tx, w.id, 'broadcast', { txid: stored.txid, sent, ...result });
  });
  await deps.crash('after_broadcast_recorded', w.id);
}

type Confirmed = Extract<TxStatus, { state: 'confirmed' }>;

// BROADCAST -> SETTLED or FAILED once one attempt is final. Otherwise: forget blocks that were
// reorganised away, send the latest attempt again if the node lost it, replace it once stale,
// and look again later.
async function track(deps: WorkerDeps, w: Withdrawal): Promise<void> {
  const rt = runtime(deps, w);
  const seen: { attempt: Attempt; status: TxStatus }[] = [];
  for (const attempt of await attempts(deps, w.id)) {
    seen.push({ attempt, status: await rt.adapter.getTxStatus(attempt.txid) });
  }
  const confirmed = seen.flatMap(({ attempt, status }) =>
    status.state === 'confirmed' ? [{ attempt, status }] : [],
  );
  // The adapter promises at most one attempt of a withdrawal can confirm. If that ever
  // breaks, settle nothing and keep failing loudly.
  if (confirmed.length > 1) {
    const ids = confirmed.map((c) => c.attempt.txid).join(', ');
    throw new Error(`withdrawal ${w.id}: more than one attempt confirmed (${ids})`);
  }
  // Any attempt that was seen in a block and is not confirmed now was reorganised out.
  for (const { attempt, status } of seen) {
    if (status.state !== 'confirmed' && attempt.seen_block !== null) {
      await setSeenBlock(deps, w, attempt, null);
    }
  }
  const hit = confirmed[0];
  if (hit) {
    if (hit.status.block.hash !== hit.attempt.seen_block) {
      await setSeenBlock(deps, w, hit.attempt, hit.status.block.hash);
    }
    if (hit.status.confirmations >= rt.adapter.finalityDepth) {
      await settle(deps, w, hit.attempt.txid, hit.status);
      return;
    }
    return poll(deps, w);
  }

  const last = seen.at(-1);
  if (!last) throw new Error(`withdrawal ${w.id} is BROADCAST but has no attempt`);
  const { attempt: latest } = last;
  // Dropped, evicted or reorganised out: the same stored bytes again, so the same transfer.
  let rejected: string | null = null;
  if (last.status.state === 'unknown') {
    const result = await rt.adapter.broadcast({ txid: latest.txid, raw: latest.raw });
    // Only an accepted re-send is an event: a rejected one repeats every pollMs (an underfunded
    // wallet, a fee below the base fee) and is kept on the row as last_error instead.
    if (result.outcome === 'accepted') {
      await event(deps.db, w.id, 'rebroadcast', { txid: latest.txid, outcome: result.outcome });
    }
    if (result.outcome === 'rejected') rejected = result.reason;
  }
  if (
    latest.stale &&
    seen.length < deps.timings.maxAttempts &&
    (await replace(deps, w, latest, rejected))
  ) {
    return;
  }
  await poll(deps, w, rejected);
}

// `rejected`: why the node refused the latest re-send. A poll without one clears it.
async function poll(deps: WorkerDeps, w: Withdrawal, rejected: string | null = null) {
  await deps.db`
    update withdrawals
       set next_run_at = now() + make_interval(secs => ${deps.timings.pollMs / 1000}),
           last_error = ${rejected}
     where id = ${w.id} and state = 'BROADCAST'`;
}

// Stored before it is sent: back to SIGNED, and the broadcast handler sends it as it sends a first
// attempt. Same reservation, so at most one attempt can confirm. `rejected` (this run's re-send
// of `latest`) goes in the event, since no poll follows to record it.
async function replace(deps: WorkerDeps, w: Withdrawal, latest: Attempt, rejected: string | null) {
  const rt = runtime(deps, w);
  const previous = { unsigned: latest.unsigned, fee: latest.fee };
  const rep = await rt.adapter.buildReplacement(intentOf(rt, w), w.reservation, previous);
  if (!rep) return false; // expiry model: the previous attempt can still be included
  const signed = await signTx(deps, rt, rep.unsigned);
  await deps.db.begin(async (tx) => {
    await transition(tx, w.id, 'BROADCAST', 'SIGNED'); // first: see transition
    await storeAttempt(tx, w.id, latest.attempt_no + 1, signed, rep);
    await event(tx, w.id, 'replacement', { txid: signed.txid, replaces: latest.txid, rejected });
  });
  await deps.crash('after_replacement_store', w.id);
  return true;
}

// Records the block an attempt is confirmed in, or null once it is not. The update matches only
// the value read at the start of track, so when two workers see the same change, one records it
// and writes the event. A different block, or none, means the confirming block was replaced.
async function setSeenBlock(deps: WorkerDeps, w: Withdrawal, a: Attempt, hash: string | null) {
  await deps.db.begin(async (tx) => {
    const rows = await tx`
      update tx_attempts set seen_block = ${hash}
       where withdrawal_id = ${w.id} and attempt_no = ${a.attempt_no}
         and seen_block is not distinct from ${a.seen_block}::text`;
    if (rows.count === 0 || a.seen_block === null) return;
    if (hash === null) await event(tx, w.id, 'reorged_out', { txid: a.txid, block: a.seen_block });
    else await event(tx, w.id, 'reorg', { txid: a.txid, from: a.seen_block, to: hash });
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
    // post returns false for a ref that is already there: this withdrawal was settled or failed
    // before, which the transition above rules out. Never let that pass silently.
    const postOnce = async (ref: string, kind: string, asset: string, lines: Line[]) => {
      if (!(await post(tx, ref, kind, asset, lines))) throw new Error(`${ref} was already posted`);
    };
    // The fee is posted first so that every settle or fail transaction locks custody(native)
    // before any other ledger account. With settle first, a native FAILED (user, in-flight,
    // then custody) and a native SETTLED (custody, then in-flight) could deadlock.
    if (s.feePaid > 0n) {
      await postOnce(`fee:${w.id}`, 'network_fee', n, [
        { account: acct.networkFees(n), side: 'debit', amount: s.feePaid },
        { account: acct.custody(n), side: 'credit', amount: s.feePaid },
      ]);
    }
    if (s.succeeded) {
      await postOnce(`settle:${w.id}`, 'settle', a, [
        { account: acct.inFlight(a), side: 'debit', amount: w.amount },
        { account: acct.custody(a), side: 'credit', amount: w.amount },
      ]);
    } else {
      await postOnce(`release:${w.id}`, 'release', a, [
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
