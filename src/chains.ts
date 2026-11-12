// Every chain the kit can run, by the name its adapter reports. Each factory reads what it needs
// from the process environment. Adding a chain adds an entry here; the pipeline names none.
import { createEvmAdapter } from './adapters/evm/adapter.js';
import { commaList, config } from './config.js';
import type { ChainAdapter } from './core/adapter.js';

const factories: Record<string, () => Promise<ChainAdapter>> = {
  'evm-anvil': () =>
    createEvmAdapter({ rpcUrl: config.evmRpcUrl, tokens: commaList(process.env.KIT_EVM_TOKENS) }),
};

export const chainNames = Object.keys(factories);
export const defaultChains = ['evm-anvil'];

export async function buildAdapter(name: string): Promise<ChainAdapter> {
  const make = factories[name];
  if (!make) throw new Error(`unknown chain ${name} (known: ${chainNames.join(', ')})`);
  const adapter = await make();
  if (adapter.chain !== name) {
    throw new Error(`chain ${name} built an adapter for ${adapter.chain}`);
  }
  return adapter;
}
