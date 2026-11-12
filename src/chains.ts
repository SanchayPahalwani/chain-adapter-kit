// Every chain the kit can run, by the name its adapter reports. Each entry builds its adapter from
// the env it is given, never from process.env, checking the settings before it connects, and names
// the assets it serves. Adding a chain adds an entry here; the pipeline names none.
import { isAddress } from 'viem';
import { createEvmAdapter } from './adapters/evm/adapter.js';
import { commaList, defaults, must, urlScheme } from './config.js';
import type { AssetId, ChainAdapter } from './core/adapter.js';

export type Env = Record<string, string | undefined>;

interface Chain {
  build(env: Env): Promise<ChainAdapter>;
  assets(env: Env): AssetId[]; // what the kit serves on this chain, 'native' first
}

const registry: Record<string, Chain> = {
  'evm-anvil': {
    async build(env) {
      const rpcUrl = env.EVM_RPC_URL || defaults.evmRpcUrl;
      must(
        ['http:', 'https:'].includes(urlScheme(rpcUrl)),
        `EVM_RPC_URL: not an http URL: ${rpcUrl}`,
      );
      const tokens = commaList(env.KIT_EVM_TOKENS);
      const bad = tokens.find((t) => !isAddress(t));
      must(bad === undefined, `KIT_EVM_TOKENS: ${bad} is not a contract address`);
      const depth = env.KIT_EVM_FINALITY_DEPTH || undefined;
      must(!depth || /^[1-9][0-9]{0,2}$/.test(depth), `KIT_EVM_FINALITY_DEPTH: bad depth ${depth}`);
      return await createEvmAdapter({
        rpcUrl,
        tokens,
        finalityDepth: depth ? Number(depth) : undefined,
      });
    },
    assets: (env) => ['native', ...commaList(env.KIT_EVM_TOKENS)],
  },
};

export const chainNames = Object.keys(registry);
export const defaultChains = ['evm-anvil'];

function entry(name: string): Chain {
  const chain = registry[name];
  must(chain !== undefined, `unknown chain ${name} (known: ${chainNames.join(', ')})`);
  return chain;
}

export async function buildAdapter(name: string, env: Env): Promise<ChainAdapter> {
  const adapter = await entry(name).build(env);
  must(adapter.chain === name, `chain ${name} built an adapter for ${adapter.chain}`);
  return adapter;
}

export const chainAssets = (name: string, env: Env): AssetId[] => entry(name).assets(env);
