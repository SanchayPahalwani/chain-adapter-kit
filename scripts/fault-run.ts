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
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { startMiner, type Devnet } from '../src/conformance/harness.js';
import { crashPoints, isCrashPoint, type CrashPoint } from '../src/pipeline/crash.js';
import type { Db } from '../src/pipeline/db.js';
import { reconcile } from '../src/pipeline/reconcile.js';
import { verifyAgainstChain, type Verdict } from '../src/pipeline/verify.js';
import type { PipelineEnv } from './lib/env.js';
import { makeEvmEnv } from './lib/evm-env.js';
import { openSandbox } from './lib/sandbox.js';
import { superviseUntilDone, type Run, type WorkerOptions } from './lib/supervisor.js';

interface ScenarioResult {
  name: string;
  kills: number;
  verdict: Verdict;
  drift: bigint; // the largest absolute reconciliation drift over the scenario's assets
  checksOk: boolean; // every reconciliation check passed
  problems: string[]; // why the scenario failed; empty when it passed
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
const timeoutFor = (n: number) => 20_000 + 10_000 * n;

// A fresh schema, seed and hot wallet funded on-chain and in the ledger, a credited user and the
// policy (scripts/lib/sandbox.ts), and one file for the output of all the scenario's workers.
async function setup(env: PipelineEnv): Promise<FaultRun> {
  const box = await openSandbox(env);
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

// The miner, started once `ready` holds; stop() works whether it started or not. A failed check
// counts as not ready, and the scenario then fails by its timeout.
function startMinerWhen(devnet: Devnet, ready: () => Promise<boolean>): () => Promise<void> {
  let stopped = false;
  let stopMiner = () => Promise.resolve();
  const waiting = (async () => {
    while (!stopped && !(await ready().catch(() => false))) await sleep(100);
    if (!stopped) stopMiner = startMiner(devnet, MINE_EVERY_MS);
  })();
  return async () => {
    stopped = true;
    await waiting;
    await stopMiner();
  };
}

// One worker at a time, each started with `point` switched on. Each withdrawal kills a worker
// there once (killOnce), and the next worker carries on from what had been committed.
async function killAt(run: FaultRun, point: CrashPoint, n: number): Promise<ScenarioResult> {
  const { env, box } = run;
  const ids = await submitMany(run, n);
  // A replacement is made only for a transaction still unconfirmed after stuckAfterMs, so this
  // scenario holds the blocks back until every withdrawal has its second attempt.
  const replacing = point === 'after_replacement_store';
  const stuckAfterMs = replacing ? 1500 : timings.stuckAfterMs;
  const opts: WorkerOptions = { crashAt: point, timings: { ...timings, stuckAfterMs } };
  const stopMiner = replacing
    ? startMinerWhen(env.devnet, () => everyHasSecondAttempt(box.db))
    : startMiner(env.devnet, MINE_EVERY_MS);
  let kills: number;
  try {
    kills = await superviseUntilDone(run, opts, timeoutFor(n));
  } finally {
    await stopMiner();
  }

  const verdict = await verifyAgainstChain(box.db, box.chains);
  const report = await reconcile(box.db, box.chains, { [env.chain]: env.assets });
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const drift = report.rows.reduce((max, r) => (abs(r.drift) > max ? abs(r.drift) : max), 0n);
  const failedChecks = report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);
  const [row] = await box.db<{ n: number }[]>`
    select count(distinct withdrawal_id)::int as n from withdrawal_events
     where kind = 'crash_injected' and data->>'point' = ${point}`;
  const injected = row?.n ?? 0;

  const { sentTwice, lost, unfinished, settled } = verdict;
  const problems: string[] = [];
  if (sentTwice + lost + unfinished > 0) problems.push('sent twice, lost or unfinished');
  // every withdrawal here is valid and funded: a crash must not change how one ends
  if (settled !== ids.length) problems.push(`${settled} of ${ids.length} withdrawals settled`);
  if (drift !== 0n) problems.push(`reconciliation drift ${drift}`);
  for (const c of failedChecks) problems.push(`reconciliation check ${c}`);
  if (kills !== injected) problems.push(`${kills} kills, ${injected} crash_injected withdrawals`);
  if (kills < ids.length) problems.push(`${kills} kills for ${ids.length} withdrawals`);
  const checksOk = failedChecks.length === 0;
  return { name: `kill at ${point}`, kills, verdict, drift, checksOk, problems };
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

const started = Date.now();
const env = await makeEvmEnv();
const results: ScenarioResult[] = [];
let failures = 0;
for (const point of points) {
  const run = await setup(env);
  let result: ScenarioResult | Error;
  try {
    result = await killAt(run, point, n);
  } catch (error) {
    result = error instanceof Error ? error : new Error(String(error));
  } finally {
    closeSync(run.logFd);
    await run.box.close({ keepSchema: args.keep });
  }
  const kept = args.keep ? ` (kept schema ${run.box.schema}, log ${run.logPath})` : '';
  if (result instanceof Error) {
    console.error(`kill at ${point}: ${result.message}${kept}`);
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

const sum = (f: (r: ScenarioResult) => number) => results.reduce((s, r) => s + f(r), 0);
const maxDrift = results.reduce((max, r) => (r.drift > max ? r.drift : max), 0n);
const outcome =
  failures === 0
    ? `all ${points.length} scenarios passed`
    : `${failures} of ${points.length} scenarios FAILED`;
console.log(
  `${outcome}: ${sum((r) => r.verdict.withdrawals)} withdrawals, ${sum((r) => r.kills)} kills, ` +
    `${sum((r) => r.verdict.settled)} settled, sent twice ${sum((r) => r.verdict.sentTwice)}, ` +
    `lost ${sum((r) => r.verdict.lost)}, unfinished ${sum((r) => r.verdict.unfinished)}, ` +
    `drift ${maxDrift} (${Math.round((Date.now() - started) / 1000)} s)`,
);
process.exitCode = failures > 0 ? 1 : 0;
