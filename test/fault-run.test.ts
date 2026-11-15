import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMiner } from '../src/conformance/harness.js';
import type { Db } from '../src/pipeline/db.js';
import { getWithdrawal } from '../src/pipeline/requests.js';
import { verifyAgainstChain } from '../src/pipeline/verify.js';
import { grade } from '../scripts/lib/grading.js';
import type { PipelineEnv } from '../scripts/lib/env.js';
import { makeEvmEnv } from '../scripts/lib/evm-env.js';
import { table, totalsOf, type Outcome } from '../scripts/lib/results.js';
import { parseRunArgs, UsageError } from '../scripts/lib/run-args.js';
import { openSandbox, type Sandbox } from '../scripts/lib/sandbox.js';
import {
  spawnWorker,
  supervise,
  superviseUntilDone,
  type Run,
  type Supervised,
  type WorkerOptions,
} from '../scripts/lib/supervisor.js';
import { mining } from '../scripts/lib/waits.js';
import { drive, eventsOf, openPipeline } from './pipeline-suite.js';

// Each test spawns real worker processes (node --import tsx), so each gets its own timeout.
const PROCESS_TEST = { timeout: 60_000 };
const timings: WorkerOptions['timings'] = {
  leaseMs: 1000,
  pollMs: 50,
  stuckAfterMs: 20_000,
  maxAttempts: 5,
};

