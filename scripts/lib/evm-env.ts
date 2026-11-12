import { createPublicClient, http } from 'viem';
import { createEvmAdapter } from '../../src/adapters/evm/adapter.js';
import { createEvmDevnet } from '../../src/adapters/evm/devnet.js';
import type { Devnet } from '../../src/conformance/harness.js';
import { config } from '../../src/config.js';
import { LocalSigner } from '../../src/core/local-signer.js';
import type { PipelineEnv } from './env.js';

const STUCK_BASE_FEE = 100n * 10n ** 9n; // 100 gwei
const NORMAL_BASE_FEE = 10n ** 9n; // 1 gwei

export async function makeEvmEnv(): Promise<PipelineEnv> {
  const base = await createEvmDevnet(config.evmRpcUrl);
  const token = await base.deployTestToken();
  const adapter = await createEvmAdapter({
    rpcUrl: config.evmRpcUrl,
    tokens: [token],
    finalityDepth: 2, // keeps the tests quick
  });

  // While stuck, the base fee is set again before every block: on its own it falls by an
  // eighth per empty block, and stuck transactions would soon confirm.
  let stuck = false;
  const devnet: Devnet = {
    fund: (address, asset, amount) => base.fund(address, asset, amount),
    dropFromMempool: (txid) => base.dropFromMempool(txid),
    reorg: (depth) => base.reorg(depth),
    pendingFrom: (address) => base.pendingFrom(address),
    async mine(blocks) {
      if (!stuck) return base.mine(blocks);
      for (let i = 0; i < blocks; i++) {
        await base.setNextBaseFee(STUCK_BASE_FEE);
        await base.mine(1);
      }
    },
  };

  const node = createPublicClient({ transport: http(config.evmRpcUrl) });
  return {
    chain: adapter.chain,
    adapter,
    devnet,
    nodeVersion: await node.request({ method: 'web3_clientVersion' }),
    assets: ['native', token],
    unit: (asset) => (asset === 'native' ? 10n ** 16n : 1000n),
    freshAddress: async () =>
      adapter.deriveAddress(await LocalSigner.random().publicKey('destination', adapter.curve)),
    workerEnv: {
      EVM_RPC_URL: config.evmRpcUrl,
      KIT_EVM_TOKENS: token,
      KIT_EVM_FINALITY_DEPTH: String(adapter.finalityDepth),
    },
    stuckEvicts: true, // anvil drops a transaction priced below a mined block's base fee
    async makeStuck() {
      stuck = true;
      // Takes effect at the next mined block. Quotes read the latest block's base fee, so they
      // rise only after that block. anvil evicts a pending transaction priced below a mined
      // block's base fee rather than holding it, so earlier quotes leave the pool, not confirm.
      await base.setNextBaseFee(STUCK_BASE_FEE);
    },
    async clearStuck() {
      stuck = false;
      await base.setNextBaseFee(NORMAL_BASE_FEE);
    },
  };
}
