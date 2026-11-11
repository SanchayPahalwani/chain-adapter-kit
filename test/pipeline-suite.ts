import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssetId, ChainAdapter, SignedTx } from '../src/core/adapter.js';
import { LocalSigner } from '../src/core/local-signer.js';
import { startMiner, type Devnet } from '../src/conformance/harness.js';
import { noCrash } from '../src/pipeline/crash.js';
import type { Db } from '../src/pipeline/db.js';
import { acct, balance, ledgerAsset, post } from '../src/pipeline/ledger.js';
import type { AssetPolicy } from '../src/pipeline/policy.js';
import {
  allowAddress,
  getWithdrawal,
  submitWithdrawal,
  type RequestDeps,
  type Withdrawal,
  type WithdrawalState,
} from '../src/pipeline/requests.js';
import { handlers, LostRace } from '../src/pipeline/steps.js';
import {
  claim,
  hotWallet,
  runOnce,
  runWorker,
  type ChainRuntime,
  type Timings,
  type WorkerDeps,
} from '../src/pipeline/worker.js';
import { createTestDb } from './helpers/test-db.js';

export interface PipelineEnv {
  chain: string;
  adapter: ChainAdapter;
  devnet: Devnet;
  assets: AssetId[]; // 'native' first
  unit(asset: AssetId): bigint;
  freshAddress(): Promise<string>; // a valid address nobody else uses
  // raise the fee level and keep it raised across blocks:
  // transactions quoted before this no longer confirm, later quotes do
  makeStuck(): Promise<void>;
  clearStuck(): Promise<void>; // back to the normal fee level
}

const GAS = 10n ** 18n; // native the hot wallet holds for fees, booked as the platform's own
const unlimited = 10n ** 40n;
const policy: AssetPolicy = {
  perWithdrawalMax: unlimited,
  rolling24hMax: unlimited,
  approvalThreshold: unlimited, // never asks for approval
  approvalsRequired: 1,
  approvers: ['ops'],
};
export const testTimings: Timings = {
  leaseMs: 1000,
  pollMs: 20,
  stuckAfterMs: 1500,
  retryBaseMs: 20,
  maxAttempts: 5,
};

/** One test's world: a fresh schema, a fresh hot wallet funded on-chain and in the ledger, one user. */
export interface Pipeline {
  db: Db;
  deps: WorkerDeps;
  hot: ChainRuntime;
  userId: string;
  /** A deposit: the user is owed `amount` and the hot wallet holds it on-chain. */
  credit(asset: AssetId, amount: bigint): Promise<void>;
  /** An APPROVED withdrawal to a fresh allowlisted address. */
  withdraw(asset: AssetId, amount: bigint): Promise<Withdrawal>;
  close(): Promise<void>;
}

export async function openPipeline(env: PipelineEnv): Promise<Pipeline> {
  const t = await createTestDb();
  try {
    const signer = LocalSigner.random();
    const hot = await hotWallet(env.adapter, signer);
    const deps: WorkerDeps = {
      db: t.db,
      signer,
      chains: { [env.chain]: hot },
      timings: testTimings,
      crash: noCrash,
    };
    const requestDeps: RequestDeps = {
      policy: () => policy,
      validateAddress: (chain, address) =>
        chain === env.chain && env.adapter.validateAddress(address),
    };
    const userId = `user-${randomUUID()}`;
    const n = ledgerAsset(env.chain, 'native');
    await env.devnet.fund(hot.hotAddress, 'native', GAS);
    await t.db.begin((tx) =>
      post(tx, `fund:${hot.hotAddress}`, 'fund', n, [
        { account: acct.custody(n), side: 'debit', amount: GAS },
        { account: acct.platform(n), side: 'credit', amount: GAS },
      ]),
    );
    let deposits = 0;
    return {
      db: t.db,
      deps,
      hot,
      userId,
      async credit(asset, amount) {
        const a = ledgerAsset(env.chain, asset);
        await t.db.begin((tx) =>
          post(tx, `deposit:${userId}:${++deposits}`, 'deposit', a, [
            { account: acct.custody(a), side: 'debit', amount },
            { account: acct.user(userId, a), side: 'credit', amount },
          ]),
        );
        await env.devnet.fund(hot.hotAddress, asset, amount);
      },
      async withdraw(asset, amount) {
        const to = await env.freshAddress();
        await allowAddress(t.db, userId, env.chain, to);
        const w = await submitWithdrawal(t.db, requestDeps, {
          idempotencyKey: randomUUID(),
          userId,
          chain: env.chain,
          asset,
          to,
          amount,
        });
        if (w.state !== 'APPROVED') throw new Error(`withdrawal is ${w.state}, not APPROVED`);
        return w;
      },
      close: () => t.close(),
    };
  } catch (e) {
    await t.close().catch(() => undefined);
    throw e;
  }
}

