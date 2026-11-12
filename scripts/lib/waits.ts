// Small waiting helpers for the fault run.
import { setTimeout as sleep } from 'node:timers/promises';
import { startMiner, type Devnet } from '../../src/conformance/harness.js';

export const seconds = (since: number) => Math.round((Date.now() - since) / 1000);

/**
 * The miner, started once `ready` holds; stop() works whether it started or not. A failed check
 * counts as not ready, so a scenario waiting on it fails by its timeout.
 */
export function startMinerWhen(
  devnet: Devnet,
  everyMs: number,
  ready: () => Promise<boolean>,
): () => Promise<void> {
  let stopped = false;
  let stopMiner = () => Promise.resolve();
  const waiting = (async () => {
    while (!stopped && !(await ready().catch(() => false))) await sleep(100);
    if (!stopped) stopMiner = startMiner(devnet, everyMs);
  })();
  return async () => {
    stopped = true;
    await waiting;
    await stopMiner();
  };
}

/**
 * `work`, or "timed out after N s" (counted from `started`) once `deadline` passes. `work` is not
 * cancelled: the caller fails the scenario, and closing its sandbox ends what still waits.
 */
export async function byDeadline<T>(deadline: number, started: number, work: Promise<T>) {
  const timer = new AbortController();
  const expired = sleep(Math.max(0, deadline - Date.now()), undefined, { signal: timer.signal });
  const late = expired.then(() => {
    throw new Error(`timed out after ${seconds(started)} s`);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    timer.abort();
  }
}
