// A worker's dependencies, built from its process environment. Names no chain: those come from
// src/chains.ts by the names in KIT_CHAINS.
import { buildAdapter, chainNames, defaultChains } from '../chains.js';
import { commaList, config } from '../config.js';
import { LocalSigner } from '../core/local-signer.js';
import { crashPoints, isCrashPoint, killOnce, noCrash, type CrashPoint } from './crash.js';
import { connect } from './db.js';
import { hotWallet, type ChainRuntime, type Timings, type WorkerDeps } from './worker.js';

export interface RuntimeEnv {
  databaseUrl: string;
  schema?: string;
  seedHex: string;
  chains: string[];
  crashAt?: CrashPoint;
  timings?: Partial<Timings>;
}

export const defaultTimings: Timings = {
  leaseMs: 30_000,
  pollMs: 1_000,
  stuckAfterMs: 120_000,
  retryBaseMs: 1_000,
  maxAttempts: 5,
};

const timingVars = [
  ['leaseMs', 'KIT_LEASE_MS'],
  ['pollMs', 'KIT_POLL_MS'],
  ['stuckAfterMs', 'KIT_STUCK_AFTER_MS'],
  ['maxAttempts', 'KIT_MAX_ATTEMPTS'],
] as const;

function must(ok: boolean, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

/** Reads DATABASE_URL, KIT_DB_SCHEMA, KIT_SEED, KIT_CHAINS, KIT_CRASH_AT and the timing variables. */
export function readRuntimeEnv(env: NodeJS.ProcessEnv): RuntimeEnv {
  const seedHex = env.KIT_SEED ?? '';
  must(/^[0-9a-f]{64}$/i.test(seedHex), 'KIT_SEED must be 64 hex characters (a 32-byte seed)');
  const schema = env.KIT_DB_SCHEMA || undefined;
  must(!schema || /^[a-z_][a-z0-9_]*$/.test(schema), `KIT_DB_SCHEMA: bad schema name ${schema}`);
  const chains = env.KIT_CHAINS ? commaList(env.KIT_CHAINS) : defaultChains;
  must(chains.length > 0, 'KIT_CHAINS names no chain');
  for (const c of chains) {
    must(
      chainNames.includes(c),
      `KIT_CHAINS: unknown chain ${c} (known: ${chainNames.join(', ')})`,
    );
  }
  const crashAt = env.KIT_CRASH_AT || undefined;
  must(
    crashAt === undefined || isCrashPoint(crashAt),
    `KIT_CRASH_AT: unknown crash point ${crashAt} (known: ${crashPoints.join(', ')})`,
  );
  const timings: Partial<Timings> = {};
  for (const [key, name] of timingVars) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    must(/^[1-9][0-9]{0,8}$/.test(raw), `${name} must be a positive integer, got ${raw}`);
    timings[key] = Number(raw);
  }
  const databaseUrl = env.DATABASE_URL || config.databaseUrl;
  return { databaseUrl, schema, seedHex, chains, crashAt, timings };
}

export async function buildRuntime(e: RuntimeEnv): Promise<WorkerDeps> {
  const db = connect(e.databaseUrl, e.schema);
  try {
    const [table] = await db`select to_regclass('withdrawals') is not null as found`;
    must(table?.found === true, `no withdrawals table in schema ${e.schema ?? 'public'}`);
    const signer = LocalSigner.fromHex(e.seedHex);
    const chains: Record<string, ChainRuntime> = {};
    for (const name of e.chains) chains[name] = await hotWallet(await buildAdapter(name), signer);
    const crash = e.crashAt ? killOnce(db, e.crashAt) : noCrash;
    return { db, signer, chains, timings: { ...defaultTimings, ...e.timings }, crash };
  } catch (error) {
    await db.end();
    throw error;
  }
}
