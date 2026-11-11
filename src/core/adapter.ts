export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type AssetId = string; // 'native', or an adapter-defined token id
export type Curve = 'secp256k1' | 'ed25519';

export interface BlockRef {
  height: number;
  hash: string;
}

export interface TransferIntent {
  from: string; // the hot wallet address
  to: string;
  asset: AssetId;
  amount: bigint; // smallest unit
}

export interface UnsignedTx {
  body: Json; // adapter-specific; the pipeline stores it and never looks inside
  signingPayloads: string[]; // hex; what the signer signs, in order
}

export interface SignedTx {
  txid: string; // computed locally
  raw: string;
}

export type BroadcastResult =
  | { outcome: 'accepted' }
  | { outcome: 'already_known' } // in the mempool or already in a block
  | { outcome: 'rejected'; reason: string };

export type TxStatus =
  | { state: 'unknown' } // the node has no record of it
  | { state: 'pending' } // in the mempool
  | {
      state: 'confirmed';
      block: BlockRef;
      confirmations: number;
      succeeded: boolean;
      feePaid: bigint;
    };

export interface IncomingTransfer {
  txid: string;
  index: number;
  to: string;
  asset: AssetId;
  amount: bigint;
}
export interface ScannedBlock {
  block: BlockRef;
  parentHash: string;
  transfers: IncomingTransfer[];
}

export interface Coin {
  id: string;
  owner: string;
  amount: bigint;
  data: Json;
}

/** Two storage primitives the pipeline provides. An adapter uses the one its chain needs. */
export interface InputStore {
  seedSequence(key: string, value: bigint): Promise<void>; // insert if absent
  nextSequence(key: string): Promise<bigint>; // return the value, then advance it
  putCoins(coins: Coin[]): Promise<void>; // insert if absent
  freeCoins(owner: string): Promise<Coin[]>; // not reserved; locked for this transaction
  reserveCoins(ids: string[]): Promise<void>;
}

/**
 * Opaque values (`fee`, `reservation`, `UnsignedTx.body`) are JSON-safe: bigints are
 * decimal strings. The pipeline stores them as `jsonb` and hands them back unchanged.
 */
export interface ChainAdapter {
  readonly chain: string; // 'evm-anvil', 'bitcoin-regtest'
  readonly curve: Curve;
  readonly finalityDepth: number; // confirmations before the pipeline settles

  // addresses
  deriveAddress(publicKey: Uint8Array): string;
  validateAddress(address: string): boolean;

  // reads
  getBalance(address: string, asset: AssetId): Promise<bigint>;
  getTip(): Promise<BlockRef>;
  quoteFee(intent: TransferIntent): Promise<Json>;

  // inputs: the nonce, the UTXOs, or nothing
  syncInputs(store: InputStore, address: string): Promise<void>; // may read the chain
  /**
   * A reservation belongs to one transfer. Runs inside the caller's database
   * transaction. Two reservations never share a nonce or a coin. No network I/O.
   */
  reserveInputs(store: InputStore, intent: TransferIntent, fee: Json): Promise<Json>;

  // construction
  buildTransfer(intent: TransferIntent, reservation: Json, fee: Json): Promise<UnsignedTx>;
  /**
   * Pure. Returns the transaction id, which must equal the id the chain later reports.
   * That is what lets the pipeline store the id before sending.
   */
  attachSignatures(unsigned: UnsignedTx, signatures: Uint8Array[]): SignedTx;
  /**
   * Returns a transaction that cannot confirm together with the one it replaces: same
   * nonce on EVM, same inputs on Bitcoin. On a chain where a signed transaction expires
   * instead, returns `null` until the previous one can no longer be included, and only
   * then a fresh one. The pipeline only relies on "at most one attempt of a withdrawal
   * can ever confirm".
   */
  buildReplacement(
    intent: TransferIntent,
    reservation: Json,
    previous: { unsigned: UnsignedTx; fee: Json },
  ): Promise<{ unsigned: UnsignedTx; fee: Json } | null>;

  // broadcast and tracking
  /**
   * Safe to repeat with the same bytes: sending them again never causes a second
   * transfer. If the node already has the transaction, in the mempool or in a block,
   * the result is `already_known`, not an error.
   */
  broadcast(tx: SignedTx): Promise<BroadcastResult>;
  /**
   * About the current canonical chain. A transaction that was confirmed and then
   * reorganised out reports `pending` or `unknown`, never a stale `confirmed`.
   * That is how a drop or a reorg is detected: the caller remembers what it saw before.
   */
  getTxStatus(txid: string): Promise<TxStatus>;

  // deposits
  /** Returns the parent hash, so the scanner can see a reorg as a broken link between consecutive heights. */
  scanBlock(height: number): Promise<ScannedBlock>;
}
