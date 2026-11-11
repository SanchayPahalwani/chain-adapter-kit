import { createPublicClient, http, type Address } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { makeEvmEnv } from './helpers/evm-env.js';
import {
  openPipeline,
  runPipelineSuite,
  twelveConcurrent,
  type PipelineEnv,
} from './pipeline-suite.js';

runPipelineSuite(makeEvmEnv);

describe('withdrawal pipeline on EVM', () => {
  let env: PipelineEnv;
  beforeAll(async () => {
    env = await makeEvmEnv();
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
});
