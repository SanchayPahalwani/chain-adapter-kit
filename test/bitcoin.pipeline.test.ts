// Needs `docker compose up -d --wait bitcoind postgres`.
import { beforeAll, describe, expect, it } from 'vitest';
import { bitcoinRpc } from '../src/adapters/bitcoin/rpc.js';
import { config } from '../src/config.js';
import { makeBitcoinEnv } from '../scripts/lib/bitcoin-env.js';
import {
  openPipeline,
  runPipelineSuite,
  twelveConcurrent,
  type PipelineEnv,
} from './pipeline-suite.js';

runPipelineSuite(makeBitcoinEnv, { underfundedWaitsIn: ['APPROVED'] });

describe('withdrawal pipeline on Bitcoin', () => {
  let env: PipelineEnv;
  beforeAll(async () => {
    env = await makeBitcoinEnv();
  });
  it('P4 on Bitcoin: twelve distinct reserved coin sets, and each transaction spent exactly its own', async () => {
    const p = await openPipeline(env);
    try {
      const ws = await twelveConcurrent(p, env);
      const sets = ws.map((w) =>
        (w.reservation as { coins: { id: string }[] }).coins.map((c) => c.id),
      );
      const all = sets.flat();
      expect(sets.every((s) => s.length > 0)).toBe(true);
      expect(new Set(all).size).toBe(all.length); // no coin in two reservations
      // what the chain says each settled transaction spent, in order
      const rpc = bitcoinRpc(config.bitcoinRpcUrl, config.bitcoinRpcAuth);
      for (const [i, w] of ws.entries()) {
        const tx = await rpc.call<{ vin: { txid: string; vout: number }[] }>('getrawtransaction', [
          w.settledTxid,
          1,
        ]);
        expect(tx.vin.map((v) => `${v.txid}:${v.vout}`)).toEqual(sets[i]);
      }
      const [row] = await p.db<{ n: number }[]>`
        select count(distinct reserved_by)::int as n from chain_coins where reserved_by is not null`;
      expect(row?.n).toBe(12);
    } finally {
      await p.close();
    }
  });
});
