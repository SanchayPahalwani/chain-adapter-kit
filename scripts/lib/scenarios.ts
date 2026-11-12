// The fault-injection scenarios (spec section 11), one function each. Every scenario runs on a
// fresh sandbox, makes its fault while worker processes run the pipeline, and ends the same way:
// extra blocks, an empty mempool, the destinations' balances on the chain, and reconciliation.
// Chain-specific steps go through PipelineEnv, so another chain needs another env, not new code.
import { randomUUID } from 'node:crypto';
import { openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMiner } from '../../src/conformance/harness.js';
import type { AssetId } from '../../src/core/adapter.js';
import { crashPoints, type CrashPoint } from '../../src/pipeline/crash.js';
import type { Db } from '../../src/pipeline/db.js';
import { reconcile } from '../../src/pipeline/reconcile.js';
import {
  submitWithdrawal,
  type RequestDeps,
  type Withdrawal,
  type WithdrawalRequest,
} from '../../src/pipeline/requests.js';
import { verifyAgainstChain, type Verdict } from '../../src/pipeline/verify.js';
import type { PipelineEnv } from './env.js';
import { openSandbox, sandboxPolicy } from './sandbox.js';
import {
  supervise,
  superviseUntilDone,
  type Run,
  type Supervised,
  type WorkerOptions,
} from './supervisor.js';
import { byDeadline, seconds, startMinerWhen } from './waits.js';

/** How a scenario went, by the chain: what docs/results.md shows, and why it failed if it did. */
export interface Graded {
  kills: number;
  verdict: Verdict;
  drift: bigint; // the largest absolute reconciliation drift over the scenario's assets
  problems: string[]; // why the scenario failed, failed reconciliation checks included
}

export interface FaultRun extends Run {
  env: PipelineEnv;
  logPath: string;
}

export interface Scenario {
  name: string; // what --only takes
  title: string; // the first column of the table
  about: string; // one line for docs/results.md
  withdrawals?: { full: number; quick: number }; // otherwise --per-scenario (10, or 2 with --quick)
  run(run: FaultRun, n: number, interrupt: AbortSignal): Promise<Graded>;
}

// A short lease, so the lease a killed worker leaves behind soon expires. A stuck threshold long
// enough that nothing is replaced unless a scenario holds the blocks back.
const timings: WorkerOptions['timings'] = {
  leaseMs: 1000,
  pollMs: 50,
  stuckAfterMs: 20_000,
  maxAttempts: 5,
};
const STALE_MS = 1500; // stuckAfterMs where a scenario wants replacements
const MINE_EVERY_MS = 100;
const budgetFor = (n: number) => 30_000 + 10_000 * n; // the whole scenario, grading included
const GRADING_MS = 20_000; // the end of each scenario's time, kept for grading

interface Clock {
  started: number;
  deadline: number;
}
function clock(ms: number): Clock {
  const started = Date.now();
  return { started, deadline: started + ms };
}
const forWorkers = (c: Clock) => c.deadline - GRADING_MS - Date.now();
const add = (a: Supervised, b: Supervised): Supervised => ({
  kills: a.kills + b.kills,
  timedOut: a.timedOut || b.timedOut,
});

// A fresh schema, seed and hot wallet funded on-chain and in the ledger, a credited user and the
// policy (scripts/lib/sandbox.ts), and one file for the output of all the scenario's workers.
// The token float lets a duplicated token transfer land, so it shows as sent twice.
export async function setup(env: PipelineEnv): Promise<FaultRun> {
  const box = await openSandbox(env, { tokenFloat: true });
  const logPath = join(tmpdir(), `fault-run-${box.schema}.log`);
  return { env, box, logPath, logFd: openSync(logPath, 'w') };
}

