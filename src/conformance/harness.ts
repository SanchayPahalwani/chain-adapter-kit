import type { AssetId, ChainAdapter } from '../core/adapter.js';
import type { Signer } from '../core/signer.js';

/** Control over a local test chain. Nothing here exists on a real network. */
export interface Devnet {
  fund(address: string, asset: AssetId, amount: bigint): Promise<void>;
  mine(blocks: number): Promise<void>;
  dropFromMempool(txid: string): Promise<void>;
  reorg(depth: number): Promise<void>;
}

/** Everything the conformance suite knows about a chain. */
export interface ConformanceHarness {
  name: string;
  adapter: ChainAdapter;
  signer: Signer;
  devnet: Devnet;
  assets: AssetId[]; // 'native' first
  unit(asset: AssetId): bigint; // a sensible small transfer amount
  invalidAddresses: string[];
  replacement: 'conflict' | 'after-expiry';
}

/** Mines one block every `everyMs` until the returned stop() resolves. */
export function startMiner(devnet: Devnet, everyMs: number): () => Promise<void> {
  let running = true;
  const loop = (async () => {
    while (running) {
      await new Promise((resolve) => setTimeout(resolve, everyMs));
      if (running) await devnet.mine(1);
    }
  })();
  return async () => {
    running = false;
    await loop;
  };
}
