// Reconciles each chain in KIT_CHAINS (every asset src/chains.ts says it serves) against the ledger
// in DATABASE_URL / KIT_DB_SCHEMA, for the hot wallets KIT_SEED derives, and prints the report.
// Reads only. Exit code 1 if anything drifts or a ledger check fails, 2 for a bad environment.
//
//   KIT_SEED=<64 hex> [KIT_DB_SCHEMA=...] [KIT_CHAINS=...] npx tsx scripts/reconcile.ts
import { chainAssets } from '../src/chains.js';
import { formatReport, reconcile } from '../src/pipeline/reconcile.js';
import { buildRuntime, readRuntimeEnv, type RuntimeEnv } from '../src/pipeline/runtime.js';
import type { WorkerDeps } from '../src/pipeline/worker.js';

let runtimeEnv: RuntimeEnv;
let deps: WorkerDeps;
try {
  runtimeEnv = readRuntimeEnv(process.env);
  deps = await buildRuntime(runtimeEnv);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
try {
  const { chains, chainEnv } = runtimeEnv;
  const assets = Object.fromEntries(chains.map((c) => [c, chainAssets(c, chainEnv)]));
  const report = await reconcile(deps.db, deps.chains, assets);
  process.stdout.write(formatReport(report));
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await deps.db.end();
}
