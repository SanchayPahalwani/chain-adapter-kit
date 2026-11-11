import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { connect, migrate } from '../src/pipeline/db.js';
import { pgInputStore } from '../src/pipeline/input-store.js';
import { createTestDb } from './helpers/test-db.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const holder = '00000000-0000-0000-0000-000000000001';

describe('pg input store', () => {
  it('I1 the migration applies to a fresh schema and is a no-op the second time', async () => {
    const before = await t.db<
      { name: string; applied_at: Date }[]
    >`select name, applied_at from schema_migrations`;
    expect(before.map((r) => r.name)).toEqual(['001_init.sql']);
    await migrate(t.db);
    const after = await t.db`select name, applied_at from schema_migrations`;
    expect(after).toEqual(before);
    const [row] = await t.db`select current_schema() as s`;
    expect(row?.s).toBe(t.schema);
  });

  it('I2 numeric(78,0) round-trips as bigint', async () => {
    const big = 10n ** 77n;
    await t.db`insert into chain_sequences (key, next) values ('i2', ${big})`;
    const [row] = await t.db`select next from chain_sequences where key = 'i2'`;
    expect(row?.next === big).toBe(true);
  });

  it('I3 nextSequence: 20 concurrent transactions get 20 distinct consecutive values', async () => {
    await pgInputStore(t.db, holder).seedSequence('i3', 100n);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        t.db.begin(async (tx) => {
          const v = await pgInputStore(tx, holder).nextSequence('i3');
          const [p] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          await new Promise((r) => setTimeout(r, 20)); // hold the row lock so takers really overlap
          return { v, pid: p?.pid };
        }),
      ),
    );
    expect(new Set(results.map((r) => r.pid)).size).toBeGreaterThan(1);
    expect(results.map((r) => r.v).sort((a, b) => (a < b ? -1 : 1))).toEqual(
      Array.from({ length: 20 }, (_, i) => 100n + BigInt(i)),
    );
    const [row] = await t.db`select next from chain_sequences where key = 'i3'`;
    expect(row?.next).toBe(120n);
  });

  it('I4 a rolled-back transaction returns its sequence value', async () => {
    await pgInputStore(t.db, holder).seedSequence('i4', 5n);
    let aTookIt!: () => void;
    const aReady = new Promise<void>((r) => (aTookIt = r));
    let abortA!: () => void;
    const aGate = new Promise<void>((r) => (abortA = r));

    const a = t.db.begin(async (tx) => {
      expect(await pgInputStore(tx, holder).nextSequence('i4')).toBe(5n);
      aTookIt();
      await aGate;
      throw new Error('abort');
    });
    a.catch(() => undefined); // checked below; this keeps an early failure from going unhandled
    await Promise.race([aReady, a]); // if A fails before the gate, its own error ends the test here

    // B asks while A holds the row lock
    let bPid: number | undefined;
    let bFailed = false;
    const b = t.db.begin(async (tx) => {
      const [p] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      bPid = p?.pid;
      return pgInputStore(tx, holder).nextSequence('i4');
    });
    b.catch(() => {
      bFailed = true;
      abortA(); // do not leave A open if B failed
    });
    for (let i = 0; ; i++) {
      if (bFailed) await b; // fails the test now with B's own error
      if (bPid !== undefined) {
        const waiting = await t.db`select 1 from pg_locks where not granted and pid = ${bPid}`;
        if (waiting.length > 0) break;
      }
      if (i > 200) throw new Error('B never blocked behind A');
      await new Promise((r) => setTimeout(r, 25));
    }
    abortA();
    await expect(a).rejects.toThrow('abort');
    expect(await b).toBe(5n);
    await expect(pgInputStore(t.db, holder).nextSequence('never')).rejects.toThrow(/never seeded/);
  });

  it('I5 seedSequence does not move an existing counter', async () => {
    const store = pgInputStore(t.db, holder);
    await store.seedSequence('i5', 7n);
    expect(await store.nextSequence('i5')).toBe(7n);
    await store.seedSequence('i5', 1n);
    expect(await store.nextSequence('i5')).toBe(8n);
  });

  it('I6 freeCoins skips coins locked by a concurrent transaction', async () => {
    const coin = (id: string, amount: bigint) => ({
      id,
      owner: 'i6',
      amount,
      data: { vout: 1, nested: { a: [1, 'x', null] } },
    });
    await pgInputStore(t.db, holder).putCoins([coin('c1', 50n), coin('c2', 10n ** 30n)]);
    await pgInputStore(t.db, holder).putCoins([coin('c1', 999n)]); // insert if absent

    let aHasCoins!: () => void;
    const aReady = new Promise<void>((r) => (aHasCoins = r));
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => (releaseA = r));

    const a = t.db.begin(async (tx) => {
      const mine = await pgInputStore(tx, holder).freeCoins('i6');
      aHasCoins();
      await aGate; // A's transaction stays open until B has finished
      return mine;
    });
    await Promise.race([aReady, a]); // if A fails before the gate, surface its error now
    const seenByB = await t.db.begin((tx) => pgInputStore(tx, holder).freeCoins('i6'));
    releaseA();
    const seenByA = await a;

    expect(seenByB).toEqual([]);
    expect(seenByA).toEqual([coin('c2', 10n ** 30n), coin('c1', 50n)]); // largest first, exact round-trip
    // once A has finished the coins are free again
    expect((await pgInputStore(t.db, holder).freeCoins('i6')).length).toBe(2);
  });

  it('I7 reserveCoins marks the holder; a second reservation of the same coin throws', async () => {
    const store = pgInputStore(t.db, holder);
    await store.putCoins([
      { id: 'r1', owner: 'i7', amount: 1n, data: {} },
      { id: 'r2', owner: 'i7', amount: 2n, data: {} },
    ]);
    await store.reserveCoins(['r1']);
    const [row] = await t.db`select reserved_by from chain_coins where id = 'r1'`;
    expect(row?.reserved_by).toBe(holder);
    await expect(store.reserveCoins(['nope'])).rejects.toThrow(/could not reserve all of nope/);
    await expect(pgInputStore(t.db, 'other').reserveCoins(['r1', 'r2'])).rejects.toThrow(/r1/);
    expect((await store.freeCoins('i7')).map((c) => c.id)).toEqual(['r2']);
  });

  it('I7b a failed reserveCoins reserves nothing, on a pool or in a caught transaction', async () => {
    const store = pgInputStore(t.db, holder);
    const free = async () => (await store.freeCoins('i7b')).map((c) => c.id).sort();
    await store.putCoins(
      ['d1', 'd2', 'd3'].map((id) => ({ id, owner: 'i7b', amount: 1n, data: {} })),
    );
    await store.reserveCoins(['d3']);

    // (a) bare pool: d1 is free, d3 is taken
    await expect(store.reserveCoins(['d1', 'd3'])).rejects.toThrow(
      /could not reserve all of d1, d3/,
    );
    expect(await free()).toEqual(['d1', 'd2']);

    // (b) the caller catches the error and commits anyway
    await t.db.begin(async (tx) => {
      await expect(pgInputStore(tx, holder).reserveCoins(['d2', 'd3'])).rejects.toThrow(
        /could not reserve all of d2, d3/,
      );
    });
    expect(await free()).toEqual(['d1', 'd2']);

    // (c) duplicate ids
    await expect(store.reserveCoins(['d1', 'd1'])).rejects.toThrow(/d1/);
    expect(await free()).toEqual(['d1', 'd2']);
  });

  it('I8 two concurrent migrate calls on one fresh schema both succeed', async () => {
    const schema = `t_${randomBytes(6).toString('hex')}`;
    const admin = connect(config.databaseUrl);
    const p1 = connect(config.databaseUrl, schema);
    const p2 = connect(config.databaseUrl, schema);
    try {
      await admin`create schema ${admin(schema)}`;
      await Promise.all([migrate(p1), migrate(p2)]);
      const tables = await admin`
        select table_name from information_schema.tables
        where table_schema = ${schema} and table_name in ('withdrawals', 'schema_migrations')`;
      expect(tables.length).toBe(2);
      const applied = await p1`select name from schema_migrations`;
      expect(applied.length).toBe(1);
    } finally {
      // each step runs even if the one before it rejects
      try {
        await p1.end({ timeout: 5 });
      } finally {
        try {
          await p2.end({ timeout: 5 });
        } finally {
          try {
            await admin`drop schema if exists ${admin(schema)} cascade`;
          } finally {
            await admin.end({ timeout: 5 });
          }
        }
      }
    }
  });
});
