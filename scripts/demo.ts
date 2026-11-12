// A tour of the pipeline on the local devnet in a few seconds: a small withdrawal, one that needs
// two approvals, a worker process killed between the broadcast and the record of it, a replayed
// request, and the reconciliation. All of it in a fresh schema, dropped at the end unless --keep.
// Each claim it prints about the crash, the replay and the balances is checked first: if one does
// not hold, the demo says which and exits 1.
//
//   npx tsx scripts/demo.ts [--keep]
import { closeSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { must } from '../src/config.js';
import { startMiner } from '../src/conformance/harness.js';
import { noCrash } from '../src/pipeline/crash.js';
import type { AssetPolicy } from '../src/pipeline/policy.js';
import { formatReport, reconcile } from '../src/pipeline/reconcile.js';
import {
  decideApproval,
  getWithdrawal,
  IdempotencyKeyReuse,
  submitWithdrawal,
  type RequestDeps,
  type Withdrawal,
  type WithdrawalRequest,
} from '../src/pipeline/requests.js';
import { defaultTimings } from '../src/pipeline/runtime.js';
import { runOnce, type WorkerDeps } from '../src/pipeline/worker.js';
import { makeEvmEnv } from './lib/evm-env.js';
import { gasFloat, openSandbox } from './lib/sandbox.js';
import { spawnWorker, superviseUntilDone, type WorkerOptions } from './lib/supervisor.js';
import { byDeadline, seconds } from './lib/waits.js';

const { values: args } = parseArgs({ options: { keep: { type: 'boolean', default: false } } });
const started = Date.now();
const env = await makeEvmEnv();
const box = await openSandbox(env, { userId: 'alice' });
const logPath = join(tmpdir(), `demo-${box.schema}.log`);
const run = { box, logFd: openSync(logPath, 'w') };

const { adapter } = env;
const unit = env.unit('native');
const units = (x: bigint) =>
  x % unit !== 0n ? `${x} base units` : x === unit ? '1 unit' : `${x / unit} units`;
const short = (s: string) => (s.length > 14 ? `${s.slice(0, 8)}...${s.slice(-4)}` : s);
const shortTxid = (key: string, v: unknown) =>
  key === 'txid' && typeof v === 'string' ? short(v) : v;
const policy: AssetPolicy = {
  perWithdrawalMax: 8n * unit,
  rolling24hMax: 20n * unit,
  approvalThreshold: 5n * unit,
  approvalsRequired: 2,
  approvers: ['ops-1', 'ops-2'],
};
const requests: RequestDeps = { ...box.requestDeps, policy: () => policy };
// the demo's own worker, in this process, for steps 2 and 3
const inProcess: WorkerDeps = {
  db: box.db,
  signer: box.signer,
  chains: box.chains,
  timings: { ...defaultTimings, leaseMs: 1000, pollMs: 20 },
  crash: noCrash,
};
const childTimings: WorkerOptions['timings'] = {
  leaseMs: 1000,
  pollMs: 50,
  stuckAfterMs: 20_000,
  maxAttempts: 5,
};

const latestTxid = async (id: string) => {
  const [row] = await box.db<{ txid: string }[]>`
    select txid from tx_attempts where withdrawal_id = ${id} order by attempt_no desc limit 1`;
  return row?.txid;
};

async function detail(w: Withdrawal): Promise<string> {
  const txid = await latestTxid(w.id);
  if (w.state === 'RESERVED') return `inputs reserved: ${JSON.stringify(w.reservation)}`;
  if (w.state === 'SIGNED') return `signed attempt stored before any send: ${short(txid ?? '')}`;
  if (w.state === 'SETTLED') return `final; the ledger posts the transfer and its fee`;
  if (w.state !== 'BROADCAST' || !txid) return '';
  const s = await adapter.getTxStatus(txid);
  if (s.state !== 'confirmed') return `sent; the node has it (${s.state})`;
  return `in block ${s.block.height}: ${s.confirmations} of ${adapter.finalityDepth} confirmations`;
}

// Runs the in-process worker, one handler at a time, and mines a block after each.
async function drive(id: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const w = await getWithdrawal(box.db, id);
    if (w.state === 'SETTLED' || w.state === 'FAILED') return;
    if (Date.now() > deadline) throw new Error(`withdrawal ${id} is still ${w.state}`);
    if (!(await runOnce(inProcess, 'demo'))) {
      await sleep(inProcess.timings.pollMs);
      continue;
    }
    const now = await getWithdrawal(box.db, id);
    console.log(`   ${now.state.padEnd(10)} ${await detail(now)}`);
    await env.devnet.mine(1);
  }
}