async function waitFor(what: string, until: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs; // a test timeout, not part of anything under test
  while (!(await until())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Runs one worker by hand, mining a block after every step, until `until` holds. */
export async function drive(
  deps: WorkerDeps,
  env: PipelineEnv,
  until: () => Promise<boolean>,
  timeoutMs = 20_000,
  workerId = 'driver',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await until())) {
    if (Date.now() > deadline) throw new Error('drive timed out');
    const worked = await runOnce(deps, workerId);
    await env.devnet.mine(1);
    if (!worked) await sleep(deps.timings.pollMs);
  }
}

const terminal = (db: Db, id: string) => async () => {
  const { state } = await getWithdrawal(db, id);
  return state === 'SETTLED' || state === 'FAILED';
};

export async function attemptsOf(db: Db, id: string) {
  return db<{ attempt_no: number; txid: string; raw: string; broadcast_at: Date | null }[]>`
    select attempt_no, txid, raw, broadcast_at from tx_attempts
    where withdrawal_id = ${id} order by attempt_no`;
}

async function feePaid(env: PipelineEnv, txid: string | null): Promise<bigint> {
  if (!txid) throw new Error('no settled txid');
  const status = await env.adapter.getTxStatus(txid);
  if (status.state !== 'confirmed') throw new Error(`${txid} is ${status.state}`);
  return status.feePaid;
}

const withAdapter = (deps: WorkerDeps, chain: string, adapter: ChainAdapter): WorkerDeps => {
  const rt = deps.chains[chain];
  if (!rt) throw new Error(`no runtime for ${chain}`);
  return { ...deps, chains: { ...deps.chains, [chain]: { ...rt, adapter } } };
};

/** Twelve native withdrawals, three concurrent workers and a miner, until all are terminal. */
export async function twelveConcurrent(p: Pipeline, env: PipelineEnv): Promise<Withdrawal[]> {
  const unit = env.unit('native');
  const amounts = Array.from({ length: 12 }, (_, i) => unit + BigInt(i));
  await p.credit(
    'native',
    amounts.reduce((s, a) => s + a, 0n),
  );
  const ws: Withdrawal[] = [];
  for (const amount of amounts) ws.push(await p.withdraw('native', amount));

  const stop = new AbortController();
  const stopMiner = startMiner(env.devnet, 50);
  const workers = ['w1', 'w2', 'w3'].map((id) => runWorker(p.deps, id, stop.signal));
  try {
    await waitFor(
      'twelve terminal withdrawals',
      async () => {
        const [row] = await p.db<{ n: number }[]>`
          select count(*)::int as n from withdrawals where state in ('SETTLED','FAILED')`;
        return row?.n === 12;
      },
      25_000,
    );
  } finally {
    stop.abort();
    await Promise.all(workers);
    await stopMiner();
  }
  return Promise.all(ws.map((w) => getWithdrawal(p.db, w.id)));
}

