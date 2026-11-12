// Runs worker processes (scripts/worker-main.ts) on a sandbox and restarts them when they die.
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { CrashPoint } from '../../src/pipeline/crash.js';
import type { Db } from '../../src/pipeline/db.js';
import type { Timings } from '../../src/pipeline/worker.js';
import type { Sandbox } from './sandbox.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const workerMain = fileURLToPath(new URL('../worker-main.ts', import.meta.url));

export interface WorkerOptions {
  crashAt?: CrashPoint;
  timings: Pick<Timings, 'leaseMs' | 'pollMs' | 'stuckAfterMs' | 'maxAttempts'>;
}

/** A sandbox, and the open file its workers write their stdout and stderr to. */
export interface Run {
  box: Sandbox;
  logFd: number;
}

export function spawnWorker(run: Run, opts: WorkerOptions): ChildProcess {
  const { leaseMs, pollMs, stuckAfterMs, maxAttempts } = opts.timings;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...run.box.workerEnv(),
    KIT_LEASE_MS: String(leaseMs),
    KIT_POLL_MS: String(pollMs),
    KIT_STUCK_AFTER_MS: String(stuckAfterMs),
    KIT_MAX_ATTEMPTS: String(maxAttempts),
  };
  if (opts.crashAt) env.KIT_CRASH_AT = opts.crashAt;
  else delete env.KIT_CRASH_AT;
  delete env.KIT_WORKER_ID; // so each worker's id, its lease_owner, is its own pid
  // 'ipc': if this process dies, the channel closes and the worker stops itself (worker-main.ts)
  return spawn(process.execPath, ['--import', 'tsx', workerMain], {
    cwd: root,
    env,
    stdio: ['ignore', run.logFd, run.logFd, 'ipc'],
  });
}