let keys = 0;
const request = (amount: bigint, to: string): WithdrawalRequest => ({
  idempotencyKey: `demo-${++keys}`,
  userId: box.userId,
  chain: env.chain,
  asset: 'native',
  to,
  amount,
});

let failed = false;
try {
  console.log(`chain-adapter-kit demo on ${env.chain} (${env.nodeVersion})\n`);
  console.log('1. Setup');
  console.log(`   fresh database schema ${box.schema}, random seed`);
  console.log(
    `   hot wallet ${box.hot.hotAddress}, holding ${units(gasFloat(env))} of native for fees`,
  );
  await box.credit('native', 10n * unit);
  const dests: [string, string, string] = [
    await box.allowFresh(),
    await box.allowFresh(),
    await box.allowFresh(),
  ];
  console.log(`   alice is credited ${units(10n * unit)} (1 unit = ${unit} base units of native)`);
  console.log(`   three destinations on alice's allowlist: ${dests.map(short).join(', ')}`);
  console.log(
    `   policy: ${units(policy.approvalThreshold)} or more needs 2 approvals (ops-1, ops-2)\n`,
  );

  console.log(`2. A small withdrawal: ${units(unit)} to ${short(dests[0])}`);
  const firstRequest = request(unit, dests[0]);
  const small = await submitWithdrawal(box.db, requests, firstRequest);
  console.log(`   ${small.state.padEnd(10)} accepted by policy, amount held from alice's balance`);
  await drive(small.id);

  console.log(`\n3. A withdrawal over the approval threshold: ${units(6n * unit)}`);
  const big = await submitWithdrawal(box.db, requests, request(6n * unit, dests[1]));
  console.log(`   ${big.state}`);
  for (const approverId of ['ops-1', 'ops-2']) {
    const w = await decideApproval(box.db, requests, {
      withdrawalId: big.id,
      approverId,
      decision: 'approve',
    });
    console.log(`   ${approverId} approves: ${w.state}`);
  }
  await drive(big.id);

  console.log(`\n4. A worker process killed between the broadcast and the record of it`);
  const third = await submitWithdrawal(box.db, requests, request(2n * unit, dests[2]));
  console.log(`   ${units(third.amount)} to ${short(third.to)}: ${third.state}`);
  const child = spawnWorker(run, { crashAt: 'after_broadcast', timings: childTimings });
  console.log(`   worker process ${child.pid} started with KIT_CRASH_AT=after_broadcast`);
  const exit = new Promise<string | null>((resolve) =>
    child.once('exit', (_, sig) => resolve(sig)),
  );
  const signal = await byDeadline(Date.now() + 30_000, Date.now(), exit);
  if (signal !== 'SIGKILL') throw new Error(`the worker ended by ${signal}, not SIGKILL`);
  const killed = await getWithdrawal(box.db, third.id);
  must(killed.state === 'SIGNED', `after the kill the withdrawal is ${killed.state}, not SIGNED`);
  const txid = (await latestTxid(third.id)) ?? '';
  const status = await adapter.getTxStatus(txid);
  must(status.state !== 'unknown', `the node does not know the transaction ${txid}`);
  console.log(`   the worker was killed (SIGKILL) right after the node accepted the transaction`);
  console.log(`   the row says ${killed.state}: nothing recorded the broadcast`);
  console.log(`   the chain already has ${short(txid)} (${status.state})`);
  console.log(`   a clean worker process starts; blocks resume`);
  const stopMiner = startMiner(env.devnet, 100);
  try {
    const { timedOut } = await superviseUntilDone(run, { timings: childTimings }, 30_000);
    if (timedOut) throw new Error('the clean worker did not finish in 30 s');
  } finally {
    await stopMiner();
  }
  const done = await getWithdrawal(box.db, third.id);
  must(done.state === 'SETTLED', `the crashed withdrawal ended ${done.state}, not SETTLED`);
  const events = await box.db<{ kind: string; data: Record<string, unknown> }[]>`
    select kind, data from withdrawal_events where withdrawal_id = ${third.id} order by id`;
  const broadcasts = events.filter((e) => e.kind === 'broadcast');
  must(
    broadcasts.length === 1 && broadcasts[0]?.data.sent === false,
    `the restarted worker sent the transaction again: ${JSON.stringify(broadcasts.map((b) => b.data))}`,
  );
  console.log(`   ${done.state}; its events:`);
  for (const e of events) {
    if (e.kind === 'state') console.log(`     ${String(e.data.from)} -> ${String(e.data.to)}`);
    else console.log(`     ${e.kind.padEnd(15)} ${JSON.stringify(e.data, shortTxid)}`);
  }
  console.log(
    `   the clean worker asked the node first, found the transaction, and did not send it`,
  );

  console.log(`\n5. The first request again, with the same idempotency key`);
  const replay = await submitWithdrawal(box.db, requests, firstRequest);
  must(replay.id === small.id, `the replay returned ${replay.id}, not ${small.id}`);
  console.log(`   returned ${replay.id}: the same withdrawal, ${replay.state}; nothing new`);
  const reuse = await submitWithdrawal(box.db, requests, { ...firstRequest, amount: 2n * unit })
    .then(() => null)
    .catch((e: unknown) => e);
  must(reuse instanceof IdempotencyKeyReuse, `the key reused for another amount was not refused`);
  console.log(`   the same key for another amount is refused: ${reuse.message}`);

  console.log(`\n6. Reconciliation: the ledger against the chain`);
  const report = await reconcile(box.db, box.chains, { [env.chain]: env.assets });
  console.log(
    formatReport(report)
      .trimEnd()
      .split('\n')
      .map((l) => (l ? `   ${l}` : l))
      .join('\n'),
  );
  must(report.ok, 'the reconciliation failed');
  console.log(`\n   destination balances on the chain:`);
  for (const w of [small, big, third]) {
    const held = await adapter.getBalance(w.to, 'native');
    must(held === w.amount, `${w.to} holds ${held}, not the ${w.amount} asked`);
    console.log(`     ${w.to}  ${units(held)} (asked ${units(w.amount)})`);
  }
} catch (error) {
  failed = true;
  console.error(`\ndemo failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`worker log: ${logPath}`);
} finally {
  closeSync(run.logFd);
  await box.close({ keepSchema: args.keep });
}

console.log(`\ndone in ${seconds(started)} s`);
if (args.keep) {
  const quote = (v: string) => (/^[\w./:@-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  const vars = Object.entries(box.workerEnv()).map(([k, v]) => `${k}=${quote(v)}`);
  console.log(`kept schema ${box.schema} and the worker log ${logPath}. With these variables:`);
  console.log(`  export ${vars.join(' ')}`);
  console.log('  npx tsx scripts/reconcile.ts     # the reconciliation again');
  console.log('  npx tsx scripts/worker-main.ts   # a worker on this schema (Ctrl-C stops it)');
} else {
  if (!failed) rmSync(logPath);
  console.log(`schema ${box.schema} dropped (--keep keeps it)`);
}
process.exitCode = failed ? 1 : 0;