// Alternates the assets, each withdrawal for its own amount, and credits the user for them all.
async function creditFor(run: FaultRun, n: number) {
  const { env, box } = run;
  const plan = Array.from({ length: n }, (_, i) => {
    const asset = env.assets[i % env.assets.length] ?? 'native';
    return { asset, amount: env.unit(asset) + BigInt(i) };
  });
  for (const asset of env.assets) {
    const total = plan.filter((w) => w.asset === asset).reduce((sum, w) => sum + w.amount, 0n);
    if (total > 0n) await box.credit(asset, total);
  }
  return plan;
}

// Each withdrawal to its own fresh allowlisted address, so a transfer sent to the wrong
// destination shows as one sent twice and one lost.
async function submitMany(run: FaultRun, n: number): Promise<void> {
  for (const w of await creditFor(run, n)) await run.box.withdraw(w.asset, w.amount);
}

const count = async (rows: Promise<{ n: number }[]>) => (await rows)[0]?.n ?? 0;
const everyIs = (db: Db, state: string) => async () =>
  (await count(db`select count(*)::int as n from withdrawals where state <> ${state}`)) === 0;
const withoutEvent = (db: Db, kinds: string[]) =>
  count(db`
    select count(*)::int as n from withdrawals w
     where not exists (select 1 from withdrawal_events e
                        where e.withdrawal_id = w.id and e.kind in ${db(kinds)})`);

async function mining<T>(stopMiner: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await stopMiner();
  }
}

// Reads the chain only once nothing more can change on it: whatever the workers sent is mined in
// and final, and the node holds nothing else from the hot wallet. A transaction still held (one
// behind a nonce gap, say) could move money after the balances were read.
async function grade(run: FaultRun) {
  const { env, box } = run;
  await env.devnet.mine(env.adapter.finalityDepth + 1);
  const left = await env.devnet.pendingFrom(box.hot.hotAddress);
  const verdict = await verifyAgainstChain(box.db, box.chains);
  const report = await reconcile(box.db, box.chains, { [env.chain]: env.assets });
  return { left, verdict, report };
}

/**
 * How every scenario ends, under its deadline: grade(), then the problems that fail it. `check`
 * adds the scenario's own, such as whether its fault happened at all.
 */
async function finish(
  run: FaultRun,
  c: Clock,
  { kills, timedOut }: Supervised,
  expected: { settled: number; rejected?: number },
  check: () => Promise<string[]> = () => Promise.resolve([]),
): Promise<Graded> {
  const problems: string[] = [];
  if (timedOut) problems.push(`timed out after ${seconds(c.started)} s`);
  const graded = (async () => ({ ...(await grade(run)), own: await check() }))();
  const { left, verdict, report, own } = await byDeadline(c.deadline, c.started, graded);
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const drift = report.rows.reduce((max, r) => (abs(r.drift) > max ? abs(r.drift) : max), 0n);
  const { sentTwice, lost, unfinished, settled, rejected } = verdict;
  if (left > 0) problems.push(`transactions left in the mempool: ${left}`);
  if (sentTwice + lost + unfinished > 0) problems.push('sent twice, lost or unfinished');
  // every accepted withdrawal here is valid and funded: a fault must not change how one ends
  if (settled !== expected.settled) problems.push(`${settled} of ${expected.settled} settled`);
  const refused = expected.rejected ?? 0;
  if (rejected !== refused) problems.push(`${rejected} rejected, expected ${refused}`);
  if (drift !== 0n) problems.push(`reconciliation drift ${drift}`);
  for (const r of report.checks.filter((r) => !r.ok)) {
    problems.push(`reconciliation check ${r.name}: ${r.detail}`);
  }
  problems.push(...own);
  return { kills, verdict, drift, problems };
}

