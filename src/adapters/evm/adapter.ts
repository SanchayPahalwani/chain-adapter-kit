import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  BaseError,
  RpcRequestError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  bytesToHex,
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  http,
  keccak256,
  serializeTransaction,
  type Address,
  type Hash,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import type {
  AssetId,
  ChainAdapter,
  InputStore,
  Json,
  TransferIntent,
  TxStatus,
  UnsignedTx,
} from '../../core/adapter.js';

export interface EvmAdapterOptions {
  rpcUrl: string;
  finalityDepth?: number; // default 3
  tokens?: string[]; // ERC-20 contract addresses
}

const LOCAL_CHAIN_ID = 31337;
const chain = 'evm-anvil';

// The opaque JSON values this adapter hands the pipeline. Every number is a decimal string.
type Fee = { gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string };
type Reservation = { nonce: string };
type Body = {
  chainId: string;
  nonce: string;
  to: string;
  value: string;
  data: string;
  gas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

function toSerializable(body: Body): TransactionSerializableEIP1559 {
  return {
    type: 'eip1559',
    chainId: Number(body.chainId),
    nonce: Number(body.nonce),
    to: body.to as Address,
    value: BigInt(body.value),
    data: body.data as Hex,
    gas: BigInt(body.gas),
    maxFeePerGas: BigInt(body.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(body.maxPriorityFeePerGas),
  };
}

// The node's own error text. Anything that is not the node answering (an HTTP error, a
// timeout, a closed socket) is rethrown: it says nothing about the transaction.
function nodeAnswer(error: unknown): string {
  const rpc = error instanceof BaseError ? error.walk((e) => e instanceof RpcRequestError) : null;
  if (!(rpc instanceof RpcRequestError)) throw error;
  return rpc.details;
}

// For an unknown hash the node answers null and viem throws a typed error; turn it back into null.
function notFound(error: unknown): null {
  if (error instanceof TransactionNotFoundError) return null;
  if (error instanceof TransactionReceiptNotFoundError) return null;
  throw error;
}

export async function createEvmAdapter(opts: EvmAdapterOptions): Promise<ChainAdapter> {
  // cacheTime 0: viem otherwise caches the block number for 4 s, which would make
  // confirmation counts lag behind blocks that were just mined
  const client = createPublicClient({ transport: http(opts.rpcUrl), cacheTime: 0 });
  const chainId = await client.getChainId();
  if (chainId !== LOCAL_CHAIN_ID) {
    throw new Error(
      `refusing chain id ${chainId}: only a local anvil (${LOCAL_CHAIN_ID}) is allowed`,
    );
  }
  // A token's AssetId is its checksummed contract address.
  const tokens = new Set((opts.tokens ?? []).map((t) => getAddress(t)));

  function token(asset: AssetId): Address {
    const address = asset as Address;
    if (!tokens.has(address)) throw new Error(`unknown asset ${asset}`);
    return address;
  }

  // The call that moves `intent.amount`: a value transfer, or an ERC-20 transfer() call.
  function call(intent: TransferIntent): { to: Address; value: bigint; data: Hex } {
    if (intent.asset === 'native')
      return { to: intent.to as Address, value: intent.amount, data: '0x' };
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [intent.to as Address, intent.amount],
    });
    return { to: token(intent.asset), value: 0n, data };
  }

  // In the mempool or in a block.
  async function nodeHas(txid: string): Promise<boolean> {
    const hash = txid as Hash;
    if (await client.getTransactionReceipt({ hash }).catch(notFound)) return true;
    return (await client.getTransaction({ hash }).catch(notFound)) !== null;
  }

  async function getTxStatus(txid: string): Promise<TxStatus> {
    const hash = txid as Hash;
    const receipt = await client.getTransactionReceipt({ hash }).catch(notFound);
    if (receipt) {
      const tip = await client.getBlockNumber();
      // a tip below the receipt's block means a rollback between the two reads: not confirmed
      if (tip >= receipt.blockNumber) {
        return {
          state: 'confirmed',
          block: { height: Number(receipt.blockNumber), hash: receipt.blockHash },
          confirmations: Number(tip - receipt.blockNumber + 1n),
          succeeded: receipt.status === 'success',
          feePaid: receipt.gasUsed * receipt.effectiveGasPrice,
        };
      }
    }
    const pending = await client.getTransaction({ hash }).catch(notFound);
    return pending ? { state: 'pending' } : { state: 'unknown' };
  }

  return {
    chain,
    curve: 'secp256k1',
    finalityDepth: opts.finalityDepth ?? 3,

    deriveAddress(publicKey: Uint8Array): string {
      const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false);
      return publicKeyToAddress(bytesToHex(uncompressed));
    },

    validateAddress(address: string): boolean {
      try {
        return getAddress(address) === address; // only the EIP-55 checksummed form
      } catch {
        return false;
      }
    },

    async getBalance(address: string, asset: AssetId): Promise<bigint> {
      if (asset === 'native') return client.getBalance({ address: address as Address });
      return client.readContract({
        address: token(asset),
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [address as Address],
      });
    },

    async getTip() {
      const block = await client.getBlock({ blockTag: 'latest' });
      return { height: Number(block.number), hash: block.hash };
    },

    async quoteFee(intent: TransferIntent): Promise<Fee> {
      const { maxFeePerGas, maxPriorityFeePerGas } = await client.estimateFeesPerGas();
      let gasLimit = 21000n;
      if (intent.asset !== 'native') {
        // the estimate runs the call, so it reverts if the sender does not hold the tokens
        const estimate = await client.estimateGas({
          account: intent.from as Address,
          ...call(intent),
        });
        gasLimit = (estimate * 12n) / 10n;
      }
      return {
        gasLimit: gasLimit.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
      };
    },

    async syncInputs(store: InputStore, address: string): Promise<void> {
      const nonce = await client.getTransactionCount({
        address: address as Address,
        blockTag: 'pending',
      });
      await store.seedSequence(`${chain}:${address}`, BigInt(nonce));
    },

    async reserveInputs(store: InputStore, intent: TransferIntent): Promise<Reservation> {
      const nonce = await store.nextSequence(`${chain}:${intent.from}`);
      return { nonce: nonce.toString() };
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- async so a bad intent rejects
    async buildTransfer(intent: TransferIntent, reservation: Json, fee: Json): Promise<UnsignedTx> {
      const { nonce } = reservation as Reservation;
      const { gasLimit, maxFeePerGas, maxPriorityFeePerGas } = fee as Fee;
      const { to, value, data } = call(intent);
      const body: Body = {
        chainId: String(LOCAL_CHAIN_ID),
        nonce,
        to,
        value: value.toString(),
        data,
        gas: gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      };
      const digest = keccak256(serializeTransaction(toSerializable(body)));
      return { body, signingPayloads: [digest.slice(2)] }; // bare lower-case hex
    },

    attachSignatures(unsigned: UnsignedTx, signatures: Uint8Array[]) {
      const [sig, ...rest] = signatures;
      if (!sig || rest.length > 0)
        throw new Error(`expected 1 signature, got ${signatures.length}`);
      if (sig.length !== 65) throw new Error(`expected a 65-byte signature, got ${sig.length}`);
      // viem reads any non-zero value as 1, so a 27/28 signer would sign as another address
      const yParity = sig[64]!;
      if (yParity > 1) throw new Error(`recovery id must be 0 or 1, got ${yParity}`);
      const raw = serializeTransaction(toSerializable(unsigned.body as Body), {
        r: bytesToHex(sig.subarray(0, 32)),
        s: bytesToHex(sig.subarray(32, 64)),
        yParity,
      });
      return { txid: keccak256(raw), raw };
    },

    buildReplacement(): Promise<{ unsigned: UnsignedTx; fee: Json } | null> {
      throw new Error('not implemented');
    },

    async broadcast({ txid, raw }) {
      if (await nodeHas(txid)) return { outcome: 'already_known' };
      let hash: Hash;
      try {
        hash = await client.sendRawTransaction({ serializedTransaction: raw as Hex });
      } catch (error) {
        const reason = nodeAnswer(error);
        // The text does not say whether these bytes are the ones the node has ("nonce too low"
        // is also what another transaction with a used nonce gets); the txid lookup does.
        return (await nodeHas(txid))
          ? { outcome: 'already_known' }
          : { outcome: 'rejected', reason };
      }
      if (hash !== txid) throw new Error(`node reports hash ${hash} for local txid ${txid}`);
      return { outcome: 'accepted' };
    },

    getTxStatus,

    scanBlock(): Promise<never> {
      throw new Error('not implemented');
    },
  };
}