// A worker killed while it held a withdrawal's lease (between claim and release) was killed
// mid-handler: a dead worker cannot release, so its lease is still there.
async function heldLease(db: Db, child: ChildProcess): Promise<boolean> {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from withdrawals where lease_owner = ${String(child.pid)}`;
  return (row?.n ?? 0) > 0;
}

async function unfinished(db: Db): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from withdrawals where state not in ('SETTLED','FAILED','REJECTED')`;
  return row?.n ?? 0;
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

type Exit = [code: number | null, signal: NodeJS.Signals | null];

const STOP_GRACE_MS = 10_000;

// SIGTERM, then up to STOP_GRACE_MS for the worker to finish its step and exit. A worker that
// takes longer is killed, and the run fails.
async function stop(child: ChildProcess, exit: Promise<Exit>): Promise<Exit> {
  child.kill('SIGTERM');
  const timer = new AbortController();
  const late = sleep(STOP_GRACE_MS, null, { signal: timer.signal }).catch(() => null);
  const result = await Promise.race([exit, late]);
  timer.abort();
  if (result) return result;
  child.kill('SIGKILL');
  await exit;
  throw new Error(`worker did not stop within ${STOP_GRACE_MS / 1000} s of SIGTERM`);
}

export interface Supervised {
  // workers that died by SIGKILL: from a crash hook (opts.crashAt), or sent here (killEveryMs)
  kills: number;
  killsMidHandler: number; // kills sent here that left a withdrawal leased to the dead worker
  timedOut: boolean; // the deadline passed before the stop condition held
}

export interface SuperviseOptions {
  workers?: number; // how many run at once (default 1)
  // SIGKILL a random worker this often, between min and max ms, and start another. Only workers
  // past start-up (worker-main.ts says so): a kill while one still loads would test nothing.
  killEveryMs?: [min: number, max: number];
  // ...and only those that said so at least this long ago (default 0). However slow start-up is,
  // each worker then has this long to work, so kills cannot keep the work from finishing. A kill
  // attempt that finds no such worker kills nothing.
  killAfterMs?: number;
  // The work, started once every first worker has run killAfterMs; there are no kills before
  // that, and `until` counts only once the work has finished. Work there from the start would be
  // partly done (on a fast machine, all of it) before any worker could be killed. `sofar` reads
  // the kills up to now, so the work can go on until enough of them have happened.
  submit?: (sofar: () => Omit<Supervised, 'timedOut'>) => Promise<void>;
  until?: () => Promise<boolean>; // when to stop (default: every withdrawal is terminal)
}

/**
 * Runs `workers` worker processes until `until` holds, `timeoutMs` has passed or `signal` aborts,
 * starting a new worker each time one dies; then stops the live ones. A SIGKILL counts as a kill
 * only if this function sent it or the workers have a crash point; any other exit of a worker
 * throws, and so do an abort and a failed `submit`, once the live workers have stopped.
 */
export async function supervise(
  run: Run,
  opts: WorkerOptions,
  timeoutMs: number,
  { workers = 1, killEveryMs, killAfterMs = 0, submit, until }: SuperviseOptions = {},
  signal?: AbortSignal,
): Promise<Supervised> {
  const deadline = Date.now() + timeoutMs;
  const live = new Map<ChildProcess, Promise<Exit>>();
  const killedHere = new WeakSet<ChildProcess>();
  const startedAt = new WeakMap<ChildProcess, number>(); // when each said it was past start-up
  const killable = (c: ChildProcess) =>
    running(c) && (startedAt.get(c) ?? Infinity) <= Date.now() - killAfterMs;
  const killGap = () =>
    killEveryMs ? killEveryMs[0] + Math.random() * (killEveryMs[1] - killEveryMs[0]) : Infinity;
  // submit(), once started: it settles without rejecting, and rethrow() throws what it threw
  const work: { started?: Promise<void>; finished: boolean; error?: { thrown: unknown } } = {
    finished: !submit,
  };
  const rethrow = () => {
    if (work.error) throw work.error.thrown;
  };
  const condition = until ?? (async () => (await unfinished(run.box.db)) === 0);
  const done = async () => work.finished && (await condition());
  let nextKill = submit ? Infinity : Date.now() + killGap();
  let kills = 0;
  let killsMidHandler = 0;

  const account = (child: ChildProcess, [code, sig]: Exit, stopped: boolean) => {
    if (sig === 'SIGKILL' && (killedHere.has(child) || opts.crashAt)) {
      kills++;
      return;
    }
    if (signal?.aborted) return; // a Ctrl-C reaches the workers too, and they stop themselves
    if (!stopped) throw new Error(`a worker exited by itself (${sig ?? `code ${code}`})`);
    // a SIGTERM that lands before the worker installs its handler ends it by the signal
    if (code !== 0 && sig !== 'SIGTERM') throw new Error(`a worker stopped with code ${code}`);
  };

  try {
    for (;;) {
      for (const [child, exit] of live) {
        if (running(child)) continue;
        live.delete(child);
        account(child, await exit, false);
      }
      rethrow();
      // whether `until` held when stopping was decided: a condition such as "every withdrawal
      // is BROADCAST" need not hold any more once the workers have stopped
      const held = !signal?.aborted && (await done());
      if (signal?.aborted || held || Date.now() >= deadline) {
        const stopping = [...live];
        live.clear();
        const exits = await Promise.allSettled(stopping.map(([child, exit]) => stop(child, exit)));
        exits.forEach((e, i) => {
          if (e.status === 'rejected') throw e.reason;
          const child = stopping[i]?.[0];
          if (child) account(child, e.value, true);
        });
        await work.started;
        if (signal?.aborted) throw new Error('interrupted');
        rethrow();
        return { kills, killsMidHandler, timedOut: !held && !(await done()) };
      }
      while (live.size < workers) {
        const child = spawnWorker(run, opts);
        child.once('message', () => startedAt.set(child, Date.now()));
        live.set(child, once(child, 'exit') as Promise<Exit>);
      }
      if (submit && !work.started && [...live.keys()].every(killable)) {
        work.started = submit(() => ({ kills, killsMidHandler })).then(
          () => void (work.finished = true),
          (thrown: unknown) => void (work.error = { thrown }),
        );
        nextKill = Date.now() + killGap();
      }
      if (Date.now() >= nextKill) {
        const targets = [...live.keys()].filter(killable);
        const victim = targets[Math.floor(Math.random() * targets.length)];
        if (victim) {
          killedHere.add(victim);
          victim.kill('SIGKILL');
          await live.get(victim); // dead, so a lease still in its name is one it died holding
          if (await heldLease(run.box.db, victim)) killsMidHandler++;
        }
        nextKill = Date.now() + killGap();
      }
      await sleep(Math.max(0, Math.min(100, nextKill - Date.now())));
    }
  } finally {
    for (const child of live.keys()) if (running(child)) child.kill('SIGKILL'); // only on failure
  }
}

/** One worker at a time until every withdrawal is terminal: the crash-point scenarios. */
export const superviseUntilDone = (
  run: Run,
  opts: WorkerOptions,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Supervised> => supervise(run, opts, timeoutMs, {}, signal);
