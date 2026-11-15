// The results table, and docs/results.md around it. scripts/fault-run.ts writes that file from a
// passing run; nobody edits it by hand.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Graded } from './grading.js';

export const RESULTS_PATH = 'docs/results.md';

/** One scenario's outcome on one chain: graded, why it did not finish, or why it does not apply. */
export interface Outcome {
  chain: string;
  name: string;
  title: string;
  about: string;
  graded?: Graded;
  error?: string;
  notApplicable?: string; // why the chain cannot produce this scenario's fault; not run
}

export interface Totals {
  withdrawals: number;
  kills: number;
  settled: number;
  rejected: number;
  failed: number;
  sentTwice: number;
  lost: number;
  unfinished: number;
  drift: bigint; // the largest of the scenarios' drifts
}

export function totalsOf(graded: Graded[]): Totals {
  const sum = (f: (g: Graded) => number) => graded.reduce((s, g) => s + f(g), 0);
  return {
    withdrawals: sum((g) => g.verdict.withdrawals),
    kills: sum((g) => g.kills),
    settled: sum((g) => g.verdict.settled),
    rejected: sum((g) => g.verdict.rejected),
    failed: sum((g) => g.verdict.failed),
    sentTwice: sum((g) => g.verdict.sentTwice),
    lost: sum((g) => g.verdict.lost),
    unfinished: sum((g) => g.verdict.unfinished),
    drift: graded.reduce((max, g) => (g.drift > max ? g.drift : max), 0n),
  };
}

const header = [
  'Chain',
  'Scenario',
  'Withdrawals',
  'Worker kills',
  'Settled',
  'Rejected',
  'Sent twice',
  'Lost',
  'Unfinished',
  'Ledger drift',
];

const cells = (t: Omit<Totals, 'failed'>) =>
  [t.withdrawals, t.kills, t.settled, t.rejected, t.sentTwice, t.lost, t.unfinished, t.drift].map(
    String,
  );

// 'a', 'a and b', 'a, b and c'
const listed = (names: string[]) =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');

/**
 * A Markdown table, padded so it also reads as plain text. No total row unless `totals`, which
 * covers every row above it, on every chain.
 */
export function table(outcomes: Outcome[], totals: Totals | null): string {
  const none = header.slice(2).map(() => '-');
  const rows = outcomes.map((o) => {
    if (o.notApplicable) return [o.chain, `${o.title} (not applicable)`, ...none];
    if (!o.graded) return [o.chain, `${o.title} (did not finish)`, ...none];
    const failed = o.graded.problems.length > 0 ? ' (FAILED)' : '';
    const { verdict, kills, drift } = o.graded;
    return [o.chain, o.title + failed, ...cells({ ...verdict, kills, drift })];
  });
  if (totals) {
    const chains = listed([...new Set(outcomes.map((o) => o.chain))]);
    rows.push(['**Total**', `every scenario on ${chains}`, ...cells(totals)]);
  }
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]?.length ?? 0)));
  const text = (i: number) => i < 2; // left-aligned; the counts are right-aligned
  const line = (r: string[]) =>
    `| ${r.map((c, i) => (text(i) ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join(' | ')} |`;
  const rule = `|${widths.map((w, i) => (text(i) ? '-'.repeat(w + 2) : '-'.repeat(w + 1) + ':')).join('|')}|`;
  return [line(header), rule, ...rows.map(line)].join('\n') + '\n';
}

// Each scenario once, with what this run says about it on each chain.
function scenarioList(outcomes: Outcome[]): string {
  const names = [...new Set(outcomes.map((o) => o.name))];
  return names
    .map((name) => {
      const runs = outcomes.filter((o) => o.name === name);
      const [{ title, about }] = runs as [Outcome];
      const notes = runs.flatMap((o) =>
        o.graded?.note ? [`on ${o.chain}, ${o.graded.note}`] : [],
      );
      const skipped = runs.flatMap((o) =>
        o.notApplicable ? [` Not applicable on ${o.chain}: ${o.notApplicable}.`] : [],
      );
      const run = notes.length > 0 ? ` This run: ${notes.join('; ')}.` : '';
      return `- **${title}**: ${about}${run}${skipped.join('')}`;
    })
    .join('\n');
}

export interface Checkout {
  commit: string; // `abc1234`, plus ` (dirty)` if anything but the results file differs from HEAD
  fingerprint: string; // changes with HEAD and with any change to the checkout but that file
}

