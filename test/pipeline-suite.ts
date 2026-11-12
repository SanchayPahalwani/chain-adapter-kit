import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChainAdapter, SignedTx } from '../src/core/adapter.js';
import { startMiner } from '../src/conformance/harness.js';
import { LocalSigner } from '../src/core/local-signer.js';
import { noCrash } from '../src/pipeline/crash.js';
import type { Db } from '../src/pipeline/db.js';
import { acct, balance, ledgerAsset, post } from '../src/pipeline/ledger.js';
import { getWithdrawal, type Withdrawal, type WithdrawalState } from '../src/pipeline/requests.js';
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
import type { PipelineEnv } from '../scripts/lib/env.js';
import {
  gasFloat,
  openSandbox,
  type Sandbox,
  type SandboxOptions,
} from '../scripts/lib/sandbox.js';

export type { PipelineEnv };

export const testTimings: Timings = {
  leaseMs: 1000,
  pollMs: 20,
  stuckAfterMs: 1500,
  retryBaseMs: 20,
  maxAttempts: 5,
};

/** One test's world: a sandbox (scripts/lib/sandbox.ts), and deps to run its worker in-process. */
export interface Pipeline extends Sandbox {
  deps: WorkerDeps;
}

export type PipelineOptions = SandboxOptions;

