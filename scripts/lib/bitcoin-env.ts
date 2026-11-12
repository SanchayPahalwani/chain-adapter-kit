import { DEFAULT_FEE_RATE, createBitcoinAdapter } from '../../src/adapters/bitcoin/adapter.js';
import { createBitcoinDevnet } from '../../src/adapters/bitcoin/devnet.js';
import type { Devnet } from '../../src/conformance/harness.js';
import { config } from '../../src/config.js';
import { LocalSigner } from '../../src/core/local-signer.js';
import type { PipelineEnv } from './env.js';

// While stuck, blocks hold only transactions paying at least 1 sat/vB above the adapter's normal
// rate. Not "more than normal": the adapter prices a transfer on an upper bound of its size, so
// by the node's vsize one at the normal rate can pay a little over it. A replacement pays at
// least 1 sat/vB more than the attempt it replaces.
const STUCK_RATE = DEFAULT_FEE_RATE + 1n;

export async function makeBitcoinEnv(): Promise<PipelineEnv> {
  const { bitcoinRpcUrl: rpcUrl, bitcoinRpcAuth: auth } = config;
  const base = await createBitcoinDevnet(rpcUrl, auth);
  // no feeRate: a worker's adapter (src/chains.ts) has the default one too
  const adapter = await createBitcoinAdapter({ rpcUrl, auth, finalityDepth: 2 });

  let stuck = false;
  const devnet: Devnet = {
    fund: (address, asset, amount) => base.fund(address, asset, amount),
    dropFromMempool: (txid) => base.dropFromMempool(txid),
    reorg: (depth) => base.reorg(depth),
    pendingFrom: (address) => base.pendingFrom(address),
    mine: (blocks) => (stuck ? base.mineAtLeast(blocks, STUCK_RATE) : base.mine(blocks)),
  };

  const { subversion } = await base.rpc.call<{ subversion: string }>('getnetworkinfo');
  return {
    chain: adapter.chain,
    adapter,
    devnet,
    nodeVersion: subversion, // such as /Satoshi:32.1.0/
    assets: ['native'],
    unit: () => 100_000n, // sat
    freshAddress: async () =>
      adapter.deriveAddress(await LocalSigner.random().publicKey('destination', adapter.curve)),
    workerEnv: {
      BITCOIN_RPC_URL: rpcUrl,
      BITCOIN_RPC_USER: auth.user,
      BITCOIN_RPC_PASSWORD: auth.password,
      KIT_BITCOIN_FINALITY_DEPTH: String(adapter.finalityDepth),
    },
    // Each withdrawal spends a coin of its own until its transfer confirms (and the change is a
    // coin again). P4 runs twelve at once; random kills keeps up to 40 unfinished. A reservation
    // that finds no free coin fails and is retried.
    fundingPieces: 24,
    stuckEvicts: false, // bitcoind keeps an underpriced transaction in its mempool
    reorgKeepsMempool: true, // bitcoind puts a removed block's transactions back in its mempool
    makeStuck() {
      stuck = true;
      return Promise.resolve();
    },
    clearStuck() {
      stuck = false;
      return Promise.resolve();
    },
  };
}
