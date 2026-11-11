import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acct, balance, ledgerAsset, post } from '../src/pipeline/ledger.js';
import type { AssetPolicy } from '../src/pipeline/policy.js';
import {
  allowAddress,
  decideApproval,
  getWithdrawal,
  IdempotencyKeyReuse,
  NotAnApprover,
  submitWithdrawal,
  type RequestDeps,
  type WithdrawalRequest,
} from '../src/pipeline/requests.js';
import { createTestDb } from './helpers/test-db.js';

// A fresh schema per test, so the shared in-flight account starts at 0 every time.
let t: Awaited<ReturnType<typeof createTestDb>>;
beforeEach(async () => {
  t = await createTestDb();
  await fund('alice', 2000n);
  await allowAddress(t.db, 'alice', CHAIN, '0xGOOD1');
});
afterEach(async () => {
  await t.close();
});

const CHAIN = 'evm-anvil';
const ASSET = 'native';
const A = ledgerAsset(CHAIN, ASSET);
const policy: AssetPolicy = {
  perWithdrawalMax: 500n,
  rolling24hMax: 1000n,
  approvalThreshold: 300n,
  approvalsRequired: 2,
  approvers: ['ops1', 'ops2', 'ops3'],
};
const deps: RequestDeps = {
  policy: () => policy,
  validateAddress: (_c, a) => a.startsWith('0xGOOD'),
};

async function fund(user: string, n: bigint): Promise<void> {
  await t.db.begin((tx) =>
    post(tx, `fund:${user}`, 'fund', A, [
      { account: acct.custody(A), side: 'debit', amount: n },
      { account: acct.user(user, A), side: 'credit', amount: n },
    ]),
  );
}
const req = (key: string, amount: bigint, over: Partial<WithdrawalRequest> = {}) => ({
  idempotencyKey: key,
  userId: 'alice',
  chain: CHAIN,
  asset: ASSET,
  to: '0xGOOD1',
  amount,
  ...over,
});
const submit = (key: string, amount: bigint, over: Partial<WithdrawalRequest> = {}) =>
  submitWithdrawal(t.db, deps, req(key, amount, over));
const decide = (withdrawalId: string, approverId: string, decision: 'approve' | 'reject') =>
  decideApproval(t.db, deps, { withdrawalId, approverId, decision });
const userBal = (u = 'alice') => balance(t.db, acct.user(u, A));
const inFlight = () => balance(t.db, acct.inFlight(A));
async function count(sqlTable: 'withdrawals' | 'approvals' | 'ledger_txs'): Promise<number> {
  const [row] = await t.db<{ n: number }[]>`select count(*)::int as n from ${t.db(sqlTable)}`;
  return row?.n ?? -1;
}
// Holds the withdrawal's row lock for `ms`, so decisions started meanwhile all pass their own
// start-up and then contend for the row at the same moment.
async function lockRowFor(id: string, ms: number): Promise<{ done: Promise<unknown> }> {
  let locked!: () => void;
  const ready = new Promise<void>((r) => (locked = r));
  const done = t.db.begin(async (tx) => {
    await tx`select 1 from withdrawals where id = ${id} for update`;
    locked();
    await new Promise((r) => setTimeout(r, ms));
  });
  await ready;
  return { done };
}
async function posted(ref: string): Promise<boolean> {
  const rows = await t.db`select 1 from ledger_txs where ref = ${ref}`;
  return rows.length === 1;
}