export async function openPipeline(
  env: PipelineEnv,
  options: PipelineOptions = {},
): Promise<Pipeline> {
  const s = await openSandbox(env, options);
  const deps: WorkerDeps = {
    db: s.db,
    signer: s.signer,
    chains: s.chains,
    timings: testTimings,
    crash: noCrash,
  };
  return { ...s, deps };
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

/** Like drive, but never mines: nothing confirms unless the test mines. */
async function driveWithoutMining(deps: WorkerDeps, until: () => Promise<boolean>) {
  const deadline = Date.now() + 20_000;
  while (!(await until())) {
    if (Date.now() > deadline) throw new Error('drive timed out');
    if (!(await runOnce(deps, 'driver'))) await sleep(deps.timings.pollMs);
  }
}

// An `until` for drive that holds once `ms` have passed (a test duration, not a pipeline clock).
const after = (ms: number) => {
  const end = Date.now() + ms;
  return () => Promise.resolve(Date.now() >= end);
};

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

/**
 * `adapter` with the named methods replaced and every other member read from `adapter` itself.
 * A Proxy rather than `{ ...adapter }`: a spread copies only own enumerable properties, so it
 * would lose the methods of an adapter written as a class.
 */
export function overrideAdapter(
  adapter: ChainAdapter,
  methods: Partial<ChainAdapter>,
): ChainAdapter {
  return new Proxy(adapter, {
    get(target, key) {
      if (Object.hasOwn(methods, key)) return methods[key as keyof ChainAdapter];
      const value: unknown = Reflect.get(target, key);
      // bound, so a class method still finds its own instance as `this`
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/** `deps` whose adapter for `env.chain` has the named methods replaced. */
function withMethods(
  deps: WorkerDeps,
  env: PipelineEnv,
  methods: Partial<ChainAdapter>,
): WorkerDeps {
  const rt = deps.chains[env.chain];
  if (!rt) throw new Error(`no runtime for ${env.chain}`);
  const adapter = overrideAdapter(rt.adapter, methods);
  return { ...deps, chains: { ...deps.chains, [env.chain]: { ...rt, adapter } } };
}

/** `sent` and `outcome` of a withdrawal's `broadcast` events, in order. */
async function broadcastEvents(db: Db, id: string) {
  return db<{ sent: boolean; outcome: string }[]>`
    select (data->>'sent')::boolean as sent, data->>'outcome' as outcome from withdrawal_events
     where withdrawal_id = ${id} and kind = 'broadcast' order by id`;
}

/** The kinds of a withdrawal's events in order; a state change reads `FROM>TO`. */
export async function eventsOf(db: Db, id: string): Promise<string[]> {
  const rows = await db<{ kind: string; data: { from?: string; to?: string } }[]>`
    select kind, data from withdrawal_events where withdrawal_id = ${id} order by id`;
  return rows.map((e) => (e.kind === 'state' ? `${e.data.from}>${e.data.to}` : e.kind));
}

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
  // allSettled: a worker that rejects must not skip stopping the others and the miner
  const stopAll = async () => {
    stop.abort();
    const results = await Promise.allSettled(workers);
    await stopMiner();
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
  };
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
    await stopAll();
  }
  return Promise.all(ws.map((w) => getWithdrawal(p.db, w.id)));
}

export interface SuiteOptions {
  // Where a withdrawal from a hot wallet with nothing on-chain waits (F5): on EVM it is signed
  // and sent, and the node refuses the transfer; on Bitcoin no coin can be reserved.
  underfundedWaitsIn: WithdrawalState[];
}

export function runPipelineSuite(makeEnv: () => Promise<PipelineEnv>, options: SuiteOptions): void {
  let env: PipelineEnv;
  let p: Pipeline;
  const native = 'native';
  const n = () => ledgerAsset(env.chain, native);
  const state = async (id: string): Promise<WithdrawalState> =>
    (await getWithdrawal(p.db, id)).state;
  const rowOf = async (id: string) => {
    const [r] = await p.db<{ state: string; error_count: number; last_error: string | null }[]>`
      select state, error_count, last_error from withdrawals where id = ${id}`;
    if (!r) throw new Error(`withdrawal ${id} not found`);
    return r;
  };
  // the ledger references posted for a withdrawal, such as hold:<id>
  const postings = async (id: string) =>
    (
      await p.db<{ ref: string }[]>`
        select ref from ledger_txs where ref like ${`%:${id}`} order by ref`
    ).map((r) => r.ref);

  describe('withdrawal pipeline', () => {
    beforeAll(async () => {
      env = await makeEnv();
      expect(env.assets[0]).toBe(native);
    });
    beforeEach(async () => {
      p = await openPipeline(env);
    });
    afterEach(async () => {
      try {
        await p.close();
      } finally {
        await env.clearStuck();
      }
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
      expect(await balance(p.db, acct.custody(n()))).toBe(
        gasFloat(env) + 5n * amount - amount - fee,
      );
      expect(await balance(p.db, acct.custody(n()))).toBe(
        await env.adapter.getBalance(p.hot.hotAddress, native),
      );
      expect(await balance(p.db, acct.networkFees(n()))).toBe(fee);
      const attempts = await attemptsOf(p.db, w.id);
      expect(attempts).toHaveLength(1);
      expect(done.settledTxid).toBe(attempts[0]?.txid);
    });

    it('P2 a token withdrawal of 10n**30n settles; the fee is booked in native', async (ctx) => {
      const token = env.assets[1];
      if (!token) return ctx.skip('this chain has no token asset');
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
      expect(await broadcastEvents(p.db, w.id)).toEqual([{ sent: true, outcome: 'accepted' }]);
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
      let both;
      try {
        both = Promise.allSettled([handlers.RESERVED(p.deps, w), handlers.RESERVED(p.deps, w)]);
        await lockWaiters(p.db, lock.pid, 2);
      } finally {
        await lock.release();
      }
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
      const deps = withMethods(p.deps, env, {
        broadcast: (tx: SignedTx) =>
          failures-- > 0
            ? Promise.reject(new Error('connect ECONNREFUSED (test)'))
            : env.adapter.broadcast(tx),
      });
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
      // A claims with a long lease, so B is certain to find it held, and never runs the
      // handler or releases. The lease is then moved into the past instead of waited out.
      const long = { ...p.deps, timings: { ...p.deps.timings, leaseMs: 60_000 } };
      const claimed = await claim(long, 'A');
      expect(claimed?.id).toBe(w.id);
      expect(await runOnce(p.deps, 'B')).toBe(false); // the lease still holds
      await p.db`
        update withdrawals set lease_expires_at = now() - interval '1 millisecond'
         where id = ${w.id} and lease_owner = 'A'`;

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
      const deps = withMethods(p.deps, env, { broadcast: spy });
      await runOnce(deps, 'two');
      expect(await state(w.id)).toBe('BROADCAST');
      expect(spy).not.toHaveBeenCalled();
      expect(await broadcastEvents(p.db, w.id)).toEqual([
        { sent: false, outcome: 'already_known' },
      ]);

      await drive(deps, env, terminal(p.db, w.id));
      expect(spy).not.toHaveBeenCalled();
      expect(await state(w.id)).toBe('SETTLED');
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
    });

    // APPROVED to BROADCAST in three steps, with nothing mined: the only attempt is pending.
    async function toBroadcast(deps: WorkerDeps, w: Withdrawal) {
      for (let i = 0; i < 3; i++) await runOnce(deps, 'one');
      expect(await state(w.id)).toBe('BROADCAST');
      const [first] = await attemptsOf(p.db, w.id);
      if (!first) throw new Error('no attempt');
      expect(await env.adapter.getTxStatus(first.txid)).toEqual({ state: 'pending' });
      return first;
    }

    it('F1 a dropped transaction is sent again and settles once', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      const first = await toBroadcast(p.deps, w);
      await env.devnet.dropFromMempool(first.txid);
      await drive(p.deps, env, terminal(p.db, w.id));

      expect(await state(w.id)).toBe('SETTLED');
      const attempts = await attemptsOf(p.db, w.id);
      expect(attempts.map((a) => a.txid)).toEqual([first.txid]);
      expect(await eventsOf(p.db, w.id)).toEqual([
        'APPROVED>RESERVED',
        'RESERVED>SIGNED',
        'SIGNED>BROADCAST',
        'broadcast',
        'rebroadcast',
        'BROADCAST>SETTLED',
      ]);
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
    });

    it('F2 a reorg before finality: the withdrawal still settles once', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      const first = await toBroadcast(p.deps, w);
      await env.devnet.mine(1);
      const seen = await env.adapter.getTxStatus(first.txid);
      if (seen.state !== 'confirmed') throw new Error(`attempt is ${seen.state}`);
      expect(seen.confirmations).toBeLessThan(env.adapter.finalityDepth);
      await runOnce(p.deps, 'one'); // records the block
      const [row] = await p.db<{ seen_block: string | null }[]>`
        select seen_block from tx_attempts where withdrawal_id = ${w.id}`;
      expect(row?.seen_block).toBe(seen.block.hash);

      await env.devnet.reorg(1);
      await drive(p.deps, env, terminal(p.db, w.id));

      const done = await getWithdrawal(p.db, w.id);
      expect(done.state).toBe('SETTLED');
      expect(done.settledTxid).toBe(first.txid);
      const events = await eventsOf(p.db, w.id);
      expect(events.filter((k) => k === 'reorged_out' || k === 'reorg')).toHaveLength(1);
      const settled = await env.adapter.getTxStatus(first.txid);
      if (settled.state !== 'confirmed') throw new Error(`attempt is ${settled.state}`);
      expect(settled.block.hash).not.toBe(seen.block.hash);
      expect(await attemptsOf(p.db, w.id)).toHaveLength(1);
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
    });

    it('F3 a stuck transaction is replaced and exactly one attempt confirms', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      const first = await toBroadcast(p.deps, w);
      const { reservation } = await getWithdrawal(p.db, w.id);
      await env.makeStuck();
      // mines after every step, so the first attempt's fee falls below the raised level at once
      await drive(p.deps, env, terminal(p.db, w.id));

      const done = await getWithdrawal(p.db, w.id);
      expect(done.state).toBe('SETTLED');
      expect(done.reservation).toEqual(reservation);
      const attempts = await p.db<{ txid: string; fee: unknown }[]>`
        select txid, fee from tx_attempts where withdrawal_id = ${w.id} order by attempt_no`;
      expect(attempts).toHaveLength(2);
      const [one, two] = attempts;
      expect(one?.txid).toBe(first.txid);
      expect(done.settledTxid).toBe(two?.txid);
      expect(two?.fee).not.toEqual(one?.fee); // quoted again, at the raised level
      expect((await env.adapter.getTxStatus(first.txid)).state).not.toBe('confirmed');
      expect(await eventsOf(p.db, w.id)).not.toContain('rebroadcast');
      const [replaced] = await p.db<{ data: { rejected: string | null } }[]>`
        select data from withdrawal_events where withdrawal_id = ${w.id} and kind = 'replacement'`;
      // An evicted attempt is unknown, its re-send is rejected, and that run replaces it. One
      // that waits in the pool is pending: no re-send, so no rejection.
      if (env.stuckEvicts) expect(replaced?.data.rejected).toBeTruthy();
      else expect(replaced?.data.rejected).toBeNull();
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
    });

    it('F4 a reverted transfer ends FAILED with the hold released and the fee booked', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      // The chain reports every confirmed attempt as reverted. A real revert is an EVM test.
      const deps = withMethods(p.deps, env, {
        getTxStatus: async (txid) => {
          const s = await env.adapter.getTxStatus(txid);
          return s.state === 'confirmed' ? { ...s, succeeded: false } : s;
        },
      });
      await drive(deps, env, terminal(p.db, w.id));

      const done = await getWithdrawal(p.db, w.id);
      expect(done.state).toBe('FAILED');
      expect(await balance(p.db, acct.user(p.userId, n()))).toBe(amount);
      expect(await balance(p.db, acct.inFlight(n()))).toBe(0n);
      expect(await balance(p.db, acct.networkFees(n()))).toBe(await feePaid(env, done.settledTxid));
      expect((await eventsOf(p.db, w.id)).at(-1)).toBe('BROADCAST>FAILED');
    });

    it('F5 an underfunded hot wallet delays the withdrawal, it does not fail it', async () => {
      // the new pipeline is assigned before the old one closes, so afterEach always closes one
      const old = p;
      p = await openPipeline(env, { fundOnChain: false });
      await old.close();
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      const elapsed = after(1000);
      await drive(p.deps, env, async () => {
        expect(['APPROVED', 'RESERVED', 'SIGNED', 'BROADCAST']).toContain(await state(w.id));
        return elapsed();
      });
      // Never terminal (above, at every step), waiting where this chain waits; either failure is
      // recorded on the row (a refused re-send too), not as an event per poll.
      expect(options.underfundedWaitsIn).toContain(await state(w.id));
      expect((await rowOf(w.id)).last_error).toBeTruthy();
      expect(await eventsOf(p.db, w.id)).not.toContain('rebroadcast');

      await env.devnet.fund(p.hot.hotAddress, native, gasFloat(env) + amount);
      await drive(p.deps, env, terminal(p.db, w.id));
      expect(await state(w.id)).toBe('SETTLED');
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
    });

    it('an attempt whose txid another withdrawal already stored is an error, not a lost race', async () => {
      const amount = env.unit(native);
      await p.credit(native, 2n * amount);
      const a = await p.withdraw(native, amount);
      await drive(p.deps, env, terminal(p.db, a.id)); // settled, so the worker never claims it
      const [taken] = await attemptsOf(p.db, a.id);
      if (!taken) throw new Error('no attempt');
      const b = await p.withdraw(native, amount);
      await runOnce(p.deps, 'one');
      expect(await state(b.id)).toBe('RESERVED');
      // as if two attempts had byte-identical signed bytes, so the same txid
      const deps = withMethods(p.deps, env, {
        attachSignatures: () => ({ txid: taken.txid, raw: taken.raw }),
      });

      const thrown = await handlers
        .RESERVED(deps, await getWithdrawal(p.db, b.id))
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(LostRace);

      expect(await runOnce(deps, 'one')).toBe(true);
      const [row] = await p.db<
        { state: string; error_count: number; last_error: string | null; later: boolean }[]
      >`
        select state, error_count, last_error, next_run_at > updated_at as later
          from withdrawals where id = ${b.id}`;
      expect(row?.state).toBe('RESERVED');
      expect(row?.error_count).toBe(1);
      expect(row?.last_error).toMatch(/duplicate key/);
      expect(row?.later).toBe(true); // backed off, not re-claimed at once
      expect(await attemptsOf(p.db, b.id)).toHaveLength(0);
    });

    it('F7 a worker with another signing key cannot replace an attempt: the step fails, nothing more is sent', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      const first = await toBroadcast(p.deps, w);
      const stale = { ...p.deps.timings, stuckAfterMs: 0 }; // so every track run tries to replace
      const rt = p.deps.chains[env.chain];
      if (!rt) throw new Error(`no runtime for ${env.chain}`);
      // restarted with another seed: another hot wallet, which did not reserve this withdrawal
      const reseeded = LocalSigner.random();
      const restarted: WorkerDeps = {
        ...p.deps,
        signer: reseeded,
        chains: { [env.chain]: await hotWallet(rt.adapter, reseeded) },
        timings: stale,
      };
      // the key behind the configured hot address rotated: same address, another key
      const rotated: WorkerDeps = { ...p.deps, signer: LocalSigner.random(), timings: stale };
      const row = () => rowOf(w.id);
      for (const [deps, refusal] of [
        [restarted, /differs from the previous attempt/],
        [rotated, /not the sender|does not own the input/],
      ] as const) {
        const errors = (await row()).error_count;
        // until the step fails, or (what must not happen) a second attempt is stored
        const failedOrReplaced = async () =>
          (await row()).error_count > errors || (await attemptsOf(p.db, w.id)).length > 1;
        await driveWithoutMining(deps, failedOrReplaced);
        expect(await row()).toMatchObject({
          state: 'BROADCAST',
          last_error: expect.stringMatching(refusal) as string,
        });
        expect((await attemptsOf(p.db, w.id)).map((a) => a.txid)).toEqual([first.txid]);
        expect(await eventsOf(p.db, w.id)).not.toContain('replacement');
      }
      expect(await env.devnet.pendingFrom(p.hot.hotAddress)).toBe(1); // only the first attempt

      // the right key, and no attempt stale: it settles on the first attempt alone
      const patient = { ...p.deps, timings: { ...p.deps.timings, stuckAfterMs: 60_000 } };
      await drive(patient, env, terminal(p.db, w.id));
      const done = await getWithdrawal(p.db, w.id);
      expect(done.state).toBe('SETTLED');
      expect(done.settledTxid).toBe(first.txid);
      expect(await attemptsOf(p.db, w.id)).toHaveLength(1);
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
    });

    it("a worker without a chain's runtime never claims that chain's rows", async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      const rt = p.deps.chains[env.chain];
      if (!rt) throw new Error(`no runtime for ${env.chain}`);
      for (const chains of [{}, { 'other-chain': rt }] as Record<string, ChainRuntime>[]) {
        expect(await runOnce({ ...p.deps, chains }, 'elsewhere')).toBe(false);
      }
      const [row] = await p.db`
        select state, lease_owner, error_count, last_error from withdrawals where id = ${w.id}`;
      expect(row).toEqual({
        state: 'APPROVED',
        lease_owner: null,
        error_count: 0,
        last_error: null,
      });
      expect(await runOnce(p.deps, 'here')).toBe(true); // control: the runtime for its chain
      expect(await state(w.id)).toBe('RESERVED');
    });

    it('a withdrawal that settles after a failed run shows no error', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      await toBroadcast(p.deps, w);
      await env.devnet.mine(env.adapter.finalityDepth); // final: the next track run settles
      let failures = 1;
      const deps = withMethods(p.deps, env, {
        getTxStatus: (txid) =>
          failures-- > 0
            ? Promise.reject(new Error('connect ECONNREFUSED (test)'))
            : env.adapter.getTxStatus(txid),
      });
      await runOnce(deps, 'one');
      expect(await rowOf(w.id)).toEqual({
        state: 'BROADCAST',
        error_count: 1,
        last_error: 'connect ECONNREFUSED (test)',
      });
      // settle changes the state with no poll after it: the release clears the old error
      await driveWithoutMining(deps, terminal(p.db, w.id));
      expect(await rowOf(w.id)).toEqual({ state: 'SETTLED', error_count: 0, last_error: null });
    });

    it('two attempts reported confirmed: track fails on every run and settles nothing', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      await toBroadcast(p.deps, w);
      // a replacement, stored and sent, so there are two attempts; nothing mined
      const stale = { ...p.deps, timings: { ...p.deps.timings, stuckAfterMs: 0 } };
      await driveWithoutMining(
        stale,
        async () =>
          (await attemptsOf(p.db, w.id)).length === 2 && (await state(w.id)) === 'BROADCAST',
      );
      // the adapter breaks its promise that at most one attempt confirms
      const tip = await env.adapter.getTip();
      const deps = withMethods(p.deps, env, {
        getTxStatus: () =>
          Promise.resolve({
            state: 'confirmed',
            block: tip,
            confirmations: env.adapter.finalityDepth,
            succeeded: true,
            feePaid: 1n,
          }),
      });
      for (const runs of [1, 2]) {
        // until it fails again, or (what must not happen) leaves BROADCAST
        await driveWithoutMining(deps, async () => {
          const r = await rowOf(w.id);
          return r.error_count >= runs || r.state !== 'BROADCAST';
        });
        expect(await rowOf(w.id)).toMatchObject({
          state: 'BROADCAST',
          last_error: expect.stringMatching(/more than one attempt confirmed/) as string,
        });
      }
      expect((await getWithdrawal(p.db, w.id)).settledTxid).toBeNull();
      expect(await postings(w.id)).toEqual([`hold:${w.id}`]);
    });

    it('a broadcast whose attempt was replaced during the send records nothing: LostRace', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      await runOnce(p.deps, 'one');
      await runOnce(p.deps, 'one');
      expect(await state(w.id)).toBe('SIGNED');
      // While this worker sends attempt 1, others record that broadcast and store a replacement,
      // which leaves the withdrawal SIGNED with attempt 2 the latest. A stand-in for attempt 2
      // will do: this test never sends it.
      const deps = withMethods(p.deps, env, {
        broadcast: async (tx: SignedTx) => {
          const result = await env.adapter.broadcast(tx);
          await p.db`
            insert into tx_attempts (withdrawal_id, attempt_no, txid, raw, unsigned, fee)
            select withdrawal_id, 2, 'stand-in-' || txid, raw, unsigned, fee from tx_attempts
             where withdrawal_id = ${w.id} and attempt_no = 1`;
          return result;
        },
      });

      const thrown = await handlers
        .SIGNED(deps, await getWithdrawal(p.db, w.id))
        .catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(LostRace);
      expect(thrown).toMatchObject({ message: `attempt 1 of ${w.id} was replaced` });
      // the transition rolled back with the attempt's update
      expect(await state(w.id)).toBe('SIGNED');
      const attempts = await attemptsOf(p.db, w.id);
      expect(attempts.map((a) => [a.attempt_no, a.broadcast_at])).toEqual([
        [1, null],
        [2, null],
      ]);
      expect(await eventsOf(p.db, w.id)).toEqual(['APPROVED>RESERVED', 'RESERVED>SIGNED']);
    });

    it('a settlement already posted makes settle fail and roll back, never post twice', async () => {
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      await toBroadcast(p.deps, w);
      await env.devnet.mine(env.adapter.finalityDepth); // final: the next track run settles
      // a posting under this withdrawal's settle reference, which only a second settle could meet
      const a = n();
      await p.db.begin((tx) =>
        post(tx, `settle:${w.id}`, 'settle', a, [
          { account: acct.inFlight(a), side: 'debit', amount },
          { account: acct.custody(a), side: 'credit', amount },
        ]),
      );

      expect(await runOnce(p.deps, 'one')).toBe(true);
      expect(await rowOf(w.id)).toEqual({
        state: 'BROADCAST',
        error_count: 1,
        last_error: `settle:${w.id} was already posted`,
      });
      // the fee, posted before it in the same transaction, rolled back with it
      expect(await postings(w.id)).toEqual([`hold:${w.id}`, `settle:${w.id}`]);
      expect((await getWithdrawal(p.db, w.id)).settledTxid).toBeNull();
    });

    it('F6 attempts stop at maxAttempts', async () => {
      const deps = { ...p.deps, timings: { ...p.deps.timings, stuckAfterMs: 200, maxAttempts: 3 } };
      const amount = env.unit(native);
      await p.credit(native, amount);
      const w = await p.withdraw(native, amount);
      const count = async () => (await attemptsOf(p.db, w.id)).length;
      await driveWithoutMining(deps, async () => (await count()) === 3);
      await driveWithoutMining(deps, after(1000)); // five more stuckAfterMs
      expect(await count()).toBe(3);
      expect(['SIGNED', 'BROADCAST']).toContain(await state(w.id));

      await drive(deps, env, terminal(p.db, w.id));
      const done = await getWithdrawal(p.db, w.id);
      expect(done.state).toBe('SETTLED');
      expect(await count()).toBe(3);
      let confirmed = 0;
      for (const a of await attemptsOf(p.db, w.id)) {
        const s = await env.adapter.getTxStatus(a.txid);
        if (s.state === 'confirmed') confirmed++;
      }
      expect(confirmed).toBe(1);
      expect(await env.adapter.getBalance(w.to, native)).toBe(amount);
    });
  });
}