// One worker at a time, each started with `point` switched on. Each withdrawal kills a worker
// there once (killOnce), and the next worker carries on from what had been committed.
async function killAt(
  run: FaultRun,
  point: CrashPoint,
  n: number,
  interrupt: AbortSignal,
): Promise<Graded> {
  const { env, box } = run;
  const c = clock(budgetFor(n));
  await submitMany(run, n);
  // A replacement is made only for a transaction still unconfirmed after stuckAfterMs, so this
  // scenario holds the blocks back until every withdrawal has its second attempt.
  const replacing = point === 'after_replacement_store';
  const stuckAfterMs = replacing ? STALE_MS : timings.stuckAfterMs;
  const opts: WorkerOptions = { crashAt: point, timings: { ...timings, stuckAfterMs } };
  const everyHasSecondAttempt = async () =>
    (await count(box.db`
      select count(*)::int as n from withdrawals w
       where (select count(*) from tx_attempts t where t.withdrawal_id = w.id) < 2`)) === 0;
  const miner = replacing
    ? startMinerWhen(env.devnet, MINE_EVERY_MS, everyHasSecondAttempt)
    : startMiner(env.devnet, MINE_EVERY_MS);
  const sup = await mining(miner, () => superviseUntilDone(run, opts, forWorkers(c), interrupt));
  return finish(run, c, sup, { settled: n }, async () => {
    const injected = await count(box.db`
      select count(distinct withdrawal_id)::int as n from withdrawal_events
       where kind = 'crash_injected' and data->>'point' = ${point}`);
    const problems: string[] = [];
    if (sup.kills !== injected) problems.push(`${sup.kills} kills, ${injected} crash_injected`);
    if (sup.kills < n) problems.push(`${sup.kills} kills for ${n} withdrawals`);
    return problems;
  });
}

// No crash point: the supervisor kills the workers itself, wherever they happen to be.
async function randomKills(run: FaultRun, n: number, interrupt: AbortSignal): Promise<Graded> {
  const c = clock(60_000 + 1_000 * n);
  await submitMany(run, n);
  const sup = await mining(startMiner(run.env.devnet, MINE_EVERY_MS), () =>
    supervise(run, { timings }, forWorkers(c), { workers: 4, killEveryMs: [150, 600] }, interrupt),
  );
  return finish(run, c, sup, { settled: n }, () =>
    Promise.resolve(sup.kills > 0 ? [] : ['no worker was killed']),
  );
}

// Every request 5 times at once with one idempotency key, and once more after the run, so the
// withdrawals are the distinct keys. Two more are refused by policy and must stay refused.
async function duplicateRequests(
  run: FaultRun,
  n: number,
  interrupt: AbortSignal,
): Promise<Graded> {
  const { env, box } = run;
  const c = clock(budgetFor(n));
  const limit = (asset: AssetId) => 10n * env.unit(asset);
  const deps: RequestDeps = {
    ...box.requestDeps,
    policy: (_chain, asset) => ({ ...sandboxPolicy, perWithdrawalMax: limit(asset) }),
  };
  const request = (asset: AssetId, amount: bigint, to: string): WithdrawalRequest => ({
    idempotencyKey: randomUUID(),
    userId: box.userId,
    chain: env.chain,
    asset,
    to,
    amount,
  });
  const valid: WithdrawalRequest[] = [];
  for (const w of await creditFor(run, n)) {
    valid.push(request(w.asset, w.amount, await box.allowFresh()));
  }
  const refused = [
    {
      reason: 'not_allowlisted',
      req: request('native', env.unit('native'), await env.freshAddress()),
    },
    {
      reason: 'over_withdrawal_limit',
      req: request('native', limit('native') + 1n, await box.allowFresh()),
    },
  ];
  const all = [...valid, ...refused.map((r) => r.req)];
  const submit = (req: WithdrawalRequest) => submitWithdrawal(box.db, deps, req);
  const five = (req: WithdrawalRequest) => Promise.all([1, 2, 3, 4, 5].map(() => submit(req)));
  const first = await Promise.all(all.map(five));

  const sup = await mining(startMiner(env.devnet, MINE_EVERY_MS), () =>
    superviseUntilDone(run, { timings }, forWorkers(c), interrupt),
  );
  const again = await Promise.all(all.map(submit));
  return finish(run, c, sup, { settled: n, rejected: refused.length }, async () => {
    const problems: string[] = [];
    all.forEach((req, i) => {
      const answers: (Withdrawal | undefined)[] = [...(first[i] ?? []), again[i]];
      const ids = new Set(answers.map((w) => w?.id));
      if (ids.size !== 1) problems.push(`key ${req.idempotencyKey}: ${ids.size} withdrawals`);
    });
    refused.forEach(({ reason }, i) => {
      const w = again[valid.length + i];
      if (w?.rejectReason !== reason)
        problems.push(`${w?.state} (${w?.rejectReason}), not ${reason}`);
    });
    const [row] = await box.db<{ rows: number; keys: number }[]>`
      select count(*)::int as rows, count(distinct idempotency_key)::int as keys from withdrawals`;
    if (row?.rows !== all.length || row.keys !== all.length) {
      problems.push(`${row?.rows} withdrawals, ${row?.keys} keys, for ${all.length} keys sent`);
    }
    return problems;
  });
}

