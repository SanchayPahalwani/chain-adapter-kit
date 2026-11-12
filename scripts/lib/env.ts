import type { Devnet } from '../../src/conformance/harness.js';
import type { AssetId, ChainAdapter } from '../../src/core/adapter.js';

/** One chain's local test world, as the pipeline tests and the fault run use it. */
export interface PipelineEnv {
  chain: string;
  adapter: ChainAdapter;
  devnet: Devnet;
  assets: AssetId[]; // 'native' first
  unit(asset: AssetId): bigint;
  freshAddress(): Promise<string>; // a valid address nobody else uses
  // what a worker process needs in its environment to build this same adapter (src/chains.ts)
  workerEnv: Record<string, string>;
  // raise the fee level and keep it raised across blocks:
  // transactions quoted before this no longer confirm, later quotes do
  makeStuck(): Promise<void>;
  // true: a transaction priced below the raised level leaves the pool (is evicted) rather than
  // waiting in it, so re-sending it is rejected until a replacement gets through
  stuckEvicts: boolean;
  clearStuck(): Promise<void>; // back to the normal fee level
}
