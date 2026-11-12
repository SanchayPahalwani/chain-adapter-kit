// Throwaway environments on the local devnets, for the tests and the fault run alike: the setup
// exists once. Fit for a local test chain only.
import { randomBytes, randomUUID } from 'node:crypto';
import { config } from '../../src/config.js';
import type { AssetId } from '../../src/core/adapter.js';
import { LocalSigner } from '../../src/core/local-signer.js';
import { connect, migrate, type Db } from '../../src/pipeline/db.js';
import { acct, ledgerAsset, post } from '../../src/pipeline/ledger.js';
import type { AssetPolicy } from '../../src/pipeline/policy.js';
import {
  allowAddress,
  submitWithdrawal,
  type RequestDeps,
  type Withdrawal,
} from '../../src/pipeline/requests.js';
import { hotWallet, type ChainRuntime } from '../../src/pipeline/worker.js';
import type { PipelineEnv } from './env.js';

export interface TestDb {
  db: Db;
  schema: string;
  /** Ends the connections and drops the schema, unless `keepSchema`. */
  close(opts?: { keepSchema?: boolean }): Promise<void>;
}

// One schema per call, so test files and fault-run scenarios never see each other's rows.
export async function createTestDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = connect(config.databaseUrl);
  const db = connect(config.databaseUrl, schema);
  async function close({ keepSchema = false } = {}): Promise<void> {
    try {
      await db.end({ timeout: 5 }); // a test that timed out may leave a transaction open
      if (!keepSchema) await admin`drop schema if exists ${admin(schema)} cascade`;
    } finally {
      await admin.end();
    }
  }
  try {
    await admin`create schema ${admin(schema)}`;
    await migrate(db);
  } catch (e) {
    await close().catch(() => undefined);
    throw e;
  }
  return { db, schema, close };
}

// native the hot wallet holds for fees, booked as the platform's own
export const gasFloat = (env: PipelineEnv) => 100n * env.unit('native');

const unlimited = 10n ** 40n;
export const sandboxPolicy: AssetPolicy = {
  perWithdrawalMax: unlimited,
  rolling24hMax: unlimited,
  approvalThreshold: unlimited, // never asks for approval
  approvalsRequired: 1,
  approvers: ['ops'],
};

/** A fresh schema, a fresh hot wallet funded on-chain and in the ledger, one user. */
export interface Sandbox extends TestDb {
  signer: LocalSigner; // a random seed; signer.seedHex hands the same keys to a worker process
  hot: ChainRuntime;
  chains: Record<string, ChainRuntime>;
  userId: string;
  requestDeps: RequestDeps; // sandboxPolicy, and the adapter's address check
  /** A deposit: the user is owed `amount` and the hot wallet holds it on-chain. */
  credit(asset: AssetId, amount: bigint): Promise<void>;
  /** A fresh address, on the user's allowlist. */
  allowFresh(): Promise<string>;
  /** An APPROVED withdrawal to a fresh allowlisted address. */
  withdraw(asset: AssetId, amount: bigint): Promise<Withdrawal>;
  /** The environment a worker process (scripts/worker-main.ts) needs to work on this sandbox. */
  workerEnv(): Record<string, string>;
}

export interface SandboxOptions {
  // false: the ledger is funded as usual, but nothing (floats or deposits) reaches the hot
  // wallet on-chain, so it cannot pay until the caller funds it with env.devnet.fund
  fundOnChain?: boolean;
  // true: the hot wallet also holds a platform-owned float of every token, booked like the gas
  // float, so a duplicated token transfer lands at its destination instead of reverting
  tokenFloat?: boolean;
}

export async function openSandbox(
  env: PipelineEnv,
  { fundOnChain = true, tokenFloat = false }: SandboxOptions = {},
): Promise<Sandbox> {
  const t = await createTestDb();
  try {
    const signer = LocalSigner.random();
    const hot = await hotWallet(env.adapter, signer);
    const requestDeps: RequestDeps = {
      policy: () => sandboxPolicy,
      validateAddress: (chain, address) =>
        chain === env.chain && env.adapter.validateAddress(address),
    };
    const userId = `user-${randomUUID()}`;
    const floats: [AssetId, bigint][] = [['native', gasFloat(env)]];
    if (tokenFloat) {
      for (const token of env.assets.slice(1)) floats.push([token, 100n * env.unit(token)]);
    }
    for (const [asset, amount] of floats) {
      const a = ledgerAsset(env.chain, asset);
      if (fundOnChain) await env.devnet.fund(hot.hotAddress, asset, amount);
      await t.db.begin((tx) =>
        post(tx, `fund:${hot.hotAddress}:${asset}`, 'fund', a, [
          { account: acct.custody(a), side: 'debit', amount },
          { account: acct.platform(a), side: 'credit', amount },
        ]),
      );
    }
    let deposits = 0;
    const allowFresh = async () => {
      const to = await env.freshAddress();
      await allowAddress(t.db, userId, env.chain, to);
      return to;
    };
    return {
      ...t,
      signer,
      hot,
      chains: { [env.chain]: hot },
      userId,
      requestDeps,
      async credit(asset, amount) {
        const a = ledgerAsset(env.chain, asset);
        await t.db.begin((tx) =>
          post(tx, `deposit:${userId}:${++deposits}`, 'deposit', a, [
            { account: acct.custody(a), side: 'debit', amount },
            { account: acct.user(userId, a), side: 'credit', amount },
          ]),
        );
        if (fundOnChain) await env.devnet.fund(hot.hotAddress, asset, amount);
      },
      allowFresh,
      async withdraw(asset, amount) {
        const to = await allowFresh();
        const w = await submitWithdrawal(t.db, requestDeps, {
          idempotencyKey: randomUUID(),
          userId,
          chain: env.chain,
          asset,
          to,
          amount,
        });
        if (w.state !== 'APPROVED') throw new Error(`withdrawal is ${w.state}, not APPROVED`);
        return w;
      },
      workerEnv: () => ({
        DATABASE_URL: config.databaseUrl,
        KIT_DB_SCHEMA: t.schema,
        KIT_SEED: signer.seedHex,
        KIT_CHAINS: env.chain,
        ...env.workerEnv,
      }),
    };
  } catch (e) {
    await t.close().catch(() => undefined);
    throw e;
  }
}