// No blocks until every withdrawal is broadcast. No worker runs while the parent drops: a re-send
// that reached the node between a drop and the drop's own check would read as a failed drop.
async function droppedTx(run: FaultRun, n: number, interrupt: AbortSignal): Promise<Graded> {
  const { env, box } = run;
  const c = clock(budgetFor(n));
  await submitMany(run, n);
  const opts: WorkerOptions = { timings };
  const until = everyIs(box.db, 'BROADCAST');
  let sup = await supervise(run, opts, forWorkers(c), { until }, interrupt);
  if (!sup.timedOut) {
    const attempts = await box.db<{ txid: string }[]>`select txid from tx_attempts`;
    for (const { txid } of attempts) await env.devnet.dropFromMempool(txid);
    const rest = await mining(startMiner(env.devnet, MINE_EVERY_MS), () =>
      superviseUntilDone(run, opts, forWorkers(c), interrupt),
    );
    sup = add(sup, rest);
  }
  return finish(run, c, sup, { settled: n }, async () => {
    const missing = await withoutEvent(box.db, ['rebroadcast']);
    return missing > 0 ? [`${missing} withdrawals were not sent again after the drop`] : [];
  });
}

// No blocks until every withdrawal is broadcast; then one block, which the workers record with
// one confirmation (finality needs more). With no worker running, that block is replaced by an
// empty one, and the workers and the miner carry on.
async function reorg(run: FaultRun, n: number, interrupt: AbortSignal): Promise<Graded> {
  const { env, box } = run;
  const c = clock(budgetFor(n));
  await submitMany(run, n);
  const opts: WorkerOptions = { timings };
  const phase = (until: () => Promise<boolean>) =>
    supervise(run, opts, forWorkers(c), { until }, interrupt);
  const recorded = async () =>
    (await count(box.db`
      select count(*)::int as n from withdrawals w
       where not exists (select 1 from tx_attempts t
                          where t.withdrawal_id = w.id and t.seen_block is not null)`)) === 0;
  const early: string[] = [];
  let sup = await phase(everyIs(box.db, 'BROADCAST'));
  if (!sup.timedOut) {
    await env.devnet.mine(1);
    sup = add(sup, await phase(recorded));
  }
  if (!sup.timedOut) {
    if (!(await everyIs(box.db, 'BROADCAST')()))
      early.push('a withdrawal settled before the reorg');
    await env.devnet.reorg(1);
    const rest = await mining(startMiner(env.devnet, MINE_EVERY_MS), () =>
      superviseUntilDone(run, opts, forWorkers(c), interrupt),
    );
    sup = add(sup, rest);
  }
  return finish(run, c, sup, { settled: n }, async () => {
    const missing = await withoutEvent(box.db, ['reorg', 'reorged_out', 'rebroadcast']);
    return [...early, ...(missing > 0 ? [`${missing} withdrawals show no sign of the reorg`] : [])];
  });
}

