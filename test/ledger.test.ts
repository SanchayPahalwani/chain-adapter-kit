import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  acct,
  balance,
  InsufficientFunds,
  ledgerAsset,
  lockAccount,
  post,
  type Line,
} from '../src/pipeline/ledger.js';
import { createTestDb } from '../scripts/lib/sandbox.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

// Every test uses its own asset, so any one of them passes when run alone.
const asset = (name: string) => ledgerAsset('evm-anvil', name);
const fund = (user: string, a: string, n: bigint): Line[] => [
  { account: acct.custody(a), side: 'debit', amount: n },
  { account: acct.user(user, a), side: 'credit', amount: n },
];
// A hold moves money from the user's balance to withdrawals in flight.
const hold = (user: string, a: string, n: bigint): Line[] => [
  { account: acct.user(user, a), side: 'debit', amount: n },
  { account: acct.inFlight(a), side: 'credit', amount: n },
];
const txCount = async (ref: string) => {
  const [row] = await t.db`select count(*)::int as n from ledger_txs where ref = ${ref}`;
  return row?.n as number;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ledger', () => {
  it('L1 a balanced posting moves both balances', async () => {
    const a = asset('l1');
    const lines: Line[] = [
      { account: acct.custody(a), side: 'debit', amount: 100n },
      { account: acct.platform(a), side: 'credit', amount: 100n },
    ];
    expect(await t.db.begin((tx) => post(tx, 'l1', 'fund', a, lines))).toBe(true);
    expect(await balance(t.db, acct.custody(a))).toBe(100n);
    expect(await balance(t.db, acct.platform(a))).toBe(100n);
    expect(await balance(t.db, acct.user('nobody', a))).toBe(0n);
  });

  it('L2 a bad posting throws and writes nothing', async () => {
    const a = asset('l2');
    const wrongAsset = asset('l2-other');
    const cases: [string, Line[], RegExp][] = [
      [
        'unbalanced',
        [
          { account: acct.custody(a), side: 'debit', amount: 100n },
          { account: acct.platform(a), side: 'credit', amount: 99n },
        ],
        /does not balance/,
      ],
      ['no lines', [], /no lines/],
      ['zero amount', fund('u', a, 0n), /positive/],
      ['negative amount', fund('u', a, -5n), /positive/],
      [
        'unknown prefix',
        [{ account: `bogus:${a}`, side: 'debit', amount: 1n }, ...hold('u', a, 1n).slice(1)],
        /unknown ledger account/,
      ],
      [
        'wrong asset',
        [
          ...fund('u', a, 5n).slice(0, 1),
          { account: acct.user('u', wrongAsset), side: 'credit', amount: 5n },
        ],
        /is not an/,
      ],
    ];
    for (const [name, lines, message] of cases) {
      // the caller catches the error and commits anyway: nothing may have been written
      const caught = await t.db.begin(async (tx) => {
        try {
          await post(tx, `l2:${name}`, 'x', a, lines);
        } catch (e) {
          return e as Error;
        }
        return undefined;
      });
      expect(caught?.message, name).toMatch(message);
      expect(await txCount(`l2:${name}`), name).toBe(0);
    }
    const [row] =
      await t.db`select count(*)::int as n from ledger_accounts where asset in (${a}, ${wrongAsset})`;
    expect(row?.n).toBe(0);
  });

  it('L3 the same ref posts once', async () => {
    const a = asset('l3');
    const first = await t.db.begin((tx) => post(tx, 'l3', 'fund', a, fund('u3', a, 50n)));
    const second = await t.db.begin((tx) => post(tx, 'l3', 'fund', a, fund('u3', a, 50n)));
    expect([first, second]).toEqual([true, false]);
    expect(await balance(t.db, acct.user('u3', a))).toBe(50n);
    expect(await txCount('l3')).toBe(1);
  });

  it('L4 an overdraft throws InsufficientFunds and the transaction rolls back', async () => {
    const a = asset('l4');
    await t.db.begin((tx) => post(tx, 'l4:fund', 'fund', a, fund('u4', a, 100n)));
    const err = await t.db
      .begin((tx) => post(tx, 'l4:hold', 'hold', a, hold('u4', a, 150n)))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientFunds);
    expect((err as InsufficientFunds).account).toBe(acct.user('u4', a));
    expect((err as InsufficientFunds).name).toBe('InsufficientFunds');
    expect(await balance(t.db, acct.user('u4', a))).toBe(100n);
    expect(await balance(t.db, acct.inFlight(a))).toBe(0n);
    expect(await txCount('l4:hold')).toBe(0);
  });

  it('L5 concurrent holds cannot overdraw', async () => {
    const a = asset('l5');
    await t.db.begin((tx) => post(tx, 'l5:fund', 'fund', a, fund('u5', a, 100n)));
    const pids = new Set<number | undefined>();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        t.db.begin(async (tx) => {
          const [p] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          pids.add(p?.pid);
          const ok = await post(tx, `l5:${i}`, 'hold', a, hold('u5', a, 30n));
          await sleep(30); // keep the row locks so the transactions overlap
          return ok;
        }),
      ),
    );
    const failed = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    expect(results.length - failed.length).toBe(3);
    for (const e of failed) expect(e).toBeInstanceOf(InsufficientFunds);
    expect(pids.size).toBeGreaterThan(1);
    expect(await balance(t.db, acct.user('u5', a))).toBe(10n);
    expect(await balance(t.db, acct.inFlight(a))).toBe(90n);
  });

  it('L5b the same ref posted at once ends with one posting', async () => {
    const a = asset('l5b');
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        t.db.begin(async (tx) => {
          const ok = await post(tx, 'l5b', 'fund', a, fund('u', a, 7n));
          await sleep(20);
          return ok;
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await balance(t.db, acct.user('u', a))).toBe(7n);
  });

  it('L5c postings on the same accounts in opposite line order do not deadlock', async () => {
    const a = asset('l5c');
    await t.db.begin((tx) => post(tx, 'l5c:fund', 'fund', a, fund('u', a, 1000n)));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        t.db.begin(async (tx) => {
          const lines = hold('u', a, 1n);
          await post(tx, `l5c:${i}`, 'hold', a, i % 2 === 0 ? lines : lines.reverse());
          await sleep(10);
        }),
      ),
    );
    expect(await balance(t.db, acct.user('u', a))).toBe(990n);
  });

  it('L5d accounts created at once by different transactions all post', async () => {
    const a = asset('l5d');
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        t.db.begin(async (tx) => {
          const ok = await post(tx, `l5d:${i}`, 'fund', a, fund(`u${i % 2}`, a, 10n));
          await sleep(20); // hold the new rows uncommitted so the others queue behind them
          return ok;
        }),
      ),
    );
    expect(results).toEqual(Array(8).fill(true));
    expect(await balance(t.db, acct.custody(a))).toBe(80n);
    expect(await balance(t.db, acct.user('u0', a))).toBe(40n);
    expect(await balance(t.db, acct.user('u1', a))).toBe(40n);
  });

  it('L5e lockAccount creates a missing account', async () => {
    const a = asset('l5e');
    const user = acct.user('fresh', a);
    await t.db.begin((tx) => lockAccount(tx, user, a));
    const rows = await t.db`select balance, normal_side from ledger_accounts where name = ${user}`;
    expect(rows).toEqual([{ balance: 0n, normal_side: 'credit' }]);
    await expect(t.db.begin((tx) => lockAccount(tx, user, asset('l5e-other')))).rejects.toThrow(
      /is not an/,
    );
  });

  it('L5f lockAccount holds the row lock until its transaction ends', async () => {
    const a = asset('l5f');
    const user = acct.user('u', a);
    // the row exists and is committed
    await t.db.begin((tx) => post(tx, 'l5f:fund', 'fund', a, fund('u', a, 10n)));
    let locked!: () => void;
    const aReady = new Promise<void>((r) => (locked = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holder = t.db.begin(async (tx) => {
      await lockAccount(tx, user, a);
      locked();
      await gate;
    });
    await Promise.race([aReady, holder]);

    let bPid: number | undefined;
    let postDone = false;
    let posterFailed = false;
    const poster = t.db.begin(async (tx) => {
      const [p] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      bPid = p?.pid;
      return post(tx, 'l5f:fund2', 'fund', a, fund('u', a, 5n));
    });
    const posterDone = poster.then(
      (ok) => ((postDone = true), ok),
      (e: unknown) => {
        posterFailed = true;
        release(); // do not leave the holder open if the poster failed
        throw e;
      },
    );
    // awaited below; this keeps an early failure from going unhandled meanwhile
    posterDone.catch(() => undefined);
    for (let i = 0; ; i++) {
      if (posterFailed) await posterDone; // fails the test now with the poster's own error
      if (bPid !== undefined) {
        const waiting = await t.db`select 1 from pg_locks where not granted and pid = ${bPid}`;
        if (waiting.length > 0) break;
      }
      if (i > 200) throw new Error('the post never blocked behind lockAccount');
      await sleep(25);
    }
    expect(postDone).toBe(false);
    release();
    await holder;
    expect(await posterDone).toBe(true);
    expect(await balance(t.db, user)).toBe(15n);
  });

  it('L6 amounts above 2^64 are exact', async () => {
    const a = asset('l6');
    const n = 10n ** 30n + 1n;
    await t.db.begin((tx) => post(tx, 'l6', 'fund', a, fund('u', a, n)));
    expect(await balance(t.db, acct.user('u', a))).toBe(n);
  });

  it('L7 the journal agrees with the balances', async () => {
    const a = asset('l7');
    await t.db.begin((tx) => post(tx, 'l7:fund', 'fund', a, fund('u', a, 500n)));
    await t.db.begin((tx) => post(tx, 'l7:hold', 'hold', a, hold('u', a, 200n)));
    await t.db.begin((tx) =>
      post(tx, 'l7:settle', 'settle', a, [
        { account: acct.inFlight(a), side: 'debit', amount: 150n },
        { account: acct.custody(a), side: 'credit', amount: 150n },
      ]),
    );
    await t.db.begin((tx) =>
      post(tx, 'l7:fee', 'fee', a, [
        { account: acct.networkFees(a), side: 'debit', amount: 3n },
        { account: acct.inFlight(a), side: 'credit', amount: 3n },
      ]),
    );
    // two lines on one account: custody +10 and -4 in a single posting
    await t.db.begin((tx) =>
      post(tx, 'l7:two', 'x', a, [
        { account: acct.custody(a), side: 'debit', amount: 10n },
        { account: acct.custody(a), side: 'credit', amount: 4n },
        { account: acct.platform(a), side: 'credit', amount: 6n },
      ]),
    );
    expect(await balance(t.db, acct.networkFees(a))).toBe(3n);
    expect(await balance(t.db, acct.custody(a))).toBe(500n - 150n + 6n);
    const rows = await t.db<{ name: string; balance: bigint; journal: bigint }[]>`
      select a.name, a.balance,
             coalesce(sum(case when e.side = a.normal_side then e.amount else -e.amount end), 0)
               as journal
      from ledger_accounts a left join ledger_entries e on e.account = a.name
      group by a.name, a.balance`;
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) expect([r.name, r.journal]).toEqual([r.name, r.balance]);
  });
});
