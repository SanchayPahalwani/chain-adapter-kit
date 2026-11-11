import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acct,
  balance,
  InsufficientFunds,
  ledgerAsset,
  post,
  type Line,
} from '../src/pipeline/ledger.js';
import { createTestDb } from './helpers/test-db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const A = ledgerAsset('evm-anvil', 'native');
const fund = (user: string, n: bigint): Line[] => [
  { account: acct.custody(A), side: 'debit', amount: n },
  { account: acct.user(user, A), side: 'credit', amount: n },
];
// A hold moves money from the user's balance to withdrawals in flight.
const hold = (user: string, n: bigint): Line[] => [
  { account: acct.user(user, A), side: 'debit', amount: n },
  { account: acct.inFlight(A), side: 'credit', amount: n },
];

describe('ledger', () => {
  it('L1 a balanced posting moves both balances', async () => {
    const lines: Line[] = [
      { account: acct.custody(A), side: 'debit', amount: 100n },
      { account: acct.platform(A), side: 'credit', amount: 100n },
    ];
    expect(await t.db.begin((tx) => post(tx, 'fund:1', 'fund', A, lines))).toBe(true);
    expect(await balance(t.db, acct.custody(A))).toBe(100n);
    expect(await balance(t.db, acct.platform(A))).toBe(100n);
    expect(await balance(t.db, 'user:nobody:x')).toBe(0n);
  });

  it('L2 an unbalanced posting throws and writes nothing', async () => {
    const lines: Line[] = [
      { account: acct.custody(A), side: 'debit', amount: 100n },
      { account: acct.platform(A), side: 'credit', amount: 99n },
    ];
    await expect(t.db.begin((tx) => post(tx, 'bad:2', 'fund', A, lines))).rejects.toThrow(
      /balance/,
    );
    const [row] = await t.db`select count(*)::int as n from ledger_txs where ref = 'bad:2'`;
    expect(row?.n).toBe(0);
    expect(await balance(t.db, acct.custody(A))).toBe(100n);
  });

  it('L3 the same ref posts once', async () => {
    const first = await t.db.begin((tx) => post(tx, 'fund:3', 'fund', A, fund('u3', 50n)));
    const second = await t.db.begin((tx) => post(tx, 'fund:3', 'fund', A, fund('u3', 50n)));
    expect([first, second]).toEqual([true, false]);
    expect(await balance(t.db, acct.user('u3', A))).toBe(50n);
    const [row] = await t.db`select count(*)::int as n from ledger_txs where ref = 'fund:3'`;
    expect(row?.n).toBe(1);
  });

  it('L4 an overdraft throws InsufficientFunds and the transaction rolls back', async () => {
    await t.db.begin((tx) => post(tx, 'fund:4', 'fund', A, fund('u4', 100n)));
    const err = await t.db
      .begin((tx) => post(tx, 'hold:4', 'hold', A, hold('u4', 150n)))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFunds);
    expect((err as InsufficientFunds).account).toBe(acct.user('u4', A));
    expect(await balance(t.db, acct.user('u4', A))).toBe(100n);
    expect(await balance(t.db, acct.inFlight(A))).toBe(0n);
    const [row] = await t.db`select count(*)::int as n from ledger_txs where ref = 'hold:4'`;
    expect(row?.n).toBe(0);
  });

  it('L5 concurrent holds cannot overdraw', async () => {
    await t.db.begin((tx) => post(tx, 'fund:5', 'fund', A, fund('u5', 100n)));
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        t.db.begin(async (tx) => {
          const ok = await post(tx, `hold:5:${i}`, 'hold', A, hold('u5', 30n));
          await new Promise((r) => setTimeout(r, 30)); // keep the row locks so the transactions overlap
          return ok;
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    expect(ok).toHaveLength(3);
    expect(failed).toHaveLength(7);
    for (const e of failed) expect(e).toBeInstanceOf(InsufficientFunds);
    expect(await balance(t.db, acct.user('u5', A))).toBe(10n);
    expect(await balance(t.db, acct.inFlight(A))).toBe(90n);
  });

  it('L5b the same ref posted at once ends with one posting', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.db.begin(async (tx) => {
          const ok = await post(tx, 'fund:5b', 'fund', A, fund('u5b', 7n));
          await new Promise((r) => setTimeout(r, 20));
          return ok;
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await balance(t.db, acct.user('u5b', A))).toBe(7n);
  });

  it('L5c postings that touch the same accounts in opposite line order do not deadlock', async () => {
    await t.db.begin((tx) => post(tx, 'fund:5c', 'fund', A, fund('u5c', 1000n)));
    const flip = (i: number): Line[] => {
      const l = hold('u5c', 1n);
      return i % 2 === 0 ? l : l.reverse();
    };
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        t.db.begin((tx) => post(tx, `hold:5c:${i}`, 'hold', A, flip(i))),
      ),
    );
    expect(await balance(t.db, acct.user('u5c', A))).toBe(990n);
  });

  it('L6 amounts above 2^64 are exact', async () => {
    const n = 10n ** 30n + 1n;
    await t.db.begin((tx) => post(tx, 'fund:6', 'fund', A, fund('u6', n)));
    expect(await balance(t.db, acct.user('u6', A))).toBe(n);
  });

  it('L7 the journal agrees with the balances', async () => {
    await t.db.begin((tx) => post(tx, 'fund:7', 'fund', A, fund('u7', 500n)));
    await t.db.begin((tx) => post(tx, 'hold:7', 'hold', A, hold('u7', 200n)));
    await t.db.begin((tx) =>
      post(tx, 'settle:7', 'settle', A, [
        { account: acct.inFlight(A), side: 'debit', amount: 150n },
        { account: acct.custody(A), side: 'credit', amount: 150n },
      ]),
    );
    const rows = await t.db<{ name: string; balance: bigint; journal: bigint }[]>`
      select a.name, a.balance,
             coalesce(sum(case when e.side = a.normal_side then e.amount else -e.amount end), 0) as journal
      from ledger_accounts a left join ledger_entries e on e.account = a.name
      group by a.name, a.balance`;
    expect(rows.length).toBeGreaterThan(3);
    for (const r of rows) expect([r.name, r.journal]).toEqual([r.name, r.balance]);
  });
});
