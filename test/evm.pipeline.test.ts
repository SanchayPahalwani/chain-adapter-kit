import { createPublicClient, http, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvmDevnet, type EvmDevnet } from '../src/adapters/evm/devnet.js';
import { config } from '../src/config.js';
import { acct, balance, ledgerAsset } from '../src/pipeline/ledger.js';
import { getWithdrawal } from '../src/pipeline/requests.js';
import { runOnce } from '../src/pipeline/worker.js';
import { makeEvmEnv } from './helpers/evm-env.js';
import {
  drive,
  eventsOf,
  openPipeline,
  runPipelineSuite,
  twelveConcurrent,
  type PipelineEnv,
} from './pipeline-suite.js';

runPipelineSuite(makeEvmEnv);

describe('withdrawal pipeline on EVM', () => {
  let env: PipelineEnv;
  let evm: EvmDevnet;
  beforeAll(async () => {
    env = await makeEvmEnv();
    evm = await createEvmDevnet(config.evmRpcUrl);
  });
  afterAll(async () => {
    await env.clearStuck();
  });

  it('P4 on EVM: twelve distinct reserved nonces, and the hot wallet sent exactly 12 transactions', async () => {
    const p = await openPipeline(env);
    try {
      const ws = await twelveConcurrent(p, env);
      const nonces = ws.map((w) => (w.reservation as { nonce: string }).nonce);
      expect(new Set(nonces).size).toBe(12);
      const client = createPublicClient({ transport: http(config.evmRpcUrl), cacheTime: 0 });
      const sent = await client.getTransactionCount({
        address: p.hot.hotAddress as Address,
        blockTag: 'latest',
      });
      expect(sent).toBe(12);
    } finally {
      await p.close();
    }
  });

  it('a token transfer that reverts on-chain ends FAILED with the hold released and the fee booked', async () => {
    const token = env.assets[1];
    if (!token) throw new Error('the env has no token asset');
    const p = await openPipeline(env);
    try {
      const amount = env.unit(token);
      await p.credit(token, amount);
      const w = await p.withdraw(token, amount);
      // The fee quote estimates gas by running the transfer, so the tokens must be there until
      // RESERVED. Burning them then makes the stored transfer revert when it is mined.
      await runOnce(p.deps, 'one');
      expect((await getWithdrawal(p.db, w.id)).state).toBe('RESERVED');
      await evm.burnToken(token, p.hot.hotAddress, amount);
      await drive(p.deps, env, async () => {
        const { state } = await getWithdrawal(p.db, w.id);
        return state === 'SETTLED' || state === 'FAILED';
      });

      const done = await getWithdrawal(p.db, w.id);
      expect(done.state).toBe('FAILED');
      if (!done.settledTxid) throw new Error('no settled txid');
      const status = await env.adapter.getTxStatus(done.settledTxid);
      if (status.state !== 'confirmed') throw new Error(`attempt is ${status.state}`);
      expect(status.succeeded).toBe(false);
      expect(status.feePaid).toBeGreaterThan(0n);
      const t = ledgerAsset(env.chain, token);
      const n = ledgerAsset(env.chain, 'native');
      expect(await balance(p.db, acct.user(p.userId, t))).toBe(amount);
      expect(await balance(p.db, acct.inFlight(t))).toBe(0n);
      expect(await balance(p.db, acct.networkFees(n))).toBe(status.feePaid);
      expect(await env.adapter.getBalance(w.to, token)).toBe(0n);
      expect((await eventsOf(p.db, w.id)).at(-1)).toBe('BROADCAST>FAILED');
    } finally {
      await p.close();
    }
  });
});
