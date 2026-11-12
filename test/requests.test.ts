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
import { createTestDb } from '../scripts/lib/sandbox.js';

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

let funding = 0;
async function fund(user: string, n: bigint): Promise<void> {
  const ok = await t.db.begin((tx) =>
    post(tx, `fund:${user}:${++funding}`, 'fund', A, [
      { account: acct.custody(A), side: 'debit', amount: n },
      { account: acct.user(user, A), side: 'credit', amount: n },
    ]),
  );
  expect(ok).toBe(true);
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
const decide = (
  withdrawalId: string,
  approverId: string,
  decision: 'approve' | 'reject',
  using: RequestDeps = deps,
) => decideApproval(t.db, using, { withdrawalId, approverId, decision });
const withPolicy = (p: Partial<AssetPolicy>): RequestDeps => ({
  ...deps,
  policy: () => ({ ...policy, ...p }),
});
const userBal = (u = 'alice') => balance(t.db, acct.user(u, A));
const inFlight = () => balance(t.db, acct.inFlight(A));
async function count(sqlTable: 'withdrawals' | 'approvals' | 'ledger_txs'): Promise<number> {
  const [row] = await t.db<{ n: number }[]>`select count(*)::int as n from ${t.db(sqlTable)}`;
  return row?.n ?? -1;
}
// Holds the withdrawal's row lock until release() is called, so decisions started meanwhile
// queue on the row and then contend for it at the same moment.
async function lockRow(id: string): Promise<{ release(): Promise<void> }> {
  let locked!: () => void;
  let unlock!: () => void;
  const ready = new Promise<void>((r) => (locked = r));
  const gate = new Promise<void>((r) => (unlock = r));
  const done = t.db.begin(async (tx) => {
    await tx`select 1 from withdrawals where id = ${id} for update`;
    locked();
    await gate;
  });
  await ready;
  return {
    async release() {
      unlock();
      await done;
    },
  };
}
// Resolves once `n` sessions of this test's schema are blocked on a lock.
async function lockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [row] = await t.db<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and datname = current_database()
        and query like '%withdrawals%'`;
    if ((row?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`fewer than ${n} sessions ever waited on a lock`);
}
async function postingKind(ref: string): Promise<string | null> {
  const [row] = await t.db<{ kind: string }[]>`select kind from ledger_txs where ref = ${ref}`;
  return row?.kind ?? null;
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
    expect(await postingKind(`hold:${w.id}`)).toBe('hold');
  });

  it('R2 the same key returns the same withdrawal and holds once', async () => {
    // 300 ends AWAITING_APPROVAL, so a waiter that returned the provisional row would differ
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => submit('k2', 300n)));
    const first = await submit('k2', 300n);
    const second = await submit('k2', 300n);
    const [stored] = concurrent;
    expect(stored?.state).toBe('AWAITING_APPROVAL');
    for (const w of [...concurrent, first, second]) expect(w).toEqual(stored);
    expect(await getWithdrawal(t.db, first.id)).toEqual(stored);
    expect(await count('withdrawals')).toBe(1);
    expect(await userBal()).toBe(1700n);
    expect(await inFlight()).toBe(300n);
  });

  it('R3 rejects an invalid address, and one that is not allowlisted', async () => {
    const bad = await submit('k3a', 100n, { to: '0xBAD' });
    const unlisted = await submit('k3b', 100n, { to: '0xGOOD2' });
    expect([bad.state, bad.rejectReason]).toEqual(['REJECTED', 'invalid_address']);
    expect([unlisted.state, unlisted.rejectReason]).toEqual(['REJECTED', 'not_allowlisted']);
    expect(await postingKind(`hold:${bad.id}`)).toBeNull();
    expect(await postingKind(`hold:${unlisted.id}`)).toBeNull();
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

  it('R6b FAILED withdrawals do not count toward the 24-hour limit; SETTLED ones do', async () => {
    const failed = await submit('k6f', 500n);
    const settled = await submit('k6s', 400n);
    // what the worker leaves: the reverted one FAILED with its hold released, the other SETTLED
    await t.db`update withdrawals set state = 'FAILED' where id = ${failed.id}`;
    await t.db`update withdrawals set state = 'SETTLED' where id = ${settled.id}`;
    const fits = await submit('k6g', 500n); // 400 + 500 of the 1000; with the FAILED one, 1400
    expect([fits.state, fits.rejectReason]).toEqual(['AWAITING_APPROVAL', null]);
    const over = await submit('k6h', 101n); // 400 + 500 + 101
    expect([over.state, over.rejectReason]).toEqual(['REJECTED', 'over_24h_limit']);
    const under = await submit('k6i', 100n); // 400 + 500 + 100
    expect([under.state, under.rejectReason]).toEqual(['APPROVED', null]);
  });

  it('R7 rejects when the balance is short, and writes the rejection', async () => {
    await fund('bob', 50n);
    await allowAddress(t.db, 'bob', CHAIN, '0xGOOD1');
    const w = await submit('k7', 100n, { userId: 'bob' });
    expect([w.state, w.rejectReason]).toEqual(['REJECTED', 'insufficient_funds']);
    expect(await getWithdrawal(t.db, w.id)).toEqual(w);
    expect(await postingKind(`hold:${w.id}`)).toBeNull();
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
    expect(await postingKind(`hold:${at.id}`)).toBe('hold');
    expect(await userBal()).toBe(1401n);
  });

  it('R11 two distinct approvers approve; one approver twice counts once', async () => {
    const w = await submit('k11', 300n);
    expect((await decide(w.id, 'ops1', 'approve')).state).toBe('AWAITING_APPROVAL');
    expect((await decide(w.id, 'ops1', 'approve')).state).toBe('AWAITING_APPROVAL');
    expect((await decide(w.id, 'ops2', 'approve')).state).toBe('APPROVED');
    expect(await count('approvals')).toBe(2);

    // two approvers at once: the row lock orders them, so the second counts the first's vote
    const v = await submit('k11b', 300n);
    const gate = await lockRow(v.id);
    const both = Promise.all([decide(v.id, 'ops1', 'approve'), decide(v.id, 'ops3', 'approve')]);
    await lockWaiters(2);
    await gate.release();
    const states = (await both).map((x) => x.state).sort();
    expect(states).toEqual(['APPROVED', 'AWAITING_APPROVAL']);
    expect(await userBal()).toBe(1400n);
  });

  it('R12 one rejection releases the hold', async () => {
    const w = await submit('k12', 300n);
    await decide(w.id, 'ops1', 'approve');
    const r = await decide(w.id, 'ops2', 'reject');
    expect([r.state, r.rejectReason]).toEqual(['REJECTED', 'rejected_by_approver']);
    expect(await postingKind(`release:${w.id}`)).toBe('release');
    expect(await userBal()).toBe(2000n);
    expect(await inFlight()).toBe(0n);

    // Two rejections at once release once. A request racing them still counts the withdrawal
    // being rejected, since that rejection has not committed: 400 + 400 + 400 > 1000.
    const v = await submit('k12b', 400n);
    await submit('k12c', 400n);
    const gate = await lockRow(v.id);
    const rejections = Promise.all([
      decide(v.id, 'ops1', 'reject'),
      decide(v.id, 'ops3', 'reject'),
    ]);
    await lockWaiters(2);
    const racing = await submit('k12d', 400n);
    await gate.release();
    const [a, b] = await rejections;
    expect([racing.state, racing.rejectReason]).toEqual(['REJECTED', 'over_24h_limit']);
    expect([a.state, b.state]).toEqual(['REJECTED', 'REJECTED']);
    expect(await postingKind(`release:${v.id}`)).toBe('release');
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
    expect(await postingKind(`release:${w.id}`)).toBeNull();
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

  it('R16 an approver who approved can still reject, and the reject ends the withdrawal', async () => {
    const w = await submit('k16', 300n);
    await decide(w.id, 'ops1', 'approve');
    const r = await decide(w.id, 'ops1', 'reject');
    expect([r.state, r.rejectReason]).toEqual(['REJECTED', 'rejected_by_approver']);
    expect(await postingKind(`release:${w.id}`)).toBe('release');
    const rows =
      await t.db`select approver_id, decision from approvals where withdrawal_id = ${w.id}`;
    expect(rows).toEqual([{ approver_id: 'ops1', decision: 'reject' }]);
    expect(await userBal()).toBe(2000n);
    expect(await inFlight()).toBe(0n);
  });

  it('R17 a repeated approve re-evaluates the count after a policy correction', async () => {
    const strict = withPolicy({ approvalsRequired: 3 });
    const w = await submit('k17', 300n);
    await decide(w.id, 'ops1', 'approve', strict);
    expect((await decide(w.id, 'ops2', 'approve', strict)).state).toBe('AWAITING_APPROVAL');
    expect((await decide(w.id, 'ops2', 'approve')).state).toBe('APPROVED');
    expect(await count('approvals')).toBe(2);
  });

  it('R17b an approval by an approver since removed from the policy no longer counts', async () => {
    const w = await submit('k17b', 300n);
    expect((await decide(w.id, 'ops1', 'approve')).state).toBe('AWAITING_APPROVAL');
    const without = withPolicy({ approvers: ['ops2', 'ops3'] }); // ops1 removed, M still 2
    expect((await decide(w.id, 'ops2', 'approve', without)).state).toBe('AWAITING_APPROVAL');
    expect(await count('approvals')).toBe(2);
    expect((await decide(w.id, 'ops3', 'approve', without)).state).toBe('APPROVED');
  });

  it('R18 the same key used by two users gives two withdrawals', async () => {
    await fund('bob', 500n);
    await allowAddress(t.db, 'bob', CHAIN, '0xGOOD1');
    const a = await submit('shared', 100n);
    const b = await submit('shared', 100n, { userId: 'bob' });
    expect(a.id).not.toBe(b.id);
    expect([a.state, b.state]).toEqual(['APPROVED', 'APPROVED']);
    expect(await userBal()).toBe(1900n);
    expect(await userBal('bob')).toBe(400n);
  });

  it('R19 concurrent requests within the 24-hour limit cannot overdraw the balance', async () => {
    await fund('bob', 250n);
    await allowAddress(t.db, 'bob', CHAIN, '0xGOOD1');
    const all = await Promise.all(
      Array.from({ length: 5 }, (_, i) => submit(`k19:${i}`, 100n, { userId: 'bob' })),
    );
    const accepted = all.filter((w) => w.state === 'APPROVED');
    const rejected = all.filter((w) => w.state === 'REJECTED');
    expect(accepted).toHaveLength(2);
    expect(rejected.map((w) => w.rejectReason)).toEqual([
      'insufficient_funds',
      'insufficient_funds',
      'insufficient_funds',
    ]);
    for (const w of rejected) expect(await postingKind(`hold:${w.id}`)).toBeNull();
    expect(await userBal('bob')).toBe(50n);
    expect(await inFlight()).toBe(200n);
  });

  it('R20 an amount of zero or less throws RangeError and does not consume the key', async () => {
    await expect(submit('k20', 0n)).rejects.toThrow(RangeError);
    await expect(submit('k20', -5n)).rejects.toThrow(/amount must be positive/);
    expect(await count('withdrawals')).toBe(0);
    expect((await submit('k20', 100n)).state).toBe('APPROVED');
  });

  it('R21 a bad or unknown policy throws before anything is written', async () => {
    for (const bad of [
      { approvalsRequired: 0 },
      { approvalsRequired: 4 },
      { approvalsRequired: 1.5 },
      { approvalsRequired: Number.NaN },
    ]) {
      const using = withPolicy(bad);
      await expect(submitWithdrawal(t.db, using, req('k21', 300n))).rejects.toThrow(
        /approvalsRequired must be between 1 and the 3 approvers/,
      );
    }
    const twice = withPolicy({ approvers: ['ops1', 'ops2', 'ops1'] });
    await expect(submitWithdrawal(t.db, twice, req('k21', 300n))).rejects.toThrow(
      'approver ops1 is listed more than once',
    );
    const unknown: RequestDeps = {
      ...deps,
      policy: (c, a) => {
        throw new Error(`no policy for ${c}/${a}`);
      },
    };
    await expect(submitWithdrawal(t.db, unknown, req('k21', 300n))).rejects.toThrow(/no policy/);
    expect(await count('withdrawals')).toBe(0);

    const w = await submit('k21', 300n);
    await expect(
      decide(w.id, 'ops1', 'approve', withPolicy({ approvalsRequired: 4 })),
    ).rejects.toThrow(/approvalsRequired/);
    expect(await count('approvals')).toBe(0);
  });

  it('R21b an approve racing a reject ends in one consistent state', async () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const user = `racer${i}`; // own user each round, so the 24-hour limit never interferes
      await fund(user, 500n);
      await allowAddress(t.db, user, CHAIN, '0xGOOD1');
      const w = await submit(`k21b:${i}`, 300n, { userId: user });
      await decide(w.id, 'ops1', 'approve'); // one more approval is needed
      const [approve, reject] = await Promise.all([
        decide(w.id, 'ops2', 'approve'),
        decide(w.id, 'ops3', 'reject'),
      ]);
      expect(approve).toEqual(reject);
      expect(await getWithdrawal(t.db, w.id)).toEqual(approve);
      outcomes.add(approve.state);
      expect(await postingKind(`hold:${w.id}`)).toBe('hold');
      if (approve.state === 'APPROVED') {
        expect(await postingKind(`release:${w.id}`)).toBeNull();
        expect(await userBal(user)).toBe(200n);
      } else {
        expect([approve.state, approve.rejectReason]).toEqual(['REJECTED', 'rejected_by_approver']);
        expect(await postingKind(`release:${w.id}`)).toBe('release');
        expect(await userBal(user)).toBe(500n);
      }
    }
    expect([...outcomes].every((s) => s === 'APPROVED' || s === 'REJECTED')).toBe(true);
  });

  it('R23 a user id with a colon throws before anything is written', async () => {
    // user:a:b:evm-anvil:native would read as user "a" and asset "b:evm-anvil:native"
    await fund('a:b', 500n);
    await allowAddress(t.db, 'a:b', CHAIN, '0xGOOD1');
    await expect(submit('k23', 100n, { userId: 'a:b' })).rejects.toThrow(
      `user id "a:b" contains ':', which account names use`,
    );
    expect(await count('withdrawals')).toBe(0);
  });

  it('R22 a decision on an unknown or malformed withdrawal id throws a clear error', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    await expect(decide(missing, 'ops1', 'approve')).rejects.toThrow(
      `withdrawal ${missing} not found`,
    );
    await expect(decide('nope', 'ops1', 'approve')).rejects.toThrow(
      '"nope" is not a withdrawal id',
    );
    await expect(getWithdrawal(t.db, 'nope')).rejects.toThrow('"nope" is not a withdrawal id');
    expect(await count('approvals')).toBe(0);
  });
});