// The fee level rises from the next block on, and the blocks wait until every first attempt is
// out, so each was quoted at the old level and none can confirm: every one must be replaced.
async function stuckFee(run: FaultRun, n: number, interrupt: AbortSignal): Promise<Graded> {
  const { env, box } = run;
  const c = clock(budgetFor(n));
  await submitMany(run, n); // first: crediting a token mines a block
  const opts: WorkerOptions = { timings: { ...timings, stuckAfterMs: STALE_MS } };
  await env.makeStuck();
  let sup: Supervised;
  try {
    const miner = startMinerWhen(env.devnet, MINE_EVERY_MS, everyIs(box.db, 'BROADCAST'));
    sup = await mining(miner, () => superviseUntilDone(run, opts, forWorkers(c), interrupt));
  } finally {
    await env.clearStuck();
  }
  return finish(run, c, sup, { settled: n }, async () => {
    const notReplaced = await count(box.db`
      select count(*)::int as n from withdrawals w
       where (select count(*) from tx_attempts t where t.withdrawal_id = w.id) < 2
          or settled_txid is distinct from (select txid from tx_attempts t
                                             where t.withdrawal_id = w.id
                                             order by attempt_no desc limit 1)`);
    return notReplaced > 0 ? [`${notReplaced} withdrawals did not settle on a replacement`] : [];
  });
}

const where: Record<CrashPoint, string> = {
  after_reserve: 'after the reservation (nonce or coins) and fee are committed, before signing',
  after_sign: 'after signing in memory, before the attempt is stored',
  after_store: 'after the signed attempt is committed, before it is sent',
  before_broadcast: 'after the node said it does not have the transaction, just before the send',
  after_broadcast: 'after the node accepted the transaction, before the broadcast is recorded',
  after_broadcast_recorded: 'right after the broadcast is recorded',
  before_settle: 'after the transaction is seen final, before the settlement is posted',
  after_settle: 'right after the settlement is committed',
  after_replacement_store:
    'after a replacement is stored, before it is sent; blocks wait until every withdrawal has ' +
    `one (an attempt is stale after ${STALE_MS / 1000} s)`,
};

export const scenarios: Scenario[] = [
  ...crashPoints.map((point): Scenario => ({
    name: point,
    title: `kill at ${point}`,
    about: `killed ${where[point]}.`,
    run: (run, n, interrupt) => killAt(run, point, n, interrupt),
  })),
  {
    name: 'random_kills',
    title: 'random kills, 4 workers',
    about:
      '4 workers at once, no crash point; the supervisor SIGKILLs a random one every 150 to 600 ms ' +
      'and starts another, until every withdrawal is done.',
    withdrawals: { full: 100, quick: 10 },
    run: randomKills,
  },
  {
    name: 'duplicate_requests',
    title: 'duplicate requests',
    about:
      'every request is submitted 5 times at once with one idempotency key, and again after the ' +
      'run; 2 more are refused by policy (address not allowlisted, amount over the limit).',
    run: duplicateRequests,
  },
  {
    name: 'dropped_tx',
    title: 'dropped transaction',
    about:
      'no blocks until every withdrawal is broadcast; with the workers stopped, every transaction ' +
      "is dropped from the node's mempool; then workers and blocks resume.",
    run: droppedTx,
  },
  {
    name: 'reorg',
    title: 'reorg before finality',
    about:
      'no blocks until every withdrawal is broadcast; one block, which the workers record at one ' +
      'confirmation; with the workers stopped, it is replaced by an empty block; then they resume.',
    run: reorg,
  },
  {
    name: 'stuck_fee',
    title: 'stuck fee',
    about:
      'the fee level is raised before the workers start and blocks wait until every withdrawal is ' +
      `broadcast, so no first attempt can confirm; each must be replaced (stale after ${STALE_MS / 1000} s).`,
    run: stuckFee,
  },
];
