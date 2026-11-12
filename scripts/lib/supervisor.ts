// Runs worker processes (scripts/worker-main.ts) on a sandbox, one at a time, and restarts them.
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
  // 'ipc': if this process dies, the channel closes and the worker stops itself (worker-main.ts)
  return spawn(process.execPath, ['--import', 'tsx', workerMain], {
    cwd: root,
    env,
    stdio: ['ignore', run.logFd, run.logFd, 'ipc'],
  });
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
  kills: number; // workers that died by SIGKILL, which only a crash hook sends
  timedOut: boolean; // the deadline passed with withdrawals still unfinished
}

/**
 * Runs one worker at a time until every withdrawal in the sandbox is terminal, `timeoutMs` has
 * passed or `signal` aborts, starting a new worker each time one dies; then stops the live one.
 * Any other exit of a worker throws, and so does an abort, once the live worker has stopped.
 */
export async function superviseUntilDone(
  run: Run,
  opts: WorkerOptions,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Supervised> {
  const deadline = Date.now() + timeoutMs;
  const done = async () => (await unfinished(run.box.db)) === 0;
  let kills = 0;
  for (;;) {
    if (signal?.aborted) throw new Error('interrupted');
    if (await done()) return { kills, timedOut: false };
    if (Date.now() >= deadline) return { kills, timedOut: true };
    const child = spawnWorker(run, opts);
    const exit = once(child, 'exit') as Promise<Exit>;
    try {
      let stopped: Exit | undefined;
      while (running(child) && !stopped) {
        if (signal?.aborted || Date.now() >= deadline || (await done())) {
          stopped = await stop(child, exit);
        } else {
          await sleep(100);
        }
      }
      const [code, sig] = stopped ?? (await exit);
      if (sig === 'SIGKILL') {
        kills++;
      } else if (signal?.aborted) {
        continue; // a Ctrl-C reaches the worker too, and it stops itself
      } else if (!stopped) {
        throw new Error(`a worker exited by itself (${sig ?? `code ${code}`})`);
      } else if (code !== 0 && sig !== 'SIGTERM') {
        // a SIGTERM that lands before the worker installs its handler ends it by the signal
        throw new Error(`a worker stopped with code ${code}`);
      }
    } finally {
      if (running(child)) child.kill('SIGKILL'); // only if this function itself failed
    }
  }
}
