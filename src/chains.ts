// Every chain the kit can run, by the name its adapter reports. Each entry builds its adapter from
// the env it is given, never from process.env, checking the settings before it connects, and names
// the assets it serves. Adding a chain adds an entry here; the pipeline names none.
import { getAddress, isAddress } from 'viem';
import { createBitcoinAdapter } from './adapters/bitcoin/adapter.js';
import { createEvmAdapter } from './adapters/evm/adapter.js';
import { commaList, defaults, must, setting, urlScheme, type Env } from './config.js';
import type { AssetId, ChainAdapter } from './core/adapter.js';

export type { Env };

interface Chain {
  build(env: Env): Promise<ChainAdapter>;
  assets(env: Env): AssetId[]; // what the kit serves on this chain, 'native' first
}

function httpUrl(env: Env, name: string, fallback: string): string {
  const url = setting(env, name) ?? fallback;
  must(['http:', 'https:'].includes(urlScheme(url)), `${name}: not an http URL: ${url}`);
  return url;
}

// unset: the adapter's own default
function finalityDepth(env: Env, name: string): number | undefined {
  const depth = setting(env, name);
  must(!depth || /^[1-9][0-9]{0,2}$/.test(depth), `${name}: bad depth ${depth}`);
  return depth ? Number(depth) : undefined;
}

// KIT_EVM_TOKENS, checksummed: a token's AssetId is its checksummed address, whatever the case of
// the variable, so the assets the kit serves match the adapter's and the ledger's.
function evmTokens(env: Env): string[] {
  const tokens = commaList(env.KIT_EVM_TOKENS);
  const bad = tokens.find((t) => !isAddress(t));
  must(bad === undefined, `KIT_EVM_TOKENS: ${bad} is not an address`);
  return tokens.map((t) => getAddress(t));
}

const registry: Record<string, Chain> = {
  'evm-anvil': {
    async build(env) {
      const rpcUrl = httpUrl(env, 'EVM_RPC_URL', defaults.evmRpcUrl);
      const tokens = evmTokens(env);
      return await createEvmAdapter({
        rpcUrl,
        tokens,
        finalityDepth: finalityDepth(env, 'KIT_EVM_FINALITY_DEPTH'),
      });
    },
    assets: (env) => ['native', ...evmTokens(env)],
  },
  'bitcoin-regtest': {
    async build(env) {
      const rpcUrl = httpUrl(env, 'BITCOIN_RPC_URL', defaults.bitcoinRpcUrl);
      const depth = finalityDepth(env, 'KIT_BITCOIN_FINALITY_DEPTH');
      return await createBitcoinAdapter({
        rpcUrl,
        auth: {
          user: setting(env, 'BITCOIN_RPC_USER') ?? defaults.bitcoinRpcAuth.user,
          password: setting(env, 'BITCOIN_RPC_PASSWORD') ?? defaults.bitcoinRpcAuth.password,
        },
        finalityDepth: depth,
      });
    },
    assets: () => ['native'],
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
