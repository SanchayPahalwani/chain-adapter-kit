// Every chain the kit can run, by the name its adapter reports. Each factory reads its settings
// from the env it is given, never from process.env, and checks them before it connects. Adding a
// chain adds an entry here; the pipeline names none.
import { isAddress } from 'viem';
import { createEvmAdapter } from './adapters/evm/adapter.js';
import { commaList, defaults, must, urlScheme } from './config.js';
import type { ChainAdapter } from './core/adapter.js';

export type Env = Record<string, string | undefined>;

const factories: Record<string, (env: Env) => Promise<ChainAdapter>> = {
  'evm-anvil': async (env) => {
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
};

export const chainNames = Object.keys(factories);
export const defaultChains = ['evm-anvil'];

export async function buildAdapter(name: string, env: Env): Promise<ChainAdapter> {
  const make = factories[name];
  must(make !== undefined, `unknown chain ${name} (known: ${chainNames.join(', ')})`);
  const adapter = await make(env);
  must(adapter.chain === name, `chain ${name} built an adapter for ${adapter.chain}`);
  return adapter;
}
