import type { Json } from '../core/adapter.js';
import type { Db, Queryable, Tx } from './db.js';
import { acct, InsufficientFunds, ledgerAsset, lockAccount, post } from './ledger.js';
import {
  canApprove,
  checkRequest,
  needsApproval,
  type AssetPolicy,
  type RejectReason,
} from './policy.js';

export type WithdrawalState =
  | 'REJECTED'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'RESERVED'
  | 'SIGNED'
  | 'BROADCAST'
  | 'SETTLED'
  | 'FAILED';
export interface Withdrawal {
  id: string;
  userId: string;
  idempotencyKey: string;
  chain: string;
  asset: string;
  to: string;
  amount: bigint;
  state: WithdrawalState;
  rejectReason: RejectReason | null;
  fee: Json | null;
  reservation: Json | null;
  settledTxid: string | null;
}
export interface RequestDeps {
  policy(chain: string, asset: string): AssetPolicy;
  validateAddress(chain: string, address: string): boolean;
}
export interface WithdrawalRequest {
  idempotencyKey: string;
  userId: string;
  chain: string;
  asset: string;
  to: string;
  amount: bigint;
}

export class IdempotencyKeyReuse extends Error {}
export class NotAnApprover extends Error {}

export function rowToWithdrawal(row: Record<string, unknown>): Withdrawal {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    idempotencyKey: row.idempotency_key as string,
    chain: row.chain as string,
    asset: row.asset as string,
    to: row.to_address as string,
    amount: row.amount as bigint,
    state: row.state as WithdrawalState,
    rejectReason: row.reject_reason as RejectReason | null,
    fee: row.fee as Json | null,
    reservation: row.reservation as Json | null,
    settledTxid: row.settled_txid as string | null,
  };
}

export async function getWithdrawal(sql: Queryable, id: string): Promise<Withdrawal> {
  const [row] = await sql`select * from withdrawals where id = ${id}`;
  if (!row) throw new Error(`withdrawal ${id} not found`);
  return rowToWithdrawal(row);
}

export async function allowAddress(db: Db, userId: string, chain: string, address: string) {
  await db`
    insert into allowlist (user_id, chain, address) values (${userId}, ${chain}, ${address})
    on conflict do nothing`;
}

async function setState(
  tx: Tx,
  id: string,
  from: WithdrawalState,
  to: WithdrawalState,
  reason: RejectReason | null,
): Promise<Withdrawal> {
  const [row] = await tx`
    update withdrawals set state = ${to}, reject_reason = ${reason}, updated_at = now()
    where id = ${id} and state = ${from} returning *`;
  if (!row) throw new Error(`withdrawal ${id} is no longer ${from}`);
  return rowToWithdrawal(row);
}

// The concurrent insert with this key has committed (on conflict waited for it), so the row exists.
async function replay(tx: Tx, req: WithdrawalRequest): Promise<Withdrawal> {
  const [row] = await tx`
    select * from withdrawals
    where user_id = ${req.userId} and idempotency_key = ${req.idempotencyKey}`;
  if (!row) throw new Error(`withdrawal ${req.userId}/${req.idempotencyKey} not found`);
  const w = rowToWithdrawal(row);
  const same =
    w.chain === req.chain && w.asset === req.asset && w.to === req.to && w.amount === req.amount;
  if (!same)
    throw new IdempotencyKeyReuse(`key ${req.idempotencyKey} was used for another request`);
  return w;
}

// Excludes the row being decided, which is already inserted.
async function recentTotal(tx: Tx, w: Withdrawal): Promise<bigint> {
  const [row] = await tx<{ total: bigint }[]>`
    select coalesce(sum(amount), 0) as total from withdrawals
    where user_id = ${w.userId} and chain = ${w.chain} and asset = ${w.asset}
      and id <> ${w.id} and state <> 'REJECTED'
      and created_at > now() - interval '24 hours'`;
  return row?.total ?? 0n;
}