async function waitFor(what: string, until: () => Promise<boolean>, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs; // a test timeout, not part of anything under test
  while (!(await until())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const crashEvents = (db: Db) =>
  db<{ withdrawal_id: string; point: string }[]>`
    select withdrawal_id, data->>'point' as point from withdrawal_events
     where kind = 'crash_injected' order by id`;

describe('fault run', () => {
  let env: PipelineEnv;
  let box: Sandbox;
  let run: Run;
  let logPath: string;

  beforeAll(async () => {
    env = await makeEvmEnv();
  });
  beforeEach(async () => {
    box = await openSandbox(env);
    logPath = join(tmpdir(), `fault-run-test-${box.schema}.log`);
    run = { box, logFd: openSync(logPath, 'w') };
  });
  afterEach(async () => {
    closeSync(run.logFd);
    await box.close();
    rmSync(logPath, { force: true });
  });

  async function twoNative() {
    const unit = env.unit('native');
    await box.credit('native', 2n * unit + 1n);
    return [await box.withdraw('native', unit), await box.withdraw('native', unit + 1n)];
  }

  it('X1 killOnce kills a child process once per withdrawal and point', PROCESS_TEST, async () => {
    const ws = await twoNative();
    const stopMiner = startMiner(env.devnet, 100);
    let supervised: Supervised;
    try {
      supervised = await superviseUntilDone(run, { crashAt: 'after_broadcast', timings }, 40_000);
    } finally {
      await stopMiner();
    }

    expect(supervised).toEqual({ kills: 2, killsMidHandler: 0, timedOut: false });
    const injected = await crashEvents(box.db);
    expect(injected.map((e) => e.point)).toEqual(['after_broadcast', 'after_broadcast']);
    expect(new Set(injected.map((e) => e.withdrawal_id))).toEqual(new Set(ws.map((w) => w.id)));
    // graded as the fault run grades: more blocks, and nothing left pending from the hot wallet
    const { left, verdict, report } = await grade(env, box);
    expect(left).toBe(0);
    expect(report.ok).toBe(true);
    expect(verdict).toEqual({
      withdrawals: 2,
      settled: 2,
      rejected: 0,
      failed: 0,
      sentTwice: 0,
      lost: 0,
      unfinished: 0,
    });
    for (const w of ws) {
      // killed after the send, before it was recorded: the next worker found the transaction
      // on the node and recorded the broadcast without sending again
      const [b] = await box.db<{ sent: boolean }[]>`
          select (data->>'sent')::boolean as sent from withdrawal_events
           where withdrawal_id = ${w.id} and kind = 'broadcast'`;
      expect(b?.sent).toBe(false);
    }
    // the last worker was stopped with SIGTERM and said so on its way out
    expect(readFileSync(logPath, 'utf8')).toMatch(/stopped\n$/);
  });

  it('X2 verifyAgainstChain reports a double send and a loss', async () => {
    const p = await openPipeline(env);
    try {
      const amount = env.unit('native');
      await p.credit('native', 2n * amount);
      const sent = await p.withdraw('native', amount);
      await drive(
        p.deps,
        env,
        async () => (await getWithdrawal(p.db, sent.id)).state === 'SETTLED',
      );
      const never = await p.withdraw('native', amount); // no worker runs after this
      const clean = await verifyAgainstChain(p.db, p.deps.chains);
      expect(clean).toMatchObject({ withdrawals: 2, settled: 1, unfinished: 1, sentTwice: 0 });
      expect(clean.lost).toBe(0);

      await env.devnet.fund(sent.to, 'native', 1n); // one wei more than was asked for
      await p.db`update withdrawals set state = 'SETTLED' where id = ${never.id}`;
      expect(await verifyAgainstChain(p.db, p.deps.chains)).toMatchObject({
        withdrawals: 2,
        settled: 2,
        sentTwice: 1,
        lost: 1,
        unfinished: 0,
      });

      // money at the destination of a withdrawal that ended without a transfer was sent anyway
      await p.db`update withdrawals set state = 'REJECTED' where id = ${never.id}`;
      await env.devnet.fund(never.to, 'native', 1n);
      expect(await verifyAgainstChain(p.db, p.deps.chains)).toMatchObject({
        rejected: 1,
        sentTwice: 2,
        lost: 0,
      });
    } finally {
      await p.close();
    }
  });

  it(
    'X3 a SIGKILL after signing leaves nothing stored: the withdrawal is RESERVED with no attempt',
    PROCESS_TEST,
    async () => {
      const [w] = await twoNative();
      if (!w) throw new Error('no withdrawal');
      const child = spawnWorker(run, { crashAt: 'after_sign', timings });
      const [, signal] = (await once(child, 'exit')) as [number | null, string | null];
      expect(signal).toBe('SIGKILL');

      const [killed] = await crashEvents(box.db);
      expect(killed).toEqual({ withdrawal_id: w.id, point: 'after_sign' });
      expect((await getWithdrawal(box.db, w.id)).state).toBe('RESERVED');
      expect(await box.db`select 1 from tx_attempts where withdrawal_id = ${w.id}`).toHaveLength(0);
      expect(await eventsOf(box.db, w.id)).toEqual(['APPROVED>RESERVED', 'crash_injected']);

      // a restarted worker signs again from the stored reservation and finishes the job
      const stopMiner = startMiner(env.devnet, 100);
      try {
        const supervised = await superviseUntilDone(
          run,
          { crashAt: 'after_sign', timings },
          40_000,
        );
        expect(supervised.timedOut).toBe(false);
      } finally {
        await stopMiner();
      }
      const { left, verdict, report } = await grade(env, box);
      expect(left).toBe(0);
      expect(report.ok).toBe(true);
      expect(verdict).toMatchObject({ settled: 2, sentTwice: 0, lost: 0, unfinished: 0 });
    },
  );

  it(
    'X3b a SIGKILL inside an open transaction leaves nothing of that transaction behind',
    PROCESS_TEST,
    async () => {
      const [w] = await twoNative();
      if (!w) throw new Error('no withdrawal');
      // Inserts into tx_attempts wait for this lock, so the worker's sign transaction stops
      // after its state change and before it stores the attempt, with the transaction open.
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      let locked = () => {};
      const isLocked = new Promise<void>((resolve) => (locked = resolve));
      const holder = box.db.begin(async (tx) => {
        await tx`lock table tx_attempts in share mode`;
        locked();
        await held;
      });
      await isLocked;
      const waiting = async () => {
        const rows = await box.db`
          select 1 from pg_locks where relation = 'tx_attempts'::regclass and not granted`;
        return rows.length > 0;
      };
      const child = spawnWorker(run, { timings });
      try {
        await waitFor('the worker to wait on tx_attempts', waiting);
        child.kill('SIGKILL');
        await once(child, 'exit');
      } finally {
        release();
        await holder;
      }
      // The dead worker's server session gets the lock, then finds its client gone and rolls
      // back; its locks go with the transaction. It never committed: nothing sent COMMIT.
      await waitFor('the dead session to end', async () => {
        const rows = await box.db`
          select 1 from pg_locks
           where relation = 'tx_attempts'::regclass and pid <> pg_backend_pid()`;
        return rows.length === 0;
      });
      expect((await getWithdrawal(box.db, w.id)).state).toBe('RESERVED');
      expect(await box.db`select 1 from tx_attempts`).toHaveLength(0);
      expect(await eventsOf(box.db, w.id)).toEqual(['APPROVED>RESERVED']);
    },
  );

  it('X5 random kills spare a worker for killAfterMs once it started', PROCESS_TEST, async () => {
    const killAfterMs = 2000;
    // When the supervisor's loop first saw each worker's start: a worker logs it just before it
    // tells the supervisor, and the loop checks `until` at least every 100 ms.
    const seen: number[] = [];
    const until = () => {
      const started = (readFileSync(logPath, 'utf8').match(/: started/g) ?? []).length;
      while (seen.length < started) seen.push(Date.now());
      return Promise.resolve(started >= 3); // two workers killed, a third started
    };
    const supervised = await supervise(run, { timings }, 40_000, {
      killEveryMs: [50, 50],
      killAfterMs,
      until,
    });
    expect(supervised).toEqual({ kills: 2, killsMidHandler: 0, timedOut: false });
    // A kill attempt every 50 ms, yet the two killed workers each lived killAfterMs once started.
    // The second and third start-ups (each 300 ms or more) cover the 100 ms the loop can lag.
    const [first = 0, , third = 0] = seen;
    expect(third - first).toBeGreaterThanOrEqual(2 * killAfterMs);
  });
});

// The script end to end, on two scenarios and both chains: the whole quick matrix is a separate CI
// step.
describe('fault-run script', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));

  it(
    'X4 the quick fault run exits 0 and reports zero sent twice, lost, unfinished and drift',
    // more than the two scenarios' own time limits on two chains together (2 x (140 s + 50 s)),
    // so a slow run fails with the script's reason
    { timeout: 420_000 },
    async () => {
      const args = ['--quick', '--no-write', '--json', '--only', 'random_kills,duplicate_requests'];
      const child = spawn('npx', ['tsx', 'scripts/fault-run.ts', ...args], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      let code: number | null;
      try {
        [code] = (await once(child, 'exit')) as [number | null];
      } finally {
        // a timed-out test: the run stops its worker and drops its schema on SIGTERM
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      }
      expect(code, stderr).toBe(0);

      const out = JSON.parse(stdout) as {
        passed: boolean;
        chains: { chain: string; node: string }[];
        scenarios: {
          chain: string;
          name: string;
          kills: number;
          killsMidHandler: number;
          withdrawals: number;
          settled: number;
          rejected: number;
        }[];
        totals: Record<string, number | string> | null;
      };
      expect(out.passed).toBe(true);
      expect(out.chains.map((c) => c.chain)).toEqual(['evm-anvil', 'bitcoin-regtest']);
      expect(out.scenarios.map((s) => `${s.chain} ${s.name}`)).toEqual([
        'evm-anvil random_kills',
        'evm-anvil duplicate_requests',
        'bitcoin-regtest random_kills',
        'bitcoin-regtest duplicate_requests',
      ]);
      expect(out.totals).toMatchObject({ sentTwice: 0, lost: 0, unfinished: 0, drift: '0' });
      for (const s of out.scenarios) {
        if (s.name === 'random_kills') {
          expect(s.killsMidHandler).toBeGreaterThanOrEqual(3); // the --quick minimum
          expect(s.withdrawals).toBeGreaterThanOrEqual(40); // batches until the minimum held
          expect(s.settled).toBe(s.withdrawals);
        } else {
          expect(s.rejected).toBe(2); // one not allowlisted, one over the limit
        }
      }
    },
  );

  it('X6b the total row covers every chain in the table', () => {
    const verdict = {
      withdrawals: 2,
      settled: 2,
      rejected: 0,
      failed: 0,
      sentTwice: 0,
      lost: 0,
      unfinished: 0,
    };
    const graded = { kills: 1, killsMidHandler: 0, verdict, drift: 0n, problems: [] };
    const outcomes: Outcome[] = ['evm-anvil', 'bitcoin-regtest'].map((chain) => ({
      chain,
      name: 'reorg',
      title: 'reorg before finality',
      about: '',
      graded,
    }));
    const total = table(outcomes, totalsOf([graded, graded]))
      .trimEnd()
      .split('\n')
      .at(-1);
    expect(total).toMatch(
      /^\| \*\*Total\*\* +\| every scenario on evm-anvil and bitcoin-regtest +\| +4 \| +2 \| +4 \|/,
    );
    expect(table(outcomes.slice(0, 1), totalsOf([graded]))).toMatch(
      /every scenario on evm-anvil +\|/,
    );
  });

  it('X6 the table has a chain column, and a scenario a chain cannot produce reads not applicable', () => {
    const verdict = {
      withdrawals: 2,
      settled: 2,
      rejected: 0,
      failed: 0,
      sentTwice: 0,
      lost: 0,
      unfinished: 0,
    };
    const outcomes: Outcome[] = [
      {
        chain: 'evm-anvil',
        name: 'reorg',
        title: 'reorg before finality',
        about: '',
        graded: { kills: 0, killsMidHandler: 0, verdict, drift: 0n, problems: [] },
      },
      {
        chain: 'other-chain',
        name: 'reorg',
        title: 'reorg before finality',
        about: '',
        notApplicable: 'its blocks are final at once',
      },
    ];
    expect(table(outcomes, null).split('\n')).toEqual([
      '| Chain       | Scenario                               | Withdrawals | Worker kills | Settled | Rejected | Sent twice | Lost | Unfinished | Ledger drift |',
      '|-------------|----------------------------------------|------------:|-------------:|--------:|---------:|-----------:|-----:|-----------:|-------------:|',
      '| evm-anvil   | reorg before finality                  |           2 |            0 |       2 |        0 |          0 |    0 |          0 |            0 |',
      '| other-chain | reorg before finality (not applicable) |           - |            - |       - |        - |          - |    - |          - |            - |',
      '',
    ]);
  });
});

