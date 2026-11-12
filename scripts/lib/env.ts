import type { Devnet } from '../../src/conformance/harness.js';
import type { AssetId, ChainAdapter } from '../../src/core/adapter.js';

/** One chain's local test world, as the pipeline tests and the fault run use it. */
export interface PipelineEnv {
  chain: string;
  adapter: ChainAdapter;
  devnet: Devnet;
  nodeVersion: string; // what the node reports about itself, for docs/results.md
  assets: AssetId[]; // 'native' first
  unit(asset: AssetId): bigint;
  freshAddress(): Promise<string>; // a valid address nobody else uses
  // what a worker process needs in its environment to build this same adapter (src/chains.ts)
  workerEnv: Record<string, string>;
  // how many payments the sandbox funds the hot wallet with, for each float and each deposit:
  // a chain that spends coins needs a free coin for every withdrawal in flight at once
  fundingPieces: number;
  // raise the fee level and keep it raised across blocks: transactions at the normal fee level
  // stop confirming; replacements, which pay more, still do
  makeStuck(): Promise<void>;
  // true: a transaction priced below the raised level leaves the pool (is evicted) rather than
  // waiting in it, so re-sending it is rejected until a replacement gets through
  stuckEvicts: boolean;
  // true: the transactions of a block that a reorg removes go back to the node's mempool, still
  // pending; false: the node forgets them, and each must be sent again
  reorgKeepsMempool: boolean;
  clearStuck(): Promise<void>; // back to the normal fee level
}