// In a savepoint: the failed balance update would otherwise abort the whole transaction,
// and the rejection could not be written.
async function placeHold(tx: Tx, w: Withdrawal, a: string): Promise<RejectReason | null> {
  try {
    await tx.savepoint((sp) =>
      post(sp, `hold:${w.id}`, 'hold', a, [
        { account: acct.user(w.userId, a), side: 'debit', amount: w.amount },
        { account: acct.inFlight(a), side: 'credit', amount: w.amount },
      ]),
    );
    return null;
  } catch (e) {
    if (e instanceof InsufficientFunds) return 'insufficient_funds';
    throw e;
  }
}

export function submitWithdrawal(
  db: Db,
  deps: RequestDeps,
  req: WithdrawalRequest,
): Promise<Withdrawal> {
  return db.begin(async (tx) => {
    const [row] = await tx`
      insert into withdrawals (user_id, idempotency_key, chain, asset, to_address, amount, state)
      values (${req.userId}, ${req.idempotencyKey}, ${req.chain}, ${req.asset}, ${req.to},
              ${req.amount}, 'APPROVED')
      on conflict (user_id, idempotency_key) do nothing
      returning *`;
    if (!row) return replay(tx, req);
    const w = rowToWithdrawal(row);
    const a = ledgerAsset(w.chain, w.asset);
    // Serialises this user's requests for the asset, so the 24-hour sum below cannot be raced.
    await lockAccount(tx, acct.user(w.userId, a), a);

    const p = deps.policy(w.chain, w.asset);
    const listed = await tx`
      select 1 from allowlist where user_id = ${w.userId} and chain = ${w.chain} and address = ${w.to}`;
    const reason =
      checkRequest(p, {
        addressValid: deps.validateAddress(w.chain, w.to),
        allowlisted: listed.length > 0,
        amount: w.amount,
        recent24h: await recentTotal(tx, w),
      }) ?? (await placeHold(tx, w, a));

    if (reason) return setState(tx, w.id, 'APPROVED', 'REJECTED', reason);
    if (needsApproval(p, w.amount))
      return setState(tx, w.id, 'APPROVED', 'AWAITING_APPROVAL', null);
    return w;
  });
}

export function decideApproval(
  db: Db,
  deps: RequestDeps,
  d: { withdrawalId: string; approverId: string; decision: 'approve' | 'reject' },
): Promise<Withdrawal> {
  return db.begin(async (tx) => {
    const [row] = await tx`select * from withdrawals where id = ${d.withdrawalId} for update`;
    if (!row) throw new Error(`withdrawal ${d.withdrawalId} not found`);
    const w = rowToWithdrawal(row);
    if (w.state !== 'AWAITING_APPROVAL') return w;
    const p = deps.policy(w.chain, w.asset);
    if (!canApprove(p, d.approverId, w.userId)) {
      throw new NotAnApprover(`${d.approverId} cannot decide withdrawal ${w.id}`);
    }

    const inserted = await tx`
      insert into approvals (withdrawal_id, approver_id, decision)
      values (${w.id}, ${d.approverId}, ${d.decision})
      on conflict do nothing`;
    if (inserted.count === 0) return w; // this approver already decided; the first decision stands

    if (d.decision === 'reject') {
      const a = ledgerAsset(w.chain, w.asset);
      await post(tx, `release:${w.id}`, 'release', a, [
        { account: acct.inFlight(a), side: 'debit', amount: w.amount },
        { account: acct.user(w.userId, a), side: 'credit', amount: w.amount },
      ]);
      return setState(tx, w.id, 'AWAITING_APPROVAL', 'REJECTED', 'rejected_by_approver');
    }
    const [c] = await tx<{ n: number }[]>`
      select count(*)::int as n from approvals where withdrawal_id = ${w.id} and decision = 'approve'`;
    if ((c?.n ?? 0) < p.approvalsRequired) return w;
    return setState(tx, w.id, 'AWAITING_APPROVAL', 'APPROVED', null);
  });
}
