import type { AssetId, ChainAdapter } from '../core/adapter.js';
import type { Signer } from '../core/signer.js';

/**
 * Control over a local test chain. Nothing here exists on a real network. Blocks appear
 * only when `mine()` is called, so a broadcast transaction stays pending until then.
 */
export interface Devnet {
  fund(address: string, asset: AssetId, amount: bigint): Promise<void>;
  mine(blocks: number): Promise<void>;
  dropFromMempool(txid: string): Promise<void>;
  reorg(depth: number): Promise<void>;
  /**
   * The number of transactions from `address` the node holds but has not mined, including ones
   * it cannot mine yet. On a UTXO chain, the mempool transactions that spend one of the
   * address's confirmed coins: a spend of an unconfirmed output of the address is not counted.
   */
  pendingFrom(address: string): Promise<number>;
}

/** Everything the conformance suite knows about a chain. */
export interface ConformanceHarness {
  adapter: ChainAdapter;
  signer: Signer;
  devnet: Devnet;
  assets: AssetId[]; // 'native' first
  unit(asset: AssetId): bigint; // a sensible small transfer amount
  invalidAddresses: string[];
  unknownTxid(): string; // a well-formed transaction id the chain has never seen
  replacement: 'conflict' | 'after-expiry';
}

/**
 * Mines one block every `everyMs` until the returned stop() is called. If a mine fails,
 * mining stops and stop() rethrows that error.
 */
export function startMiner(devnet: Devnet, everyMs: number): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let wake = () => {};
  let failure: { error: unknown } | undefined;
  const loop = (async () => {
    while (!stopped) {
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, everyMs);
      });
      if (stopped) return;
      try {
        await devnet.mine(1);
      } catch (error) {
        failure = { error };
        return;
      }
    }
  })();
  return async () => {
    stopped = true;
    clearTimeout(timer); // do not wait out the current sleep
    wake();
    await loop;
    if (failure) throw failure.error;
  };
}