describe('fault-run command line', () => {
  const known = { chains: ['evm-anvil', 'bitcoin-regtest'], scenarios: ['reorg', 'stuck_fee'] };

  it('X7 only the whole matrix on every chain at default counts may write docs/results.md', () => {
    expect(parseRunArgs([], known)).toMatchObject({ chains: known.chains, n: 10, partial: false });
    expect(parseRunArgs(['--chain', 'all'], known)).toMatchObject({ partial: false });
    expect(parseRunArgs(['--no-write'], known)).toMatchObject({ partial: false, noWrite: true });
    // a chain named, even one of all of them, is a partial run
    for (const chain of known.chains) {
      expect(parseRunArgs(['--chain', chain], known)).toMatchObject({
        chains: [chain],
        partial: true,
      });
    }
    for (const argv of [['--quick'], ['--only', 'reorg'], ['--per-scenario', '10']]) {
      expect(parseRunArgs(argv, known), argv.join(' ')).toMatchObject({ partial: true });
    }
  });

  it('X8 an unknown --chain is a usage error: the script prints it with its usage and exits 2', async () => {
    expect(() => parseRunArgs(['--chain', 'solana'], known)).toThrow(
      new UsageError('unknown chain solana (known: evm-anvil, bitcoin-regtest, all)'),
    );
    expect(() => parseRunArgs(['--chians', 'all'], known)).toThrow(UsageError);
    const root = fileURLToPath(new URL('../', import.meta.url));
    const child = spawn('npx', ['tsx', 'scripts/fault-run.ts', '--chain', 'solana'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const [code] = (await once(child, 'exit')) as [number | null];
    expect(code, stderr).toBe(2);
    expect(stderr).toMatch(
      /^unknown chain solana \(known: evm-anvil, bitcoin-regtest, all\)\nusage: /,
    );
  });

  it('X9 mining() keeps the error of the work when stopping the miner fails too', async () => {
    const work = new Error('the supervisor failed');
    const miner = new Error('the miner failed');
    await expect(
      mining(
        () => Promise.reject(miner),
        () => Promise.reject(work),
      ),
    ).rejects.toBe(work);
    await expect(
      mining(
        () => Promise.reject(miner),
        () => Promise.resolve(1),
      ),
    ).rejects.toBe(miner);
    await expect(
      mining(
        () => Promise.resolve(),
        () => Promise.resolve(1),
      ),
    ).resolves.toBe(1);
  });
});
