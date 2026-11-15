import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chainAssets } from '../src/chains.js';
import { config, configFrom, defaults } from '../src/config.js';
import { connect } from '../src/pipeline/db.js';
import { buildRuntime, readRuntimeEnv } from '../src/pipeline/runtime.js';
import { makeBitcoinEnv } from '../scripts/lib/bitcoin-env.js';
import type { PipelineEnv } from '../scripts/lib/env.js';
import { makeEvmEnv } from '../scripts/lib/evm-env.js';
import { openSandbox, type Sandbox } from '../scripts/lib/sandbox.js';

const KIT_SEED = randomBytes(32).toString('hex');

describe('worker runtime from an environment', () => {
  it.each([
    [{}, /KIT_SEED must be 64 hex characters/],
    [{ KIT_SEED: 'zz' }, /KIT_SEED must be 64 hex characters/],
    [{ KIT_SEED, DATABASE_URL: 'mysql://kit@127.0.0.1/kit' }, /DATABASE_URL must be a postgres/],
    [{ KIT_SEED, DATABASE_URL: 'not a url' }, /DATABASE_URL must be a postgres/],
    [{ KIT_SEED, KIT_DB_SCHEMA: 'Bad-Name' }, /KIT_DB_SCHEMA: bad schema name Bad-Name/],
    [{ KIT_SEED, KIT_CHAINS: 'evm-anvil,solana' }, /KIT_CHAINS: unknown chain solana/],
    [{ KIT_SEED, KIT_CHAINS: ',' }, /KIT_CHAINS names no chain/],
    [{ KIT_SEED, KIT_CRASH_AT: 'bogus' }, /KIT_CRASH_AT: unknown crash point bogus/],
    [{ KIT_SEED, KIT_LEASE_MS: '1.5' }, /KIT_LEASE_MS must be a positive integer, got 1.5/],
    [{ KIT_SEED, KIT_MAX_ATTEMPTS: '0' }, /KIT_MAX_ATTEMPTS must be a positive integer, got 0/],
    [{ KIT_SEED, KIT_RETRY_BASE_MS: '-1' }, /KIT_RETRY_BASE_MS must be a positive integer, got -1/],
  ])('readRuntimeEnv(%j) throws %s', (env, message) => {
    expect(() => readRuntimeEnv(env)).toThrow(message);
  });

  it('does not echo a malformed DATABASE_URL, which may hold a password', () => {
    let message = '';
    try {
      readRuntimeEnv({ KIT_SEED, DATABASE_URL: 'mysql://kit:secret@127.0.0.1/kit' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/DATABASE_URL/);
    expect(message).not.toContain('secret');
  });

  it('reads KIT_RETRY_BASE_MS as it reads the other timings', () => {
    expect(
      readRuntimeEnv({ KIT_SEED, KIT_RETRY_BASE_MS: '250', KIT_LEASE_MS: '100' }),
    ).toMatchObject({ timings: { retryBaseMs: 250, leaseMs: 100 } });
  });

  it('reads an empty variable as unset, everywhere', () => {
    const blank = (names: string[]) => Object.fromEntries(names.map((name) => [name, '']));
    const runtime = ['DATABASE_URL', 'KIT_DB_SCHEMA', 'KIT_CHAINS', 'KIT_CRASH_AT', 'KIT_LEASE_MS'];
    const read = (env: Record<string, string>) => ({ ...readRuntimeEnv(env), chainEnv: {} });
    expect(read({ KIT_SEED, ...blank([...runtime, 'KIT_RETRY_BASE_MS']) })).toEqual(
      read({ KIT_SEED }),
    );
    expect(() => readRuntimeEnv({ KIT_SEED: '' })).toThrow(/KIT_SEED must be 64 hex/);
    const services = ['DATABASE_URL', 'EVM_RPC_URL', 'BITCOIN_RPC_URL'];
    expect(configFrom({})).toEqual(defaults);
    expect(configFrom(blank([...services, 'BITCOIN_RPC_USER', 'BITCOIN_RPC_PASSWORD']))).toEqual(
      defaults,
    );
    expect(chainAssets('evm-anvil', { KIT_EVM_TOKENS: '' })).toEqual(['native']);
  });

  it('serves token ids checksummed, whatever the case of KIT_EVM_TOKENS', () => {
    const token = '0x52908400098527886E0F7030069857D2E4169EE7';
    expect(chainAssets('evm-anvil', { KIT_EVM_TOKENS: token.toLowerCase() })).toEqual([
      'native',
      token,
    ]);
    expect(() => chainAssets('evm-anvil', { KIT_EVM_TOKENS: 'nope' })).toThrow(
      'KIT_EVM_TOKENS: nope is not an address',
    );
  });

  it('takes its defaults from the code, not from process.env', () => {
    expect(readRuntimeEnv({ KIT_SEED })).toMatchObject({
      databaseUrl: defaults.databaseUrl,
      chains: ['evm-anvil'],
      timings: {},
    });
  });

  describe('buildRuntime', () => {
    let env: PipelineEnv;
    let box: Sandbox;
    beforeAll(async () => {
      env = await makeEvmEnv();
      box = await openSandbox(env);
    });
    afterAll(async () => {
      await box.close();
    });

    it.each([
      [{ KIT_EVM_TOKENS: 'nope' }, /KIT_EVM_TOKENS: nope is not an address/],
      [{ KIT_EVM_FINALITY_DEPTH: 'x' }, /KIT_EVM_FINALITY_DEPTH: bad depth x/],
      [{ EVM_RPC_URL: 'ftp://127.0.0.1' }, /EVM_RPC_URL: not an http URL: ftp:\/\/127.0.0.1/],
    ])('a bad chain variable %j throws %s', async (bad, message) => {
      await expect(buildRuntime(readRuntimeEnv({ ...box.workerEnv(), ...bad }))).rejects.toThrow(
        message,
      );
    });

    // Only the sandbox's worker environment, nothing from process.env: the worker's adapter must
    // agree with the one the parent grades with.
    it('builds the same hot wallet, node, tokens and finality depth as the sandbox', async () => {
      // the parent's node, even where that is not the default one
      expect(box.workerEnv().EVM_RPC_URL).toBe(config.evmRpcUrl);
      const deps = await buildRuntime(readRuntimeEnv(box.workerEnv()));
      try {
        const rt = deps.chains[env.chain];
        if (!rt) throw new Error(`no runtime for ${env.chain}`);
        expect(rt.hotAddress).toBe(box.hot.hotAddress);
        expect(rt.adapter.finalityDepth).toBe(env.adapter.finalityDepth);
        const token = env.assets[1];
        if (!token) throw new Error('the env has no token');
        expect(await rt.adapter.getBalance(box.hot.hotAddress, token)).toBe(0n);
      } finally {
        await deps.db.end();
      }
    });
  });

  describe('buildRuntime on Bitcoin', () => {
    let env: PipelineEnv;
    let box: Sandbox;
    beforeAll(async () => {
      env = await makeBitcoinEnv();
      box = await openSandbox(env, { fundOnChain: false }); // no coins needed here
    });
    afterAll(async () => {
      await box.close();
    });

    it.each([
      [
        { BITCOIN_RPC_URL: 'ftp://127.0.0.1' },
        /BITCOIN_RPC_URL: not an http URL: ftp:\/\/127.0.0.1/,
      ],
      [{ KIT_BITCOIN_FINALITY_DEPTH: '0' }, /KIT_BITCOIN_FINALITY_DEPTH: bad depth 0/],
      // the node refuses the credentials: they are read from the env given, not from config
      [{ BITCOIN_RPC_USER: 'nobody' }, /bitcoind getblockchaininfo: HTTP 401/],
      [{ BITCOIN_RPC_PASSWORD: 'wrong' }, /bitcoind getblockchaininfo: HTTP 401/],
    ])('a bad chain variable %j throws %s', async (bad, message) => {
      await expect(buildRuntime(readRuntimeEnv({ ...box.workerEnv(), ...bad }))).rejects.toThrow(
        message,
      );
    });

    it('builds the same hot wallet, node and finality depth as the sandbox', async () => {
      expect(box.workerEnv()).toMatchObject({
        KIT_CHAINS: 'bitcoin-regtest',
        BITCOIN_RPC_URL: config.bitcoinRpcUrl,
        BITCOIN_RPC_USER: config.bitcoinRpcAuth.user,
        BITCOIN_RPC_PASSWORD: config.bitcoinRpcAuth.password,
      });
      const deps = await buildRuntime(readRuntimeEnv(box.workerEnv()));
      try {
        const rt = deps.chains[env.chain];
        if (!rt) throw new Error(`no runtime for ${env.chain}`);
        expect(rt.hotAddress).toBe(box.hot.hotAddress);
        // 2 here, where the adapter's own default is 3: KIT_BITCOIN_FINALITY_DEPTH was read
        expect(rt.adapter.finalityDepth).toBe(env.adapter.finalityDepth);
        expect(await rt.adapter.getTip()).toEqual(await env.adapter.getTip());
      } finally {
        await deps.db.end();
      }
    });
  });
});

describe('migrate script', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const admin = connect(config.databaseUrl);
  const schema = `t_${randomBytes(6).toString('hex')}`;
  afterAll(async () => {
    try {
      await admin`drop schema if exists ${admin(schema)} cascade`;
    } finally {
      await admin.end();
    }
  });

  async function migrateScript(env: Record<string, string>) {
    const child = spawn('npx', ['tsx', 'scripts/migrate.ts'], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    const [code] = (await once(child, 'exit')) as [number | null];
    return { code, out };
  }
  const exists = async (name: string) => {
    const [row] = await admin<
      { found: boolean }[]
    >`select to_regclass(${name}) is not null as found`;
    return row?.found;
  };

  it('migrates the schema KIT_DB_SCHEMA names, and refuses one that does not exist', async () => {
    expect(await migrateScript({ KIT_DB_SCHEMA: schema })).toEqual({
      code: 1,
      out: `schema ${schema} does not exist\n`,
    });
    expect(await exists(`${schema}.withdrawals`)).toBe(false);

    await admin`create schema ${admin(schema)}`;
    expect(await migrateScript({ KIT_DB_SCHEMA: schema })).toEqual({
      code: 0,
      out: `migrations applied to schema ${schema}\n`,
    });
    expect(await exists(`${schema}.withdrawals`)).toBe(true);
    expect(await migrateScript({ KIT_DB_SCHEMA: 'Bad-Name' })).toMatchObject({ code: 2 });
  });
});
