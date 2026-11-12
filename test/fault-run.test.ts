import { once } from 'node:events';
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMiner } from '../src/conformance/harness.js';
import type { Db } from '../src/pipeline/db.js';
import { getWithdrawal } from '../src/pipeline/requests.js';
import { verifyAgainstChain } from '../src/pipeline/verify.js';
import type { PipelineEnv } from '../scripts/lib/env.js';
import { makeEvmEnv } from '../scripts/lib/evm-env.js';
import { openSandbox, type Sandbox } from '../scripts/lib/sandbox.js';
import {
  spawnWorker,
  superviseUntilDone,
  type Run,
  type Supervised,
  type WorkerOptions,
} from '../scripts/lib/supervisor.js';
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

    expect(supervised).toEqual({ kills: 2, timedOut: false });
    const injected = await crashEvents(box.db);
    expect(injected.map((e) => e.point)).toEqual(['after_broadcast', 'after_broadcast']);
    expect(new Set(injected.map((e) => e.withdrawal_id))).toEqual(new Set(ws.map((w) => w.id)));
    expect(await verifyAgainstChain(box.db, box.chains)).toEqual({
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
      expect(await verifyAgainstChain(box.db, box.chains)).toMatchObject({
        settled: 2,
        sentTwice: 0,
        lost: 0,
      });
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
});
