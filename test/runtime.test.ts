import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config, defaults } from '../src/config.js';
import { buildRuntime, readRuntimeEnv } from '../src/pipeline/runtime.js';
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
      [{ KIT_EVM_TOKENS: 'nope' }, /KIT_EVM_TOKENS: nope is not a contract address/],
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
});
