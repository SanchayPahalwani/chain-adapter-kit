// Runs the fault-injection scenarios (scripts/lib/scenarios.ts) on each chain, one after another,
// each on its own sandbox, and grades every withdrawal by what its destination holds on the chain
// (spec section 11). One line per scenario and chain, then the table. docs/results.md is written
// only by the full matrix at default counts (every chain; no --chain, --quick, --only or
// --per-scenario), only when every scenario passed, and only if the checkout did not change during
// the run. Exit code 1 if any failed or the file could not be written, 130 if interrupted.
//
//   npx tsx scripts/fault-run.ts [--chain <name> | all] [--quick | --per-scenario <n>]
//                                [--only <name>,...] [--keep] [--json] [--no-write]
//
// --chain: evm-anvil or bitcoin-regtest (default all: both, in that order); each chain's node is
// the one its tests use (EVM_RPC_URL, BITCOIN_RPC_URL). --quick: 2 withdrawals per scenario
// (default 10); random_kills submits at least 40 and until 3 kills caught a worker holding one
// (default 100 and 20). --only: scenario names: a crash point, random_kills, duplicate_requests,
// dropped_tx, reorg, stuck_fee. --keep: keep each scenario's schema and log. --json: the results
// as one JSON document on stdout, and nothing else there. --no-write: leave docs/results.md as it
// is (as any partial run does).
import { closeSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { connect } from '../src/pipeline/db.js';
import { makeBitcoinEnv } from './lib/bitcoin-env.js';
import type { PipelineEnv } from './lib/env.js';
import { makeEvmEnv } from './lib/evm-env.js';
import {
  checkoutOf,
  RESULTS_PATH,
  resultsMarkdown,
  table,
  totalsOf,
  type Outcome,
  type Totals,
} from './lib/results.js';
import { scenarios, setup, type Graded, type Scenario } from './lib/scenarios.js';
import { seconds } from './lib/waits.js';

const root = fileURLToPath(new URL('../', import.meta.url));

// Each chain's test world, in the order the run takes them.
const envs: Record<string, () => Promise<PipelineEnv>> = {
  'evm-anvil': makeEvmEnv,
  'bitcoin-regtest': makeBitcoinEnv,
};

function usage(message: string): never {
  console.error(message);
  console.error(
    'usage: fault-run.ts [--chain <name> | all] [--quick | --per-scenario <n>] [--only <name>,...] ' +
      '[--keep] [--json] [--no-write]',
  );
  process.exit(2);
}

const { values: args } = parseArgs({
  options: {
    chain: { type: 'string', default: 'all' },
    quick: { type: 'boolean', default: false },
    'per-scenario': { type: 'string' },
    only: { type: 'string' },
    keep: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'no-write': { type: 'boolean', default: false },
  },
});
if (args.quick && args['per-scenario'] !== undefined) usage('--quick or --per-scenario, not both');
const chains = args.chain === 'all' ? Object.keys(envs) : [args.chain];
for (const chain of chains) {
  if (!Object.hasOwn(envs, chain)) {
    usage(`unknown chain ${chain} (known: ${Object.keys(envs).join(', ')}, all)`);
  }
}
const n = args.quick ? 2 : Number(args['per-scenario'] ?? 10);
if (!Number.isInteger(n) || n < 1) usage(`--per-scenario must be a positive integer`);
const only = args.only?.split(',').map((s) => s.trim());
for (const name of only ?? []) {
  if (!scenarios.some((s) => s.name === name)) usage(`unknown scenario ${name}`);
}
const selected = only ? scenarios.filter((s) => only.includes(s.name)) : scenarios;
// docs/results.md describes the whole matrix on every chain at its default counts, and nothing else
const partial =
  args.chain !== 'all' || args.quick || only !== undefined || args['per-scenario'] !== undefined;
// with --json, stdout carries the JSON document only
const say = args.json ? console.error : console.log;

// Ctrl-C or SIGTERM: the current scenario stops its workers and its miner and drops its schema
// (unless --keep), then the run exits 130. Under `npx tsx` one Ctrl-C arrives twice, from the
// terminal and relayed by tsx, so a second signal counts only a second after the first: then the
// run exits at once, cleanup or not.
const interrupt = new AbortController();
let interruptedAt = 0;
const onSignal = () => {
  if (!interrupt.signal.aborted) {
    interruptedAt = Date.now();
    console.error('interrupted: stopping the workers, then cleaning up (again to exit now)');
    interrupt.abort();
  } else if (Date.now() - interruptedAt > 1000) {
    writeSync(2, 'interrupted again: exiting without cleaning up\n'); // before the exit, unlike console
    process.exit(130);
  }
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

const started = Date.now();
// only a run that can write docs/results.md needs to know which code it ran
const checkout = args['no-write'] || partial ? undefined : checkoutOf(root);
const date = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const made: PipelineEnv[] = [];
for (const chain of chains) made.push(await envs[chain]!());
const nodes = made.map((e) => `${e.chain} (${e.nodeVersion})`).join(', ');
say(`fault run on ${nodes}`);

// the chain, padded to the longest name, then the scenario
const width = Math.max(...chains.map((c) => c.length));
const where = (chain: string, title: string) => `${chain.padEnd(width)}  ${title}`;
const line = (chain: string, title: string, g: Graded) => {
  const v = g.verdict;
  return (
    `${g.problems.length > 0 ? 'FAILED: ' : ''}${where(chain, title)}: ${v.withdrawals} ` +
    `withdrawals, ${g.kills} kills, ${v.settled} settled, ${v.rejected} rejected, sent twice ` +
    `${v.sentTwice}, lost ${v.lost}, unfinished ${v.unfinished}, drift ${g.drift}` +
    (g.note ? `; ${g.note}` : '')
  );
};

const outcomes: Outcome[] = [];
let failures = 0;
async function runAll() {
  for (const env of made) {
    for (const s of selected) {
      if (interrupt.signal.aborted) return;
      await runOne(env, s);
    }
  }
}

async function runOne(env: PipelineEnv, s: Scenario) {
  const named = { chain: env.chain, name: s.name, title: s.title, about: s.about };
  const notApplicable = s.notApplicable?.(env);
  if (notApplicable) {
    say(`${where(env.chain, s.title)}: not applicable: ${notApplicable}`);
    outcomes.push({ ...named, notApplicable });
    return;
  }
  const count = s.withdrawals ? s.withdrawals[args.quick ? 'quick' : 'full'] : n;
  const run = await setup(env);
  const outcome: Outcome = { ...named };
  try {
    outcome.graded = await s.run(run, count, interrupt.signal, args.quick);
  } catch (error) {
    outcome.error = error instanceof Error ? error.message : String(error);
  }
  closeSync(run.logFd);
  let cleanup: string | undefined;
  try {
    await run.box.close({ keepSchema: args.keep });
  } catch (error) {
    cleanup = `could not drop schema ${run.box.schema}: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (interrupt.signal.aborted) {
    if (cleanup) console.error(cleanup);
    if (!args.keep) rmSync(run.logPath, { force: true });
    return;
  }
  const kept = args.keep ? ` (kept schema ${run.box.schema}, log ${run.logPath})` : '';
  if (outcome.graded) {
    say(line(env.chain, s.title, outcome.graded) + kept);
    for (const p of outcome.graded.problems) console.error(`  FAILED: ${p}`);
  } else {
    say(`FAILED: ${where(env.chain, s.title)}: did not finish: ${outcome.error}${kept}`);
  }
  if (cleanup) console.error(`  FAILED: ${cleanup}`);
  outcomes.push(outcome);
  if (!outcome.graded || outcome.graded.problems.length > 0 || cleanup) {
    failures++;
    console.error(`  worker log: ${run.logPath}`);
  } else if (!args.keep) {
    rmSync(run.logPath);
  }
}

// Totals only over every scenario that applies: a summary that left an unfinished one out would
// read cleaner than the run was.
async function report() {
  const applies = outcomes.filter((o) => !o.notApplicable);
  const graded = applies.flatMap((o) => (o.graded ? [o.graded] : []));
  const totals: Totals | null = graded.length === applies.length ? totalsOf(graded) : null;
  const took = seconds(started);
  const summary = totals
    ? `${totals.withdrawals} withdrawals, ${totals.kills} kills, ${totals.settled} settled, ` +
      `${totals.rejected} rejected, sent twice ${totals.sentTwice}, lost ${totals.lost}, ` +
      `unfinished ${totals.unfinished}, drift ${totals.drift}`
    : `${applies.length - graded.length} did not finish, so there are no totals`;
  const runs = `${selected.length} scenarios on ${chains.join(' and ')}`;
  const skipped = outcomes.length - applies.length;
  const na = skipped > 0 ? `, ${skipped} not applicable` : '';
  if (failures === 0) say(`all ${runs} passed${na}: ${summary} (${took} s)`);
  else say(`FAILED: ${failures} of ${applies.length} runs of ${runs}${na}: ${summary} (${took} s)`);

  if (args.json) {
    const doc = {
      passed: failures === 0,
      seconds: took,
      chains: made.map((e) => ({ chain: e.chain, node: e.nodeVersion })),
      scenarios: outcomes.map(({ chain, name, title, graded: g, error, notApplicable }) =>
        notApplicable
          ? { chain, name, title, notApplicable }
          : g
            ? {
                chain,
                name,
                title,
                finished: true,
                ...g.verdict,
                kills: g.kills,
                killsMidHandler: g.killsMidHandler,
                drift: g.drift,
                note: g.note,
                problems: g.problems,
              }
            : { chain, name, title, finished: false, error },
      ),
      totals,
    };
    const json = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);
    console.log(JSON.stringify(doc, json, 2));
  } else {
    console.log('\n' + table(outcomes, totals));
  }

  if (failures > 0) {
    if (!args['no-write']) console.error(`${RESULTS_PATH} not written: the run failed`);
    process.exitCode = 1;
    return;
  }
  if (args['no-write'] || !totals) return;
  if (partial || !checkout) {
    console.error(`${RESULTS_PATH} not written: only the full matrix at default counts writes it`);
    return;
  }
  // The workers load the code at each start, so a checkout changed during the run (another
  // process editing or committing) means the file could not say which code it describes.
  const now = checkoutOf(root);
  if (now.fingerprint !== checkout.fingerprint) {
    const how =
      now.commit === checkout.commit
        ? `files changed, still ${now.commit}`
        : `${checkout.commit} at the start, ${now.commit} now`;
    console.error(`${RESULTS_PATH} not written: the checkout changed during the run (${how})`);
    process.exitCode = 1;
    return;
  }
  const db = connect(config.databaseUrl);
  let postgres = 'unknown';
  try {
    const [row] = await db<{ server_version: string }[]>`show server_version`;
    postgres = row?.server_version ?? postgres;
  } finally {
    await db.end();
  }
  const script = relative(root, fileURLToPath(import.meta.url));
  const info = {
    commit: checkout.commit,
    date,
    chains: nodes,
    postgres,
    node: process.version,
    command: ['npx tsx', script, ...process.argv.slice(2)].join(' '),
    seconds: seconds(started),
  };
  writeFileSync(join(root, RESULTS_PATH), resultsMarkdown(info, outcomes, totals));
  say(`wrote ${RESULTS_PATH}`);
}

await runAll();
if (interrupt.signal.aborted) {
  console.error('interrupted');
  process.exitCode = 130; // not process.exit: on macOS that can drop output still queued for a pipe
} else {
  await report();
}