export function checkoutOf(root: string): Checkout {
  // a large uncommitted diff passes the 1 MiB default output limit
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const head = git('rev-parse', '--short', 'HEAD').trim();
  const changed = git('status', '--porcelain')
    .split('\n')
    .filter((l) => l.trim() !== '' && l.slice(3) !== RESULTS_PATH);
  const diff = git('diff', 'HEAD', '--', '.', `:!${RESULTS_PATH}`);
  const fingerprint = createHash('sha256')
    .update([git('rev-parse', 'HEAD'), ...changed, diff].join('\n'))
    .digest('hex');
  return { commit: `\`${head}\`${changed.length > 0 ? ' (dirty)' : ''}`, fingerprint };
}

export interface RunInfo {
  commit: string; // from checkoutOf
  date: string;
  chains: string; // each chain and its node's version
  // the node URLs the environment set instead of the defaults, such as
  // EVM_RPC_URL=http://127.0.0.1:58553 (PipelineEnv.nodeOverride); none for the default nodes
  overrides: string[];
  postgres: string;
  node: string;
  command: string;
  seconds: number;
}

const columns = [
  ['Withdrawals', 'withdrawal rows the scenario made: one per idempotency key.'],
  [
    'Worker kills',
    'worker processes that died by SIGKILL. A `kill at` worker kills itself once per withdrawal at ' +
      'its crash point; in random kills the supervisor sends them, only to workers that have run ' +
      'for a while past start-up.',
  ],
  ['Settled', 'withdrawals that ended `SETTLED`.'],
  ['Rejected', 'requests the policy refused (`REJECTED`); nothing may reach their destinations.'],
  [
    'Sent twice',
    'withdrawals whose destination holds more on-chain than the amount asked, plus `REJECTED` or ' +
      '`FAILED` ones whose destination holds anything. Each withdrawal goes to its own fresh ' +
      'address, so that balance is exactly what the pipeline sent it.',
  ],
  ['Lost', '`SETTLED` withdrawals whose destination holds less than the amount.'],
  [
    'Unfinished',
    'withdrawals not in a terminal state (`SETTLED`, `REJECTED`, `FAILED`) when the scenario ended.',
  ],
  [
    'Ledger drift',
    'the largest absolute `onchain - ledger - explained` over every asset the scenario used: what ' +
      'the hot wallet holds on-chain against what the ledger says it holds, less what is confirmed ' +
      'but not yet final. The total row shows the largest of any scenario on any chain.',
  ],
];

export function resultsMarkdown(info: RunInfo, outcomes: Outcome[], totals: Totals): string {
  return `# Fault-injection results

Generated by \`make faults\` (\`npx tsx scripts/fault-run.ts\`). Do not edit.

- Commit: ${info.commit}
- Date: ${info.date}
- Chains: ${info.chains}
${info.overrides.length > 0 ? `- Nodes set by the environment, not the defaults: ${info.overrides.join(', ')}\n` : ''}- Postgres ${info.postgres}, Node ${info.node}
- Command: \`${info.command}\`
- Wall-clock time: ${info.seconds} s

${table(outcomes, totals)}
## Scenarios

Every scenario runs on each chain, each time on its own database schema, hot wallet and fresh
destination addresses, with worker processes (\`scripts/worker-main.ts\`) doing the work. Each
\`kill at\` scenario runs one worker at a time with that crash point switched on: every withdrawal
kills the worker there once, and the next worker carries on from what was committed.

${scenarioList(outcomes)}

## What the columns mean

The balances are read from the chain, not from the pipeline's records, and only after
finality depth + 1 more blocks, once the node holds no pending transaction from the hot wallet
(on Bitcoin: no mempool transaction spends a hot-wallet coin).

${columns.map(([name, text]) => `- **${name}**: ${text}`).join('\n')}

A scenario passes when sent twice, lost and unfinished are 0; every valid withdrawal settled and
only the refused requests were rejected; drift is 0 and every reconciliation check passes; the node
holds no pending transaction from the hot wallet (as above); and the scenario's own check holds (its fault happened:
for example, random kills caught enough workers holding a withdrawal, and stuck fee settled every
withdrawal on a replacement).
The property: every accepted request ends in exactly one on-chain transfer or a clean rejection,
and the ledger shows no drift.
`;
}