describe('withdrawal requests', () => {
  it('R1 a small request is APPROVED and the hold is posted', async () => {
    const w = await submit('k1', 100n);
    expect(w).toMatchObject({
      userId: 'alice',
      idempotencyKey: 'k1',
      chain: CHAIN,
      asset: ASSET,
      to: '0xGOOD1',
      amount: 100n,
      state: 'APPROVED',
      rejectReason: null,
      fee: null,
      reservation: null,
      settledTxid: null,
    });
    expect(await getWithdrawal(t.db, w.id)).toEqual(w);
    expect(await userBal()).toBe(1900n);
    expect(await inFlight()).toBe(100n);
    expect(await posted(`hold:${w.id}`)).toBe(true);
  });

  it('R2 the same key returns the same withdrawal and holds once', async () => {
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => submit('k2', 100n)));
    const first = await submit('k2', 100n);
    const second = await submit('k2', 100n);
    const ids = new Set([...concurrent, first, second].map((w) => w.id));
    expect(ids.size).toBe(1);
    expect(second).toEqual(first);
    expect(await count('withdrawals')).toBe(1);
    expect(await userBal()).toBe(1900n);
    expect(await inFlight()).toBe(100n);
  });

  it('R3 rejects an invalid address, and one that is not allowlisted', async () => {
    const bad = await submit('k3a', 100n, { to: '0xBAD' });
    const unlisted = await submit('k3b', 100n, { to: '0xGOOD2' });
    expect([bad.state, bad.rejectReason]).toEqual(['REJECTED', 'invalid_address']);
    expect([unlisted.state, unlisted.rejectReason]).toEqual(['REJECTED', 'not_allowlisted']);
    expect(await posted(`hold:${bad.id}`)).toBe(false);
    expect(await posted(`hold:${unlisted.id}`)).toBe(false);
    expect(await userBal()).toBe(2000n);
    expect(await inFlight()).toBe(0n);
  });

  it('R4 rejects above the per-withdrawal limit', async () => {
    const w = await submit('k4', 501n);
    expect([w.state, w.rejectReason]).toEqual(['REJECTED', 'over_withdrawal_limit']);
    expect(await userBal()).toBe(2000n);
    expect((await submit('k4b', 500n)).state).toBe('AWAITING_APPROVAL');
  });

  it('R5 enforces the rolling 24-hour limit', async () => {
    const one = await submit('k5a', 400n);
    const two = await submit('k5b', 400n);
    expect([one.state, two.state]).toEqual(['AWAITING_APPROVAL', 'AWAITING_APPROVAL']);
    const three = await submit('k5c', 400n);
    expect([three.state, three.rejectReason]).toEqual(['REJECTED', 'over_24h_limit']);
    expect(await userBal()).toBe(1200n);

    await t.db`update withdrawals set created_at = now() - interval '25 hours' where id = ${one.id}`;
    const four = await submit('k5d', 400n);
    expect([four.state, four.rejectReason]).toEqual(['AWAITING_APPROVAL', null]);
    expect(await userBal()).toBe(800n);
    expect(await inFlight()).toBe(1200n);
  });

  it('R6 rejected withdrawals do not count toward the 24-hour limit', async () => {
    expect((await submit('k6a', 500n, { to: '0xBAD' })).state).toBe('REJECTED');
    const vetoed = await submit('k6b', 500n);
    expect((await decide(vetoed.id, 'ops1', 'reject')).state).toBe('REJECTED');
    const a = await submit('k6c', 500n);
    const b = await submit('k6d', 500n);
    expect([a.state, b.state]).toEqual(['AWAITING_APPROVAL', 'AWAITING_APPROVAL']);
    const c = await submit('k6e', 1n);
    expect([c.state, c.rejectReason]).toEqual(['REJECTED', 'over_24h_limit']);
    expect(await userBal()).toBe(1000n);
  });

  it('R7 rejects when the balance is short, and writes the rejection', async () => {
    await fund('bob', 50n);
    await allowAddress(t.db, 'bob', CHAIN, '0xGOOD1');
    const w = await submit('k7', 100n, { userId: 'bob' });
    expect([w.state, w.rejectReason]).toEqual(['REJECTED', 'insufficient_funds']);
    expect(await getWithdrawal(t.db, w.id)).toEqual(w);
    expect(await posted(`hold:${w.id}`)).toBe(false);
    expect(await userBal('bob')).toBe(50n);
    expect(await inFlight()).toBe(0n);
  });

  it('R8 a replay of a rejected request returns the same rejection', async () => {
    await allowAddress(t.db, 'bob', CHAIN, '0xGOOD1');
    const first = await submit('k8', 100n, { userId: 'bob' });
    expect(first.rejectReason).toBe('insufficient_funds');
    await fund('bob', 1000n); // the replay must not re-run the checks
    const again = await submit('k8', 100n, { userId: 'bob' });
    expect(again).toEqual(first);
    expect(await userBal('bob')).toBe(1000n);
    expect(await count('withdrawals')).toBe(1);
  });

  it('R9 the same key with different parameters throws IdempotencyKeyReuse', async () => {
    const w = await submit('k9', 100n);
    await expect(submit('k9', 101n)).rejects.toThrow(IdempotencyKeyReuse);
    await allowAddress(t.db, 'alice', CHAIN, '0xGOOD2');
    await expect(submit('k9', 100n, { to: '0xGOOD2' })).rejects.toThrow(IdempotencyKeyReuse);
    await expect(submit('k9', 100n, { asset: 'usdc' })).rejects.toThrow(IdempotencyKeyReuse);
    expect(await getWithdrawal(t.db, w.id)).toEqual(w);
    expect(await count('withdrawals')).toBe(1);
    expect(await userBal()).toBe(1900n);
  });

  it('R10 at or above the threshold waits for approvals', async () => {
    const below = await submit('k10a', 299n);
    const at = await submit('k10b', 300n);
    expect([below.state, at.state]).toEqual(['APPROVED', 'AWAITING_APPROVAL']);
    expect(await posted(`hold:${at.id}`)).toBe(true);
    expect(await userBal()).toBe(1401n);
  });

  it('R11 two distinct approvers approve; one approver twice counts once', async () => {
    const w = await submit('k11', 300n);
    expect((await decide(w.id, 'ops1', 'approve')).state).toBe('AWAITING_APPROVAL');
    expect((await decide(w.id, 'ops1', 'approve')).state).toBe('AWAITING_APPROVAL');
    // one decision per approver: the first one stands
    expect((await decide(w.id, 'ops1', 'reject')).state).toBe('AWAITING_APPROVAL');
    expect((await decide(w.id, 'ops2', 'approve')).state).toBe('APPROVED');
    expect(await count('approvals')).toBe(2);

    // two approvers at once: the row lock orders them, so the second counts the first's vote
    const v = await submit('k11b', 300n);
    const gate = await lockRowFor(v.id, 150);
    const both = Promise.all([decide(v.id, 'ops1', 'approve'), decide(v.id, 'ops3', 'approve')]);
    await gate.done;
    const states = (await both).map((x) => x.state).sort();
    expect(states).toEqual(['APPROVED', 'AWAITING_APPROVAL']);
    expect(await userBal()).toBe(1400n);
  });

  it('R12 one rejection releases the hold', async () => {
    const w = await submit('k12', 300n);
    await decide(w.id, 'ops1', 'approve');
    const r = await decide(w.id, 'ops2', 'reject');
    expect([r.state, r.rejectReason]).toEqual(['REJECTED', 'rejected_by_approver']);
    expect(await posted(`release:${w.id}`)).toBe(true);
    expect(await userBal()).toBe(2000n);
    expect(await inFlight()).toBe(0n);

    // Two rejections at once release once. A request racing them still counts the withdrawal
    // being rejected, since that rejection has not committed: 400 + 400 + 400 > 1000.
    const v = await submit('k12b', 400n);
    await submit('k12c', 400n);
    const gate = await lockRowFor(v.id, 150);
    const rejections = Promise.all([
      decide(v.id, 'ops1', 'reject'),
      decide(v.id, 'ops3', 'reject'),
    ]);
    const racing = await submit('k12d', 400n);
    await gate.done;
    const [a, b] = await rejections;
    expect([racing.state, racing.rejectReason]).toEqual(['REJECTED', 'over_24h_limit']);
    expect([a.state, b.state]).toEqual(['REJECTED', 'REJECTED']);
    expect(await posted(`release:${v.id}`)).toBe(true);
    expect(await userBal()).toBe(1600n);
    expect(await inFlight()).toBe(400n);
  });

  it('R13 the requester and non-approvers cannot approve', async () => {
    await fund('ops3', 1000n);
    await allowAddress(t.db, 'ops3', CHAIN, '0xGOOD1');
    const w = await submit('k13', 300n, { userId: 'ops3' });
    await expect(decide(w.id, 'ops3', 'approve')).rejects.toThrow(NotAnApprover);
    await expect(decide(w.id, 'mallory', 'approve')).rejects.toThrow(NotAnApprover);
    await expect(decide(w.id, 'mallory', 'reject')).rejects.toThrow(NotAnApprover);
    expect(await getWithdrawal(t.db, w.id)).toEqual(w);
    expect(await count('approvals')).toBe(0);
  });

  it('R14 a decision on a withdrawal that already left AWAITING_APPROVAL changes nothing', async () => {
    const w = await submit('k14', 300n);
    await decide(w.id, 'ops1', 'approve');
    const approved = await decide(w.id, 'ops2', 'approve');
    expect(approved.state).toBe('APPROVED');
    expect(await decide(w.id, 'ops3', 'reject')).toEqual(approved);

    const small = await submit('k14b', 100n);
    expect(await decide(small.id, 'ops1', 'reject')).toEqual(small);
    const bad = await submit('k14c', 100n, { to: '0xBAD' });
    expect(await decide(bad.id, 'ops1', 'approve')).toEqual(bad);

    expect(await count('approvals')).toBe(2);
    expect(await posted(`release:${w.id}`)).toBe(false);
    expect(await userBal()).toBe(1600n);
  });

  it('R15 concurrent requests cannot exceed the 24-hour limit', async () => {
    const all = await Promise.all(Array.from({ length: 5 }, (_, i) => submit(`k15:${i}`, 300n)));
    const accepted = all.filter((w) => w.state === 'AWAITING_APPROVAL');
    const rejected = all.filter((w) => w.state === 'REJECTED');
    expect(accepted).toHaveLength(3);
    expect(rejected.map((w) => w.rejectReason)).toEqual(['over_24h_limit', 'over_24h_limit']);
    expect(await userBal()).toBe(1100n);
    expect(await inFlight()).toBe(900n);
  });
});
