// The fault-injection scenarios: each scenario's function, then the description
// docs/results.md prints for it. Every scenario runs on a fresh sandbox, makes its fault while
// worker processes run the pipeline, and ends the same way (finish in scripts/lib/grading.ts):
// extra blocks, an empty mempool, the destinations' balances on the chain, and reconciliation.
// Chain-specific steps go through PipelineEnv: another chain needs its PipelineEnv and an entry in
// the envs map of scripts/fault-run.ts, not new scenario code.
import { randomUUID } from 'node:crypto';
import { openSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../../src/config.js';
import { startMiner } from '../../src/conformance/harness.js';
import type { AssetId } from '../../src/core/adapter.js';
import { crashPoints, type CrashPoint } from '../../src/pipeline/crash.js';
import { connect } from '../../src/pipeline/db.js';
import {
  submitWithdrawal,
  type RequestDeps,
  type Withdrawal,
  type WithdrawalRequest,
} from '../../src/pipeline/requests.js';
import type { PipelineEnv } from './env.js';
import {
  allAttempts,
  count,
  everyIs,
  finish,
  firstAttempts,
  notSettledOn,
  unfinished,
  withEvent,
  withFewerAttempts,
  withoutEvent,
  type Graded,
} from './grading.js';
import { openSandbox, sandboxPolicy } from './sandbox.js';
import {
  supervise,
  superviseUntilDone,
  type Run,
  type Supervised,
  type SuperviseOptions,
  type WorkerOptions,
} from './supervisor.js';
import { clock, mining, startMinerWhen, type Clock } from './waits.js';

export interface FaultRun extends Run {
  env: PipelineEnv;
  logPath: string;
}

export interface Scenario {
  name: string; // what --only takes
  title: string; // the scenario column of the table
  about: string; // one line for docs/results.md
  withdrawals?: { full: number; quick: number }; // otherwise --per-scenario (10, or 2 with --quick)
  // Why the chain of `env` cannot produce this fault, if it cannot. The run then lists the
  // scenario as not applicable on that chain, with this reason, instead of running it.
  notApplicable?(env: PipelineEnv): string | undefined;
  run(run: FaultRun, n: number, interrupt: AbortSignal, quick: boolean): Promise<Graded>;
}

// A short lease, so the lease a killed worker leaves behind soon expires. A stuck threshold long
// enough that nothing is replaced unless a scenario wants it.
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

const forWorkers = (c: Clock) => c.deadline - GRADING_MS - Date.now();
const none: Supervised = { kills: 0, killsMidHandler: 0, timedOut: false };
const add = (a: Supervised, b: Supervised): Supervised => ({
  kills: a.kills + b.kills,
  killsMidHandler: a.killsMidHandler + b.killsMidHandler,
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

type WorkUntil = (until: () => Promise<boolean>) => Promise<boolean>;

/**
 * Workers run with no blocks until every withdrawal is BROADCAST, then stop. `fault` runs with no
 * worker running, so nothing it does races a worker's reaction to it; it can run workers again,
 * still without blocks, through `workUntil`, which is false once time is up. Then workers (with
 * `after`) and the miner run until every withdrawal is terminal.
 */
async function faultAtBroadcast(
  run: FaultRun,
  c: Clock,
  interrupt: AbortSignal,
  fault: (workUntil: WorkUntil) => Promise<void>,
  after: WorkerOptions = { timings },
): Promise<Supervised> {
  let sup = none;
  const workUntil: WorkUntil = async (until) => {
    sup = add(sup, await supervise(run, { timings }, forWorkers(c), { until }, interrupt));
    return !sup.timedOut;
  };
  if (!(await workUntil(everyIs(run.box.db, 'BROADCAST')))) return sup;
  await fault(workUntil);
  if (sup.timedOut) return sup;
  const rest = await mining(startMiner(run.env.devnet, MINE_EVERY_MS), () =>
    superviseUntilDone(run, after, forWorkers(c), interrupt),
  );
  return add(sup, rest);
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
  const miner = replacing
    ? startMinerWhen(env.devnet, MINE_EVERY_MS, async () => !(await withFewerAttempts(box.db, 2)))
    : startMiner(env.devnet, MINE_EVERY_MS);
  const sup = await mining(miner, () => superviseUntilDone(run, opts, forWorkers(c), interrupt));
  const check = async () => {
    const injected = await count(box.db`
      select count(distinct withdrawal_id)::int as n from withdrawal_events
       where kind = 'crash_injected' and data->>'point' = ${point}`);
    const problems: string[] = [];
    if (sup.kills !== injected) problems.push(`${sup.kills} kills, ${injected} crash_injected`);
    if (sup.kills < n) problems.push(`${sup.kills} kills for ${n} withdrawals`);
    if (point === 'after_broadcast') {
      // The killed worker sent attempt 1 only after the node said it did not have it, and nothing
      // else sends while the state is SIGNED. So a restarted worker that finds it on the node
      // (sent: false, already_known) proves the killed worker's send was accepted, and that it
      // was not sent again.
      const notFound = await count(box.db`
        select count(*)::int as n from tx_attempts t
         where t.attempt_no = 1 and not exists (
           select 1 from withdrawal_events e
            where e.withdrawal_id = t.withdrawal_id and e.kind = 'broadcast'
              and e.data->>'txid' = t.txid and e.data->>'sent' = 'false'
              and e.data->>'outcome' = 'already_known')`);
      if (notFound > 0) {
        problems.push(
          `${notFound} first attempts were not found on the node by the restarted worker`,
        );
      }
    }
    return problems;
  };
  return finish(run, c, sup, { settled: n, check });
}

const where: Record<CrashPoint, string> = {
  after_reserve: 'after the reservation (nonce or coins) and fee are committed, before signing',
  after_sign: 'after signing in memory, before the attempt is stored',
  after_store: 'after the signed attempt is committed, before it is sent',
  before_broadcast: 'after the node said it does not have the transaction, just before the send',
  after_broadcast:
    'after the node accepted the transaction, before the broadcast is recorded; the restarted ' +
    'worker must find each transaction on the node and record its broadcast without sending it',
  after_broadcast_recorded: 'right after the broadcast is recorded',
  before_settle: 'after the transaction is seen final, before the settlement is posted',
  after_settle: 'right after the settlement is committed',
  after_replacement_store:
    'after a replacement is stored, before it is sent; blocks wait until every withdrawal has ' +
    `one (an attempt is stale after ${STALE_MS / 1000} s), and each withdrawal then settles on ` +
    'whichever of its attempts confirms, the original or a replacement',
};

const killScenarios = crashPoints.map((point): Scenario => ({
  name: point,
  title: `kill at ${point}`,
  about: `killed ${where[point]}.`,
  run: (run, n, interrupt) => killAt(run, point, n, interrupt),
}));

const RANDOM_WORKERS = 4;
const KILL_EVERY_MS: [number, number] = [150, 600]; // between kill attempts
// Random kills spare a worker for its first KILL_AFTER_MS past start-up, so each worker gets to
// work however long start-up takes. Under load four workers took up to 4 s to start, and with a
// kill every few hundred ms they did little else. A withdrawal took 0.1 to 1.3 s of worker time
// at loads of 7 to 23 on 12 cores, so 1.5 s covers at least one withdrawal's steps.
const KILL_AFTER_MS = 1500;
const RANDOM_BATCH = 20;
const RANDOM_COUNT = { full: 100, quick: 40 };
const RANDOM_HELD_KILLS = { full: 20, quick: 3 };
const RANDOM_MAX = 1500; // the most it submits; the user is credited for all of them up front
const RANDOM_BUDGET_MS = { base: 60_000, perWithdrawal: 2_000 }; // grading included
const randomBudgetFor = (n: number) => RANDOM_BUDGET_MS.base + RANDOM_BUDGET_MS.perWithdrawal * n;
const RANDOM_SETTLE_MS = 30_000; // the workers' time left after the last batch, for the backlog

// A kill that leaves a withdrawal leased to the dead worker interrupted a handler. Withdrawals are
// submitted only once the workers can be killed, so the kills meet the work from its start
// (SuperviseOptions.submit): on a fast machine a fixed count can finish before many kills happen.
async function randomKills(
  run: FaultRun,
  n: number,
  interrupt: AbortSignal,
  quick: boolean,
): Promise<Graded> {
  const { box } = run;
  const heldKills = RANDOM_HELD_KILLS[quick ? 'quick' : 'full'];
  const c = clock(randomBudgetFor(n));
  const plan = await creditFor(run, RANDOM_MAX);
  const lastBatchBy = c.deadline - GRADING_MS - RANDOM_SETTLE_MS;
  let submitted = 0;
  const how: SuperviseOptions = {
    workers: RANDOM_WORKERS,
    killEveryMs: KILL_EVERY_MS,
    killAfterMs: KILL_AFTER_MS,
    submit: async (sofar) => {
      while (submitted < n || sofar().killsMidHandler < heldKills) {
        if (interrupt.aborted || Date.now() > lastBatchBy || submitted >= plan.length) return;
        if ((await unfinished(box.db)) >= RANDOM_BATCH) {
          await sleep(50);
          continue;
        }
        const batch = plan.slice(submitted, submitted + RANDOM_BATCH);
        await Promise.all(batch.map((w) => box.withdraw(w.asset, w.amount)));
        submitted += batch.length;
      }
    },
  };
  const sup = await mining(startMiner(run.env.devnet, MINE_EVERY_MS), () =>
    supervise(run, { timings }, forWorkers(c), how, interrupt),
  );
  const note =
    `${sup.killsMidHandler} of the ${sup.kills} kills caught a worker holding a withdrawal ` +
    `(at least ${heldKills} required)`;
  const check = () => {
    const problems: string[] = [];
    if (submitted < n) problems.push(`${submitted} withdrawals submitted, fewer than ${n}`);
    if (sup.killsMidHandler < heldKills) {
      problems.push(
        `${sup.killsMidHandler} kills caught a worker holding a withdrawal, not ${heldKills}`,
      );
    }
    return Promise.resolve(problems);
  };
  return finish(run, c, sup, { settled: submitted, check, note });
}

const randomKillsScenario: Scenario = {
  name: 'random_kills',
  title: `random kills, ${RANDOM_WORKERS} workers`,
  about:
    `${RANDOM_WORKERS} workers at once, no crash point. Once each has run ` +
    `${KILL_AFTER_MS / 1000} s past start-up, withdrawals are submitted ${RANDOM_BATCH} at a ` +
    `time, each to its own fresh address, whenever fewer than ${RANDOM_BATCH} are unfinished, ` +
    `until at least ${RANDOM_COUNT.full} were submitted and at least ` +
    `${RANDOM_HELD_KILLS.full} kills caught a worker holding a withdrawal ` +
    `(${RANDOM_COUNT.quick} and ${RANDOM_HELD_KILLS.quick} with --quick); then every ` +
    `withdrawal must settle. From the first batch on, every ${KILL_EVERY_MS[0]} to ` +
    `${KILL_EVERY_MS[1]} ms the supervisor picks a random worker that has run at least ` +
    `${KILL_AFTER_MS / 1000} s past start-up, if there is one, SIGKILLs it and starts ` +
    "another. A kill caught a worker holding a withdrawal when that withdrawal's lease is " +
    "still in the dead worker's name. The minimum must be reached, and everything settled " +
    `and graded, within ${RANDOM_BUDGET_MS.base / 1000} s + ` +
    `${RANDOM_BUDGET_MS.perWithdrawal / 1000} s per withdrawal of the minimum count.`,
  withdrawals: RANDOM_COUNT,
  run: randomKills,
};

const COPIES = 5; // concurrent submissions of each request, one database connection each
const REFUSALS = ['not_allowlisted', 'over_withdrawal_limit'] as const;

// The withdrawals are the distinct keys.
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
    policy: (_chain, asset) => ({ ...sandboxPolicy(env), perWithdrawalMax: limit(asset) }),
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
  const refusedBy: Record<(typeof REFUSALS)[number], () => Promise<WithdrawalRequest>> = {
    not_allowlisted: async () => request('native', env.unit('native'), await env.freshAddress()),
    over_withdrawal_limit: async () =>
      request('native', limit('native') + 1n, await box.allowFresh()),
  };
  const refused: WithdrawalRequest[] = [];
  for (const reason of REFUSALS) refused.push(await refusedBy[reason]());
  const all = [...valid, ...refused];

  // separate clients, so the copies of a request are concurrent whatever a pool's size
  const clients = Array.from({ length: COPIES }, () => connect(config.databaseUrl, box.schema));
  let first: Withdrawal[][];
  try {
    const copies = (req: WithdrawalRequest) =>
      Promise.all(clients.map((db) => submitWithdrawal(db, deps, req)));
    first = await Promise.all(all.map(copies));
  } finally {
    await Promise.all(clients.map((db) => db.end()));
  }
  const sup = await mining(startMiner(env.devnet, MINE_EVERY_MS), () =>
    superviseUntilDone(run, { timings }, forWorkers(c), interrupt),
  );
  const again = await Promise.all(all.map((req) => submitWithdrawal(box.db, deps, req)));

  const check = async () => {
    const problems: string[] = [];
    all.forEach((req, i) => {
      const answers: (Withdrawal | undefined)[] = [...(first[i] ?? []), again[i]];
      const ids = new Set(answers.map((w) => w?.id));
      if (ids.size !== 1) problems.push(`key ${req.idempotencyKey}: ${ids.size} withdrawals`);
    });
    REFUSALS.forEach((reason, i) => {
      const w = again[valid.length + i];
      if (w?.rejectReason !== reason) {
        problems.push(`${w?.state} (${w?.rejectReason}), not ${reason}`);
      }
    });
    const [row] = await box.db<{ rows: number; keys: number }[]>`
      select count(*)::int as rows, count(distinct idempotency_key)::int as keys from withdrawals`;
    if (row?.rows !== all.length || row.keys !== all.length) {
      problems.push(`${row?.rows} withdrawals, ${row?.keys} keys, for ${all.length} keys sent`);
    }
    return problems;
  };
  return finish(run, c, sup, { settled: n, rejected: REFUSALS.length, check });
}

const duplicateRequestsScenario: Scenario = {
  name: 'duplicate_requests',
  title: 'duplicate requests',
  about:
    `every request is submitted ${COPIES} times at once with one idempotency key, over ` +
    `${COPIES} database connections, and again after the run; ${REFUSALS.length} more are ` +
    `refused by policy (${REFUSALS.join(', ')}) and must stay refused.`,
  run: duplicateRequests,
};

async function droppedTx(run: FaultRun, n: number, interrupt: AbortSignal): Promise<Graded> {
  const { env, box } = run;
  const c = clock(budgetFor(n));
  await submitMany(run, n);
  const early: string[] = [];
  const pooled = () => env.devnet.pendingFrom(box.hot.hotAddress);
  const sup = await faultAtBroadcast(run, c, interrupt, async () => {
    const attempts = await allAttempts(box.db);
    const before = await pooled();
    if (before !== attempts.length) early.push(`the node held ${before} of ${attempts.length}`);
    for (const txid of attempts) await env.devnet.dropFromMempool(txid);
    const after = await pooled();
    if (after !== 0) early.push(`the node still held ${after} transactions after the drops`);
  });
  const check = async () => {
    const missing = await withoutEvent(box.db, 'rebroadcast');
    return [...early, ...(missing > 0 ? [`${missing} withdrawals were not sent again`] : [])];
  };
  return finish(run, c, sup, { settled: n, check });
}

const droppedTxScenario: Scenario = {
  name: 'dropped_tx',
  title: 'dropped transaction',
  about:
    'no blocks until every withdrawal is broadcast; then, with the workers stopped, every ' +
    "attempt is dropped from the node's mempool (it held all of them, and none after); then " +
    'workers and blocks resume, and each withdrawal must be sent again and settle.',
  run: droppedTx,
};

// With blocks while the workers watch for the reorg, a transaction still in the mempool could be
// mined again before a worker saw it out of a block, and record a move from one block to another
// instead; so they run without blocks until each has recorded it. stuckAfterMs is long, so no
// replacement.
async function reorg(run: FaultRun, n: number, interrupt: AbortSignal): Promise<Graded> {
  const { env, box } = run;
  const c = clock(budgetFor(n));
  await submitMany(run, n);
  const allSeenInABlock = async () =>
    (await count(box.db`
      select count(*)::int as n from withdrawals w
       where not exists (select 1 from tx_attempts t
                          where t.withdrawal_id = w.id and t.seen_block is not null)`)) === 0;
  const allSeenBlocksCleared = async () =>
    (await count(
      box.db`select count(*)::int as n from tx_attempts where seen_block is not null`,
    )) === 0;
  const early: string[] = [];
  const sup = await faultAtBroadcast(run, c, interrupt, async (workUntil) => {
    await env.devnet.mine(1);
    const tip = await env.adapter.getTip();
    if (!(await workUntil(allSeenInABlock))) return;
    if (!(await everyIs(box.db, 'BROADCAST')())) {
      early.push('a withdrawal settled before the reorg');
    }
    // anything else mining on this node now would make the reorg replace the wrong block
    const now = await env.adapter.getTip();
    if (now.hash !== tip.hash) {
      early.push(`blocks ${tip.height + 1} to ${now.height} were mined by something else`);
    }
    await env.devnet.reorg(1);
    const attempts = await allAttempts(box.db);
    for (const txid of attempts) {
      const s = await env.adapter.getTxStatus(txid);
      if (s.state === 'confirmed') early.push(`${txid} is still confirmed after the reorg`);
    }
    const left = await env.devnet.pendingFrom(box.hot.hotAddress);
    const kept = env.reorgKeepsMempool ? attempts.length : 0;
    if (left !== kept) early.push(`the node held ${left} of ${attempts.length} after the reorg`);
    await workUntil(allSeenBlocksCleared);
  });
  const check = async () => {
    const problems = [...early];
    const reorged = await withoutEvent(box.db, 'reorged_out');
    if (reorged > 0) problems.push(`${reorged} withdrawals recorded no reorged_out`);
    const notResent = await withoutEvent(box.db, 'rebroadcast');
    if (env.reorgKeepsMempool && notResent < n) {
      problems.push(`${n - notResent} withdrawals were sent again, though the node kept them`);
    }
    if (!env.reorgKeepsMempool && notResent > 0) {
      problems.push(`${notResent} withdrawals were not sent again`);
    }
    const other = await notSettledOn(box.db, 1, 1);
    if (other > 0) problems.push(`${other} withdrawals did not settle on their first attempt`);
    return problems;
  };
  return finish(run, c, sup, { settled: n, check });
}

const reorgScenario: Scenario = {
  name: 'reorg',
  title: 'reorg before finality',
  about:
    'no blocks until every withdrawal is broadcast; then one block, which the workers record at ' +
    'one confirmation; with the workers stopped, that block is replaced by an empty one and ' +
    'the node reports no attempt confirmed. A node that forgets the removed transactions ' +
    '(anvil) must then hold none of them, one that puts them back in its mempool (bitcoind) ' +
    'all of them. Workers run again, still without blocks, until each withdrawal has recorded ' +
    'its block as reorganised out (sending its attempt again where the node forgot it, and ' +
    'only there); then workers and blocks resume, and each must settle on that same attempt.',
  run: reorg,
};

// As F3 in the pipeline suite. A withdrawal may settle on any replacement, not necessarily its
// last: on a slow machine attempt 3 can be stored before attempt 2 confirms, and is then refused.
async function stuckFee(run: FaultRun, n: number, interrupt: AbortSignal): Promise<Graded> {
  const { env, box } = run;
  const c = clock(budgetFor(n));
  await submitMany(run, n);
  const after: WorkerOptions = { timings: { ...timings, stuckAfterMs: STALE_MS } };
  const early: string[] = [];
  const pooled = () => env.devnet.pendingFrom(box.hot.hotAddress);
  let sup: Supervised;
  try {
    sup = await faultAtBroadcast(
      run,
      c,
      interrupt,
      async () => {
        const attempts = (await allAttempts(box.db)).length;
        const before = await pooled();
        if (before !== attempts) early.push(`the node held ${before} of ${attempts}`);
        await env.makeStuck();
        await env.devnet.mine(1);
        const left = await pooled();
        const expected = env.stuckEvicts ? 0 : before;
        if (left !== expected) early.push(`the node held ${left} after the first block`);
      },
      after,
    );
  } finally {
    await env.clearStuck();
  }
  const check = async () => {
    const problems = [...early];
    const refused = await count(box.db`
      select count(*)::int as n from tx_attempts t
       where t.attempt_no = 1 and not exists (
         select 1 from withdrawal_events e
          where e.withdrawal_id = t.withdrawal_id and e.kind = 'broadcast'
            and e.data->>'txid' = t.txid and e.data->>'outcome' = 'accepted')`);
    if (refused > 0) problems.push(`${refused} first attempts were not accepted when sent`);
    const single = await withFewerAttempts(box.db, 2);
    if (single > 0) problems.push(`${single} withdrawals were never replaced`);
    // As F3: an evicted attempt is unknown, its re-send is refused, and the replacement records
    // why. One still waiting in the pool is pending: no re-send, so nothing refused.
    const firstReplaced = await box.db<{ rejected: string | null }[]>`
      select e.data->>'rejected' as rejected from tx_attempts t
        left join withdrawal_events e
          on e.withdrawal_id = t.withdrawal_id and e.kind = 'replacement'
         and e.data->>'replaces' = t.txid
       where t.attempt_no = 1`;
    const unlike = firstReplaced.filter((r) => (r.rejected !== null) !== env.stuckEvicts).length;
    if (unlike > 0) {
      const what = env.stuckEvicts ? 'a refused re-send of it' : 'no refused re-send';
      problems.push(`${unlike} replacements of a first attempt did not record ${what}`);
    }
    // a node that kept every attempt has each of them: none is sent again
    if (!env.stuckEvicts) {
      const resent = await withEvent(box.db, 'rebroadcast');
      if (resent > 0) problems.push(`${resent} withdrawals sent an attempt again`);
    }
    const other = await notSettledOn(box.db, 2, timings.maxAttempts);
    if (other > 0) problems.push(`${other} withdrawals did not settle on a replacement`);
    for (const txid of await firstAttempts(box.db)) {
      const s = await env.adapter.getTxStatus(txid);
      if (s.state === 'confirmed') problems.push(`first attempt ${txid} confirmed`);
    }
    return problems;
  };
  return finish(run, c, sup, { settled: n, check, note: env.stuckNote });
}

const stuckFeeScenario: Scenario = {
  name: 'stuck_fee',
  title: 'stuck fee',
  about:
    'no blocks until every withdrawal is broadcast, each first attempt accepted by the node; ' +
    'then, with the workers stopped, the harness raises the fee level blocks take from the next ' +
    'block on (how, on each chain, is in its note) and one block is mined. A node that evicts ' +
    'what pays less (anvil) then holds none of the first attempts, and each withdrawal must ' +
    'find its first attempt gone and have the re-send of it refused; a node that keeps it ' +
    'waiting (bitcoind) still holds all of them, and no attempt is re-sent and accepted. Then ' +
    'workers and blocks resume. Each withdrawal must replace its first attempt (an attempt is ' +
    `stale after ${STALE_MS / 1000} s); no first attempt may confirm, and each withdrawal must ` +
    'settle on a replacement.',
  run: stuckFee,
};

export const scenarios: Scenario[] = [
  ...killScenarios,
  randomKillsScenario,
  duplicateRequestsScenario,
  droppedTxScenario,
  reorgScenario,
  stuckFeeScenario,
];
