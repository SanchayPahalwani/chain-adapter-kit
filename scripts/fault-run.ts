// Kills a worker process with SIGKILL at each named crash point, restarts it, and grades every
// withdrawal by what its destination holds on the chain (spec section 11). One line per scenario
// and a summary; exit code 1 if any scenario fails.
//
//   npx tsx scripts/fault-run.ts [--quick | --per-scenario <n>] [--only <crash point>] [--keep]
//
// --quick: 2 withdrawals per scenario (default 10). --keep: keep each scenario's schema and log.
import { closeSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { startMiner } from '../src/conformance/harness.js';
import { crashPoints, isCrashPoint, type CrashPoint } from '../src/pipeline/crash.js';
import type { Db } from '../src/pipeline/db.js';
import { reconcile } from '../src/pipeline/reconcile.js';
import { verifyAgainstChain, type Verdict } from '../src/pipeline/verify.js';
import type { PipelineEnv } from './lib/env.js';
import { makeEvmEnv } from './lib/evm-env.js';
import { openSandbox } from './lib/sandbox.js';
import {
  superviseUntilDone,
  type Run,
  type Supervised,
  type WorkerOptions,
} from './lib/supervisor.js';
import { byDeadline, seconds, startMinerWhen } from './lib/waits.js';

interface ScenarioResult {
  name: string;
  kills: number;
  verdict: Verdict;
  drift: bigint; // the largest absolute reconciliation drift over the scenario's assets
  problems: string[]; // why the scenario failed, failed reconciliation checks included
}

interface FaultRun extends Run {
  env: PipelineEnv;
  logPath: string;
}

// A short lease, so the lease a killed worker leaves behind soon expires. A stuck threshold long
// enough that nothing is replaced unless a scenario holds the blocks back.
const timings: WorkerOptions['timings'] = {
  leaseMs: 1000,
  pollMs: 50,
  stuckAfterMs: 20_000,
  maxAttempts: 5,
};
const MINE_EVERY_MS = 100;
const timeoutFor = (n: number) => 30_000 + 10_000 * n; // the whole scenario, grading included
const GRADING_MS = 20_000; // the end of each scenario's time, kept for grading

// A fresh schema, seed and hot wallet funded on-chain and in the ledger, a credited user and the
// policy (scripts/lib/sandbox.ts), and one file for the output of all the scenario's workers.
// The token float lets a duplicated token transfer land, so it shows as sent twice.
async function setup(env: PipelineEnv): Promise<FaultRun> {
  const box = await openSandbox(env, { tokenFloat: true });
  const logPath = join(tmpdir(), `fault-run-${box.schema}.log`);
  return { env, box, logPath, logFd: openSync(logPath, 'w') };
}

// Alternates the assets, each withdrawal to its own fresh allowlisted address and for its own
// amount, so a transfer sent to the wrong destination shows as one sent twice and one lost.
async function submitMany(run: FaultRun, n: number): Promise<string[]> {
  const { env, box } = run;
  const plan = Array.from({ length: n }, (_, i) => {
    const asset = env.assets[i % env.assets.length] ?? 'native';
    return { asset, amount: env.unit(asset) + BigInt(i) };
  });
  for (const asset of env.assets) {
    const total = plan.filter((w) => w.asset === asset).reduce((sum, w) => sum + w.amount, 0n);
    if (total > 0n) await box.credit(asset, total);
  }
  const ids: string[] = [];
  for (const w of plan) ids.push((await box.withdraw(w.asset, w.amount)).id);
  return ids;
}

async function everyHasSecondAttempt(db: Db): Promise<boolean> {
  const [row] = await db<{ n: number }[]>`
    select count(*)::int as n from withdrawals w
     where (select count(*) from tx_attempts t where t.withdrawal_id = w.id) < 2`;
  return row?.n === 0;
}

// Reads the chain only once nothing more can change on it: whatever the workers sent is mined in
// and final, and the node holds nothing else from the hot wallet. A transaction still held (one
// behind a nonce gap, say) could move money after the balances were read.
async function grade(run: FaultRun, point: CrashPoint) {
  const { env, box } = run;
  await env.devnet.mine(env.adapter.finalityDepth + 1);
  const left = await env.devnet.pendingFrom(box.hot.hotAddress);
  const verdict = await verifyAgainstChain(box.db, box.chains);
  const report = await reconcile(box.db, box.chains, { [env.chain]: env.assets });
  const [row] = await box.db<{ n: number }[]>`
    select count(distinct withdrawal_id)::int as n from withdrawal_events
     where kind = 'crash_injected' and data->>'point' = ${point}`;
  return { left, verdict, report, injected: row?.n ?? 0 };
}

// One worker at a time, each started with `point` switched on. Each withdrawal kills a worker
// there once (killOnce), and the next worker carries on from what had been committed.
async function killAt(
  run: FaultRun,
  point: CrashPoint,
  n: number,
  interrupt: AbortSignal,
): Promise<ScenarioResult> {
  const { env, box } = run;
  const started = Date.now();
  const deadline = started + timeoutFor(n);
  const ids = await submitMany(run, n);
  // A replacement is made only for a transaction still unconfirmed after stuckAfterMs, so this
  // scenario holds the blocks back until every withdrawal has its second attempt.
  const replacing = point === 'after_replacement_store';
  const stuckAfterMs = replacing ? 1500 : timings.stuckAfterMs;
  const opts: WorkerOptions = { crashAt: point, timings: { ...timings, stuckAfterMs } };
  const stopMiner = replacing
    ? startMinerWhen(env.devnet, MINE_EVERY_MS, () => everyHasSecondAttempt(box.db))
    : startMiner(env.devnet, MINE_EVERY_MS);
  let supervised: Supervised;
  try {
    const supervising = deadline - GRADING_MS - Date.now();
    supervised = await superviseUntilDone(run, opts, supervising, interrupt);
  } finally {
    await stopMiner();
  }
  const { kills, timedOut } = supervised;
  const problems: string[] = [];
  if (timedOut) problems.push(`timed out after ${seconds(started)} s`);
  const { left, verdict, report, injected } = await byDeadline(
    deadline,
    started,
    grade(run, point),
  );

  const abs = (x: bigint) => (x < 0n ? -x : x);
  const drift = report.rows.reduce((max, r) => (abs(r.drift) > max ? abs(r.drift) : max), 0n);
  const { sentTwice, lost, unfinished, settled } = verdict;
  if (left > 0) problems.push(`transactions left in the mempool: ${left}`);
  if (sentTwice + lost + unfinished > 0) problems.push('sent twice, lost or unfinished');
  // every withdrawal here is valid and funded: a crash must not change how one ends
  if (settled !== ids.length) problems.push(`${settled} of ${ids.length} withdrawals settled`);
  if (drift !== 0n) problems.push(`reconciliation drift ${drift}`);
  for (const c of report.checks.filter((c) => !c.ok)) {
    problems.push(`reconciliation check ${c.name}: ${c.detail}`);
  }
  if (kills !== injected) problems.push(`${kills} kills, ${injected} crash_injected withdrawals`);
  if (kills < ids.length) problems.push(`${kills} kills for ${ids.length} withdrawals`);
  return { name: `kill at ${point}`, kills, verdict, drift, problems };
}

const line = (r: ScenarioResult) => {
  const v = r.verdict;
  return (
    `${r.name}: ${v.withdrawals} withdrawals, ${r.kills} kills, ${v.settled} settled, ` +
    `sent twice ${v.sentTwice}, lost ${v.lost}, unfinished ${v.unfinished}, drift ${r.drift}`
  );
};

function usage(message: string): never {
  console.error(message);
  console.error('usage: fault-run.ts [--quick | --per-scenario <n>] [--only <point>] [--keep]');
  process.exit(2);
}

const { values: args } = parseArgs({
  options: {
    quick: { type: 'boolean', default: false },
    'per-scenario': { type: 'string' },
    only: { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
if (args.quick && args['per-scenario'] !== undefined) usage('--quick or --per-scenario, not both');
const n = args.quick ? 2 : Number(args['per-scenario'] ?? 10);
if (!Number.isInteger(n) || n < 1) usage(`--per-scenario must be a positive integer`);
if (args.only !== undefined && !isCrashPoint(args.only)) usage(`unknown crash point ${args.only}`);
const points: readonly CrashPoint[] = args.only !== undefined ? [args.only] : crashPoints;

// Ctrl-C or SIGTERM: the current scenario stops its worker and its miner and drops its schema
// (unless --keep), then the run exits 130. Later signals are ignored while it cleans up: under
// `npx tsx` one Ctrl-C arrives twice, from the terminal and relayed by tsx.
const interrupt = new AbortController();
const onSignal = () => {
  if (interrupt.signal.aborted) return;
  console.error('interrupted: stopping the worker, then cleaning up');
  interrupt.abort();
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

const started = Date.now();
const env = await makeEvmEnv();
const results: ScenarioResult[] = [];
let failures = 0;
let unfinishedScenarios = 0;
for (const point of points) {
  if (interrupt.signal.aborted) break;
  const run = await setup(env);
  let result: ScenarioResult | Error;
  try {
    result = await killAt(run, point, n, interrupt.signal);
  } catch (error) {
    result = error instanceof Error ? error : new Error(String(error));
  } finally {
    closeSync(run.logFd);
    await run.box.close({ keepSchema: args.keep });
  }
  if (interrupt.signal.aborted) {
    if (!args.keep) rmSync(run.logPath);
    break;
  }
  const kept = args.keep ? ` (kept schema ${run.box.schema}, log ${run.logPath})` : '';
  if (result instanceof Error) {
    unfinishedScenarios++;
    console.error(`kill at ${point}: did not finish: ${result.message}${kept}`);
  } else {
    results.push(result);
    console.log(line(result) + kept);
    for (const p of result.problems) console.error(`  FAILED: ${p}`);
  }
  if (result instanceof Error || result.problems.length > 0) {
    failures++;
    console.error(`  worker log: ${run.logPath}`);
  } else if (!args.keep) {
    rmSync(run.logPath);
  }
}
if (interrupt.signal.aborted) {
  console.error('interrupted');
  process.exit(130);
}

// Totals only over every scenario: a summary that left a failed one out would read cleaner than
// the run was.
const sum = (f: (r: ScenarioResult) => number) => results.reduce((s, r) => s + f(r), 0);
const maxDrift = results.reduce((max, r) => (r.drift > max ? r.drift : max), 0n);
const totals =
  `${sum((r) => r.verdict.withdrawals)} withdrawals, ${sum((r) => r.kills)} kills, ` +
  `${sum((r) => r.verdict.settled)} settled, sent twice ${sum((r) => r.verdict.sentTwice)}, ` +
  `lost ${sum((r) => r.verdict.lost)}, unfinished ${sum((r) => r.verdict.unfinished)}, ` +
  `drift ${maxDrift}`;
const took = `(${seconds(started)} s)`;
if (failures === 0) {
  console.log(`all ${points.length} scenarios passed: ${totals} ${took}`);
} else if (unfinishedScenarios > 0) {
  console.log(
    `FAILED: ${failures} of ${points.length} scenarios, ${unfinishedScenarios} of them ` +
      `did not finish, so there are no totals ${took}`,
  );
} else {
  console.log(`FAILED: ${failures} of ${points.length} scenarios: ${totals} ${took}`);
}
process.exitCode = failures > 0 ? 1 : 0;
