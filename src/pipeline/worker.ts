import { setTimeout as sleep } from 'node:timers/promises';
import type { ChainAdapter } from '../core/adapter.js';
import type { Signer } from '../core/signer.js';
import type { CrashHook } from './crash.js';
import type { Db } from './db.js';
import { rowToWithdrawal, type Withdrawal } from './requests.js';
import { handlers, LostRace } from './steps.js';

export interface ChainRuntime {
  adapter: ChainAdapter;
  hotKeyId: string;
  hotAddress: string;
}
export interface Timings {
  leaseMs: number;
  pollMs: number;
  stuckAfterMs: number;
  retryBaseMs: number;
  maxAttempts: number;
}
export interface WorkerDeps {
  db: Db;
  signer: Signer;
  chains: Record<string, ChainRuntime>;
  timings: Timings;
  crash: CrashHook;
}

export async function hotWallet(adapter: ChainAdapter, signer: Signer): Promise<ChainRuntime> {
  const hotKeyId = `hot:${adapter.chain}`;
  const hotAddress = adapter.deriveAddress(await signer.publicKey(hotKeyId, adapter.curve));
  return { adapter, hotKeyId, hotAddress };
}

/**
 * One statement, so the row is chosen and leased atomically. skip locked: a row another
 * worker is claiming, or whose handler holds its row lock mid-transition, is passed over.
 * The lease only avoids duplicate work; the handlers stay correct without it. Only chains this
 * worker has a runtime for: another chain's row would fail here and back off, delaying the
 * worker that can run it.
 */
export async function claim(deps: WorkerDeps, workerId: string): Promise<Withdrawal | null> {
  const chains = Object.keys(deps.chains);
  const [row] = await deps.db`
    update withdrawals
       set lease_owner = ${workerId},
           lease_expires_at = now() + make_interval(secs => ${deps.timings.leaseMs / 1000})
     where id = (
       select id from withdrawals
        where state in ('APPROVED','RESERVED','SIGNED','BROADCAST')
          and chain = any(${chains}::text[])
          and next_run_at <= now()
          and (lease_expires_at is null or lease_expires_at < now())
        order by next_run_at
        limit 1
          for update skip locked)
    returning *`;
  return row ? rowToWithdrawal(row) : null;
}

const isWorkerState = (s: string): s is keyof typeof handlers => Object.hasOwn(handlers, s);

/** Claim one due withdrawal and run its handler. False when nothing is due. Never throws for a handler error. */
export async function runOnce(deps: WorkerDeps, workerId: string): Promise<boolean> {
  const w = await claim(deps, workerId);
  if (!w) return false;
  let failure: { error: unknown } | undefined;
  try {
    if (!isWorkerState(w.state)) throw new Error(`no handler for state ${w.state}`);
    await handlers[w.state](deps, w);
  } catch (error) {
    failure = { error };
  }

  // Each release matches only while this worker still holds the lease: if it expired and
  // another worker claimed the row, that worker's lease is left alone.
  const { db } = deps;
  if (!failure) {
    // Handlers that want a delay have set next_run_at themselves. A step that changed the state
    // has happened, so an error from an earlier run of it is cleared; one that left the state
    // as it was (track's poll) has written last_error itself.
    await db`
      update withdrawals set lease_owner = null, lease_expires_at = null, error_count = 0,
             updated_at = now(),
             last_error = case when state = ${w.state} then last_error end
       where id = ${w.id} and lease_owner = ${workerId}`;
  } else if (failure.error instanceof LostRace) {
    // another worker made this step; nothing to record
    await db`
      update withdrawals set lease_owner = null, lease_expires_at = null
       where id = ${w.id} and lease_owner = ${workerId}`;
  } else {
    const e = failure.error;
    const message = e instanceof Error ? e.message : String(e);
    // In an update every right-hand side reads the old row, so the first failure waits retryBaseMs.
    await db`
      update withdrawals set lease_owner = null, lease_expires_at = null, updated_at = now(),
             error_count = error_count + 1, last_error = ${message},
             next_run_at = now() + make_interval(
               secs => ${deps.timings.retryBaseMs / 1000} * power(2, least(error_count, 6)))
       where id = ${w.id} and lease_owner = ${workerId}`;
  }
  return true;
}

/**
 * Runs until `signal` aborts. Only a failed claim or release ends the loop early, and the process
 * supervisor restarts it; a database error inside a handler is recorded like any other error.
 */
export async function runWorker(
  deps: WorkerDeps,
  workerId: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    if (await runOnce(deps, workerId)) continue;
    await sleep(deps.timings.pollMs, undefined, { signal }).catch(() => undefined); // aborted
  }
}
