// How a fault-run scenario is graded (scripts/lib/scenarios.ts), and the counts its own checks
// read: what the chain says happened, and what the pipeline recorded about it.
import type { Db } from '../../src/pipeline/db.js';
import { reconcile } from '../../src/pipeline/reconcile.js';
import { verifyAgainstChain, type Verdict } from '../../src/pipeline/verify.js';
import type { PipelineEnv } from './env.js';
import type { Sandbox } from './sandbox.js';
import type { Supervised } from './supervisor.js';
import { byDeadline, seconds, type Clock } from './waits.js';

/** How a scenario went, by the chain: what docs/results.md shows, and why it failed if it did. */
export interface Graded {
  kills: number;
  killsMidHandler: number; // supervisor kills that caught a worker holding a withdrawal
  verdict: Verdict;
  drift: bigint; // the largest absolute reconciliation drift over the scenario's assets
  problems: string[]; // why the scenario failed, failed reconciliation checks included
  note?: string; // how this run's fault landed, for its line and docs/results.md
}

export const count = async (rows: Promise<{ n: number }[]>) => (await rows)[0]?.n ?? 0;
export const unfinished = (db: Db) =>
  count(db`
    select count(*)::int as n from withdrawals where state not in ('SETTLED','FAILED','REJECTED')`);
export const everyIs = (db: Db, state: string) => async () =>
  (await count(db`select count(*)::int as n from withdrawals where state <> ${state}`)) === 0;
export const withEvent = (db: Db, kind: string) =>
  count(db`
    select count(*)::int as n from withdrawals w
     where exists (select 1 from withdrawal_events e
                    where e.withdrawal_id = w.id and e.kind = ${kind})`);
export const withoutEvent = (db: Db, kind: string) =>
  count(db`
    select count(*)::int as n from withdrawals w
     where not exists (select 1 from withdrawal_events e
                        where e.withdrawal_id = w.id and e.kind = ${kind})`);
export const withFewerAttempts = (db: Db, min: number) =>
  count(db`
    select count(*)::int as n from withdrawals w
     where (select count(*) from tx_attempts t where t.withdrawal_id = w.id) < ${min}`);
// withdrawals that did not settle on one of their attempts numbered `from` to `to`
export const notSettledOn = (db: Db, from: number, to: number) =>
  count(db`
    select count(*)::int as n from withdrawals w
     where not exists (select 1 from tx_attempts t
                        where t.withdrawal_id = w.id and t.txid = w.settled_txid
                          and t.attempt_no between ${from} and ${to})`);
const txids = async (rows: Promise<{ txid: string }[]>) => (await rows).map((r) => r.txid);
export const allAttempts = (db: Db) => txids(db`select txid from tx_attempts`);
export const firstAttempts = (db: Db) =>
  txids(db`select txid from tx_attempts where attempt_no = 1`);

/**
 * Reads the chain only once nothing more can change on it: whatever the workers sent is mined in
 * and final, and the node holds nothing else from the hot wallet (Devnet.pendingFrom: on
 * Bitcoin, no mempool spend of a hot-wallet coin). A transaction still held (one behind a nonce
 * gap, say) could move money after the balances were read.
 */
export async function grade(env: PipelineEnv, box: Sandbox) {
  await env.devnet.mine(env.adapter.finalityDepth + 1);
  const left = await env.devnet.pendingFrom(box.hot.hotAddress);
  const verdict = await verifyAgainstChain(box.db, box.chains);
  const report = await reconcile(box.db, box.chains, { [env.chain]: env.assets });
  return { left, verdict, report };
}

export interface Expected {
  settled: number;
  rejected?: number;
  check?: () => Promise<string[]>; // the scenario's own problems: did its fault happen at all
  note?: string;
}

/** How every scenario ends, under its deadline: grade(), then the problems that fail it. */
export async function finish(
  { env, box }: { env: PipelineEnv; box: Sandbox },
  c: Clock,
  sup: Supervised,
  e: Expected,
): Promise<Graded> {
  const problems: string[] = [];
  if (sup.timedOut) problems.push(`timed out after ${seconds(c.started)} s`);
  const check = e.check ?? (() => Promise.resolve([]));
  const graded = (async () => ({ ...(await grade(env, box)), own: await check() }))();
  const { left, verdict, report, own } = await byDeadline(c.deadline, c.started, graded);
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const drift = report.rows.reduce((max, r) => (abs(r.drift) > max ? abs(r.drift) : max), 0n);
  const { sentTwice, lost, unfinished, settled, rejected } = verdict;
  if (left > 0) problems.push(`transactions left in the mempool: ${left}`);
  if (sentTwice + lost + unfinished > 0) problems.push('sent twice, lost or unfinished');
  // every accepted withdrawal here is valid and funded: a fault must not change how one ends
  if (settled !== e.settled) problems.push(`${settled} of ${e.settled} settled`);
  const refused = e.rejected ?? 0;
  if (rejected !== refused) problems.push(`${rejected} rejected, expected ${refused}`);
  if (drift !== 0n) problems.push(`reconciliation drift ${drift}`);
  for (const r of report.checks.filter((r) => !r.ok)) {
    problems.push(`reconciliation check ${r.name}: ${r.detail}`);
  }
  problems.push(...own);
  const { kills, killsMidHandler } = sup;
  return { kills, killsMidHandler, verdict, drift, problems, note: e.note };
}
