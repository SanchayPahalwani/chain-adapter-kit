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
  return spawn(process.execPath, ['--import', 'tsx', workerMain], {
    cwd: root,
    env,
    stdio: ['ignore', run.logFd, run.logFd],
  });
}

async function unfinished(db: Db): Promise<number> {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from withdrawals where state not in ('SETTLED','FAILED','REJECTED')`;
  return row?.n ?? 0;
}

const running = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;

/**
 * Runs one worker at a time until every withdrawal in the sandbox is terminal or `timeoutMs` has
 * passed, starting a new worker each time one dies. Then stops the live one with SIGTERM.
 * Returns how many died by SIGKILL, which only a crash hook sends. Any other exit throws.
 */
export async function superviseUntilDone(
  run: Run,
  opts: WorkerOptions,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let kills = 0;
  while ((await unfinished(run.box.db)) > 0 && Date.now() < deadline) {
    const child = spawnWorker(run, opts);
    const exit = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
    let stopping = false;
    try {
      while (running(child)) {
        if ((await unfinished(run.box.db)) === 0 || Date.now() >= deadline) {
          stopping = true;
          child.kill('SIGTERM');
          break;
        }
        await sleep(100);
      }
      const [code, signal] = await exit;
      if (signal === 'SIGKILL') {
        kills++;
      } else if (!stopping) {
        throw new Error(`a worker exited by itself (${signal ?? `code ${code}`})`);
      } else if (code !== 0 && signal !== 'SIGTERM') {
        // a SIGTERM that lands before the worker installs its handler ends it by the signal
        throw new Error(`a worker stopped with code ${code}`);
      }
    } finally {
      if (running(child)) child.kill('SIGKILL'); // only if this function itself failed
    }
  }
  return kills;
}