export function runPipelineSuite(makeEnv: () => Promise<PipelineEnv>): void {
  let env: PipelineEnv;
  let p: Pipeline;
  const native = 'native';
  const n = () => ledgerAsset(env.chain, native);
  const state = async (id: string): Promise<WithdrawalState> =>
    (await getWithdrawal(p.db, id)).state;

  describe('withdrawal pipeline', () => {
    beforeAll(async () => {
      env = await makeEnv();
      expect(env.assets[0]).toBe(native);
    });
    beforeEach(async () => {
      p = await openPipeline(env);
    });
    afterEach(async () => {
      await p.close();
      await env.clearStuck();
    });

    it('P1 a native withdrawal settles and the ledger matches the chain', async () => {
      const amount = env.unit(native);
      await p.credit(native, 5n * amount);
      const w = await p.withdraw(native, amount);
      await drive(p.deps, env, terminal(p.db, w.id));

      const done = await getWithdrawal(p.db, w.id);
      expect(done.state).toBe('SETTLED');
      const fee = await feePaid(env, done.settledTxid);
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
      expect(await balance(p.db, acct.user(p.userId, n()))).toBe(4n * amount);
      expect(await balance(p.db, acct.inFlight(n()))).toBe(0n);
      expect(await balance(p.db, acct.custody(n()))).toBe(GAS + 5n * amount - amount - fee);
      expect(await balance(p.db, acct.custody(n()))).toBe(
        await env.adapter.getBalance(p.hot.hotAddress, native),
      );
      expect(await balance(p.db, acct.networkFees(n()))).toBe(fee);
      const attempts = await attemptsOf(p.db, w.id);
      expect(attempts).toHaveLength(1);
      expect(done.settledTxid).toBe(attempts[0]?.txid);
    });

    it('P2 a token withdrawal of 10n**30n settles; the fee is booked in native', async () => {
      const token = env.assets[1];
      if (!token) throw new Error('the env has no token asset');
      const t = ledgerAsset(env.chain, token);
      const amount = 10n ** 30n;
      await p.credit(token, amount);
      const tokenBefore = await balance(p.db, acct.custody(t));
      const nativeBefore = await balance(p.db, acct.custody(n()));
      const w = await p.withdraw(token, amount);
      await drive(p.deps, env, terminal(p.db, w.id));

      const done = await getWithdrawal(p.db, w.id);
      expect(done.state).toBe('SETTLED');
      const fee = await feePaid(env, done.settledTxid);
      expect(fee).toBeGreaterThan(0n);
      expect(await env.adapter.getBalance(w.to, token)).toBe(amount);
      expect(tokenBefore - (await balance(p.db, acct.custody(t)))).toBe(amount);
      expect(nativeBefore - (await balance(p.db, acct.custody(n())))).toBe(fee);
      expect(await balance(p.db, acct.networkFees(n()))).toBe(fee);
      expect(await balance(p.db, acct.inFlight(t))).toBe(0n);
    });

    it('P3 walks the states in order', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      expect(w.state).toBe('APPROVED');

      expect(await runOnce(p.deps, 'one')).toBe(true);
      const reserved = await getWithdrawal(p.db, w.id);
      expect(reserved.state).toBe('RESERVED');
      expect(reserved.reservation).not.toBeNull();
      expect(reserved.fee).not.toBeNull();
      expect(await attemptsOf(p.db, w.id)).toHaveLength(0);

      await runOnce(p.deps, 'one');
      expect(await state(w.id)).toBe('SIGNED');
      const [stored] = await attemptsOf(p.db, w.id);
      expect(stored?.attempt_no).toBe(1);
      expect(stored?.broadcast_at).toBeNull();

      await runOnce(p.deps, 'one');
      expect(await state(w.id)).toBe('BROADCAST');
      expect((await attemptsOf(p.db, w.id))[0]?.broadcast_at).not.toBeNull();

      await runOnce(p.deps, 'one'); // nothing mined: still pending
      expect(await state(w.id)).toBe('BROADCAST');

      await drive(p.deps, env, terminal(p.db, w.id));
      expect(await state(w.id)).toBe('SETTLED');
      const events = await p.db<{ data: { from: string; to: string } }[]>`
        select data from withdrawal_events where withdrawal_id = ${w.id} and kind = 'state' order by id`;
      expect(events.map((e) => `${e.data.from}>${e.data.to}`)).toEqual([
        'APPROVED>RESERVED',
        'RESERVED>SIGNED',
        'SIGNED>BROADCAST',
        'BROADCAST>SETTLED',
      ]);
    });

    it('P4 three workers, twelve withdrawals: all settle, each destination receives exactly once', async () => {
      const before = await env.adapter.getBalance(p.hot.hotAddress, native);
      // twelveConcurrent credits the hot wallet first; count that top-up in `before`
      const credited = Array.from({ length: 12 }, (_, i) => env.unit(native) + BigInt(i)).reduce(
        (s, a) => s + a,
        0n,
      );
      const ws = await twelveConcurrent(p, env);

      let spent = 0n;
      for (const w of ws) {
        expect(w.state).toBe('SETTLED');
        expect(await env.adapter.getBalance(w.to, native)).toBe(w.amount);
        spent += w.amount + (await feePaid(env, w.settledTxid));
      }
      const rows = await p.db<{ txid: string }[]>`select txid from tx_attempts`;
      expect(rows).toHaveLength(12);
      expect(new Set(rows.map((r) => r.txid)).size).toBe(12);
      const after = await env.adapter.getBalance(p.hot.hotAddress, native);
      expect(before + credited - after).toBe(spent);
    });

    it('P5 two workers running the same handler change state once', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const { id } = await p.withdraw(native, amount);
      await runOnce(p.deps, 'one');
      const w = await getWithdrawal(p.db, id);
      expect(w.state).toBe('RESERVED');

      // Hold the row lock so both handlers reach their compare-and-swap and wait on it together.
      const lock = await lockRow(p.db, id);
      const both = Promise.allSettled([handlers.RESERVED(p.deps, w), handlers.RESERVED(p.deps, w)]);
      await lockWaiters(p.db, 2);
      await lock.release();
      const results = await both;

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected');
      expect(lost?.reason).toBeInstanceOf(LostRace);
      expect(await attemptsOf(p.db, id)).toHaveLength(1);
      expect(await state(id)).toBe('SIGNED');
    });

    it('P6 an unreachable node leaves the state unchanged and is retried', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      let failures = 1;
      const flaky: ChainAdapter = {
        ...env.adapter,
        broadcast: (tx: SignedTx) =>
          failures-- > 0
            ? Promise.reject(new Error('connect ECONNREFUSED (test)'))
            : env.adapter.broadcast(tx),
      };
      const deps = withAdapter(p.deps, env.chain, flaky);
      await runOnce(deps, 'one');
      await runOnce(deps, 'one');
      expect(await state(w.id)).toBe('SIGNED');

      expect(await runOnce(deps, 'one')).toBe(true);
      const [row] = await p.db<{ state: string; error_count: number; last_error: string | null }[]>`
        select state, error_count, last_error from withdrawals where id = ${w.id}`;
      expect(row).toEqual({
        state: 'SIGNED',
        error_count: 1,
        last_error: 'connect ECONNREFUSED (test)',
      });

      await drive(deps, env, terminal(p.db, w.id));
      expect(await state(w.id)).toBe('SETTLED');
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
    });

    it('P7 an expired lease lets another worker continue', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      const claimed = await claim(p.deps, 'A'); // A never runs the handler or releases
      expect(claimed?.id).toBe(w.id);
      expect(await runOnce(p.deps, 'B')).toBe(false); // the lease still holds

      await drive(p.deps, env, terminal(p.db, w.id), 20_000, 'B');
      expect(await state(w.id)).toBe('SETTLED');
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
    });

    it('P8 a broadcast that was sent but not recorded is not sent again', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      await runOnce(p.deps, 'one');
      await runOnce(p.deps, 'one');
      expect(await state(w.id)).toBe('SIGNED');
      const [stored] = await attemptsOf(p.db, w.id);
      if (!stored) throw new Error('no stored attempt');
      // what a worker killed at after_broadcast leaves behind: sent, state still SIGNED
      expect(await env.adapter.broadcast({ txid: stored.txid, raw: stored.raw })).toEqual({
        outcome: 'accepted',
      });
      expect(await state(w.id)).toBe('SIGNED');

      const spy = vi.fn((tx: SignedTx) => env.adapter.broadcast(tx));
      const deps = withAdapter(p.deps, env.chain, { ...env.adapter, broadcast: spy });
      await runOnce(deps, 'two');
      expect(await state(w.id)).toBe('BROADCAST');
      expect(spy).not.toHaveBeenCalled();

      await drive(deps, env, terminal(p.db, w.id));
      expect(spy).not.toHaveBeenCalled();
      expect(await state(w.id)).toBe('SETTLED');
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
    });
  });
}

// Holds the withdrawal's row lock until release() is called.
async function lockRow(db: Db, id: string): Promise<{ release(): Promise<void> }> {
  let locked!: () => void;
  let unlock!: () => void;
  const ready = new Promise<void>((r) => (locked = r));
  const gate = new Promise<void>((r) => (unlock = r));
  const done = db.begin(async (tx) => {
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

// Resolves once `n` sessions are blocked on a lock. Any statement counts, not only the update:
// an insert that references the locked row waits on it too. Test files run in series, so the
// only sessions in this database are this test's.
async function lockWaiters(db: Db, n: number): Promise<void> {
  await waitFor(
    `${n} sessions waiting on a lock`,
    async () => {
      const [row] = await db<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and datname = current_database()`;
      return (row?.n ?? 0) >= n;
    },
    10_000,
  );
}