// Holds the withdrawal's row lock until release() is called. `pid` is the holding session.
async function lockRow(db: Db, id: string): Promise<{ pid: number; release(): Promise<void> }> {
  let locked!: (pid: number) => void;
  let unlock!: () => void;
  const ready = new Promise<number>((r) => (locked = r));
  const gate = new Promise<void>((r) => (unlock = r));
  const done = db.begin(async (tx) => {
    const [row] = await tx<{ pid: number }[]>`
      select pg_backend_pid() as pid from withdrawals where id = ${id} for update`;
    if (!row) throw new Error(`withdrawal ${id} not found`);
    locked(row.pid);
    await gate;
  });
  const pid = await ready;
  return {
    pid,
    async release() {
      unlock();
      await done;
    },
  };
}

// Resolves once `n` sessions are blocked by the session `pid`, directly or through another
// waiter: the first waiter on a row holds its tuple lock, so the second is blocked by the first.
// Any statement counts, not only the update: an insert that references the row waits on it too.
async function lockWaiters(db: Db, pid: number, n: number): Promise<void> {
  await waitFor(
    `${n} sessions blocked by ${pid}`,
    async () => {
      const [row] = await db<{ n: number }[]>`
        with recursive blocked (pid) as (
          select pid from pg_stat_activity where ${pid}::int = any(pg_blocking_pids(pid))
          union
          select a.pid from pg_stat_activity a join blocked b on b.pid = any(pg_blocking_pids(a.pid))
        )
        select count(*)::int as n from blocked`;
      return (row?.n ?? 0) >= n;
    },
    10_000,
  );
}
