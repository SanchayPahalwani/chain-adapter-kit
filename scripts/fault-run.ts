// Runs the fault-injection scenarios (scripts/lib/scenarios.ts) one after another, each on its own
// sandbox, and grades every withdrawal by what its destination holds on the chain (spec section
// 11). One line per scenario, then the table; docs/results.md is written only when every scenario
// passed. Exit code 1 if any failed, 130 if interrupted.
//
//   npx tsx scripts/fault-run.ts [--quick | --per-scenario <n>] [--only <name>,...] [--keep]
//                                [--json] [--no-write]
//
// --quick: 2 withdrawals per scenario (default 10), and 10 for random_kills (default 100).
// --only: scenario names: a crash point, random_kills, duplicate_requests, dropped_tx, reorg,
// stuck_fee. --keep: keep each scenario's schema and log. --json: the results as one JSON document
// on stdout, and nothing else there. --no-write: leave docs/results.md as it is.
import { closeSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { connect } from '../src/pipeline/db.js';
import { makeEvmEnv } from './lib/evm-env.js';
import {
  commitOf,
  RESULTS_PATH,
  resultsMarkdown,
  table,
  totalsOf,
  type Outcome,
  type Totals,
} from './lib/results.js';
import { scenarios, setup, type Graded } from './lib/scenarios.js';
import { seconds } from './lib/waits.js';

const root = fileURLToPath(new URL('../', import.meta.url));

function usage(message: string): never {
  console.error(message);
  console.error(
    'usage: fault-run.ts [--quick | --per-scenario <n>] [--only <name>,...] [--keep] [--json] ' +
      '[--no-write]',
  );
  process.exit(2);
}

const { values: args } = parseArgs({
  options: {
    quick: { type: 'boolean', default: false },
    'per-scenario': { type: 'string' },
    only: { type: 'string' },
    keep: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'no-write': { type: 'boolean', default: false },
  },
});
if (args.quick && args['per-scenario'] !== undefined) usage('--quick or --per-scenario, not both');
const n = args.quick ? 2 : Number(args['per-scenario'] ?? 10);
if (!Number.isInteger(n) || n < 1) usage(`--per-scenario must be a positive integer`);
const only = args.only?.split(',').map((s) => s.trim());
for (const name of only ?? []) {
  if (!scenarios.some((s) => s.name === name)) usage(`unknown scenario ${name}`);
}
const selected = only ? scenarios.filter((s) => only.includes(s.name)) : scenarios;
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
const commit = commitOf(root);
const date = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const env = await makeEvmEnv();

const line = (title: string, g: Graded) => {
  const v = g.verdict;
  return (
    `${g.problems.length > 0 ? 'FAILED: ' : ''}${title}: ${v.withdrawals} withdrawals, ` +
    `${g.kills} kills, ${v.settled} settled, ${v.rejected} rejected, sent twice ${v.sentTwice}, ` +
    `lost ${v.lost}, unfinished ${v.unfinished}, drift ${g.drift}`
  );
};

const outcomes: Outcome[] = [];
let failures = 0;
async function runAll() {
  for (const s of selected) {
    if (interrupt.signal.aborted) break;
    const count = s.withdrawals ? s.withdrawals[args.quick ? 'quick' : 'full'] : n;
    const run = await setup(env);
    const outcome: Outcome = { name: s.name, title: s.title, about: s.about };
    try {
      outcome.graded = await s.run(run, count, interrupt.signal);
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
      break;
    }
    const kept = args.keep ? ` (kept schema ${run.box.schema}, log ${run.logPath})` : '';
    if (outcome.graded) {
      say(line(s.title, outcome.graded) + kept);
      for (const p of outcome.graded.problems) console.error(`  FAILED: ${p}`);
    } else {
      say(`FAILED: ${s.title}: did not finish: ${outcome.error}${kept}`);
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
}

// Totals only over every scenario: a summary that left an unfinished one out would read cleaner
// than the run was.
async function report() {
  const graded = outcomes.flatMap((o) => (o.graded ? [o.graded] : []));
  const totals: Totals | null = graded.length === outcomes.length ? totalsOf(graded) : null;
  const took = seconds(started);
  const summary = totals
    ? `${totals.withdrawals} withdrawals, ${totals.kills} kills, ${totals.settled} settled, ` +
      `${totals.rejected} rejected, sent twice ${totals.sentTwice}, lost ${totals.lost}, ` +
      `unfinished ${totals.unfinished}, drift ${totals.drift}`
    : `${outcomes.length - graded.length} did not finish, so there are no totals`;
  if (failures === 0) say(`all ${selected.length} scenarios passed: ${summary} (${took} s)`);
  else say(`FAILED: ${failures} of ${selected.length} scenarios: ${summary} (${took} s)`);

  if (args.json) {
    const doc = {
      passed: failures === 0,
      seconds: took,
      scenarios: outcomes.map(({ name, title, graded: g, error }) =>
        g
          ? {
              name,
              title,
              finished: true,
              ...g.verdict,
              kills: g.kills,
              drift: g.drift,
              problems: g.problems,
            }
          : { name, title, finished: false, error },
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
  } else if (!args['no-write'] && totals) {
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
      commit,
      date,
      chain: `${env.chain} (${env.nodeVersion})`,
      postgres,
      node: process.version,
      command: ['npx tsx', script, ...process.argv.slice(2)].join(' '),
      seconds: seconds(started),
    };
    writeFileSync(join(root, RESULTS_PATH), resultsMarkdown(info, outcomes, totals));
    say(`wrote ${RESULTS_PATH}`);
  }
}

await runAll();
if (interrupt.signal.aborted) {
  console.error('interrupted');
  process.exitCode = 130; // not process.exit: on macOS that can drop output still queued for a pipe
} else {
  await report();
}
