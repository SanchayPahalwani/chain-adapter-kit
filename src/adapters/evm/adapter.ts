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
  hexToBytes,
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
  IncomingTransfer,
  InputStore,
  Json,
  ScannedBlock,
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
  // Checksummed. Not serialised (the signature names the sender), but a nonce is a nonce of one
  // sender: attachSignatures accepts only this sender's signature, so every attempt of a
  // withdrawal is sent from the address whose nonce it reserved.
  from: string;
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

const digestOf = (body: Body): Hex => keccak256(serializeTransaction(toSerializable(body)));

function unsignedTx(body: Body): UnsignedTx {
  return { body, signingPayloads: [digestOf(body).slice(2)] }; // bare lower-case hex
}

// The node's own error text. Anything that is not the node answering (an HTTP error, a
// timeout, a closed socket) is rethrown: it says nothing about the transaction. A JSON-RPC
// error that came with a non-2xx status (viem sets `status`) is from a proxy or a failing
// node, not a verdict, so it is rethrown too.
function nodeAnswer(error: unknown): string {
  const rpc = error instanceof BaseError ? error.walk((e) => e instanceof RpcRequestError) : null;
  if (!(rpc instanceof RpcRequestError) || rpc.status !== undefined) throw error;
  return rpc.details;
}

// At least one eighth more, rounded up (geth requires 10% on both fee fields; anvil takes
// any increase), and never below what the market asks now.
function bumped(previous: string, market: bigint): string {
  const raised = BigInt(previous) + (BigInt(previous) + 7n) / 8n;
  return (raised > market ? raised : market).toString();
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
        from: getAddress(intent.from),
        nonce,
        to,
        value: value.toString(),
        data,
        gas: gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
      };
      return unsignedTx(body);
    },

    attachSignatures(unsigned: UnsignedTx, signatures: Uint8Array[]) {
      const [sig, ...rest] = signatures;
      if (!sig || rest.length > 0)
        throw new Error(`expected 1 signature, got ${signatures.length}`);
      if (sig.length !== 65) throw new Error(`expected a 65-byte signature, got ${sig.length}`);
      // viem reads any non-zero value as 1, so a 27/28 signer would sign as another address
      const recovery = sig[64]!;
      if (recovery > 1) throw new Error(`recovery id must be 0 or 1, got ${recovery}`);
      const body = unsigned.body as Body;
      // The sender is recovered from the signature and the digest of the body itself, as on
      // Bitcoin: another key, or a wrong recovery id, would send from another address with this
      // nonce, a transaction that could confirm next to this withdrawal's other attempts.
      let signature = secp256k1.Signature.fromBytes(sig.subarray(0, 64), 'compact');
      const key = signature.addRecoveryBit(recovery).recoverPublicKey(hexToBytes(digestOf(body)));
      const sender = publicKeyToAddress(bytesToHex(key.toBytes(false)));
      if (sender !== body.from) throw new Error(`signed by ${sender}, not the sender ${body.from}`);
      // the node takes only low-S; (r, n - s) with the other parity is the same signature
      let yParity = recovery;
      if (signature.hasHighS()) {
        signature = new secp256k1.Signature(signature.r, secp256k1.Point.Fn.ORDER - signature.s);
        yParity ^= 1;
      }
      const rs = signature.toBytes('compact');
      const raw = serializeTransaction(toSerializable(body), {
        r: bytesToHex(rs.subarray(0, 32)),
        s: bytesToHex(rs.subarray(32, 64)),
        yParity,
      });
      return { txid: keccak256(raw), raw };
    },

    // Same nonce and every other field, higher fees: at most one of the two can confirm. Built
    // from the previous attempt, so a caller with another sender or another nonce is refused
    // rather than given a transaction that does not replace anything.
    async buildReplacement(intent, reservation, previous) {
      const body = previous.unsigned.body as Body;
      if (getAddress(intent.from) !== body.from) {
        throw new Error(
          `the sender ${intent.from} differs from the previous attempt's ${body.from}`,
        );
      }
      const { nonce } = reservation as Reservation;
      if (nonce !== body.nonce) {
        throw new Error(
          `the reservation (nonce ${nonce}) differs from the previous attempt's nonce ${body.nonce}`,
        );
      }
      const market = await client.estimateFeesPerGas();
      const fee: Fee = {
        gasLimit: body.gas,
        maxFeePerGas: bumped(body.maxFeePerGas, market.maxFeePerGas),
        maxPriorityFeePerGas: bumped(body.maxPriorityFeePerGas, market.maxPriorityFeePerGas),
      };
      const { maxFeePerGas, maxPriorityFeePerGas } = fee;
      return { unsigned: unsignedTx({ ...body, maxFeePerGas, maxPriorityFeePerGas }), fee };
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

    // viem throws BlockNotFoundError for a height above the tip.
    async scanBlock(height: number): Promise<ScannedBlock> {
      const block = await client.getBlock({
        blockNumber: BigInt(height),
        includeTransactions: true,
      });
      const transfers: IncomingTransfer[] = [];
      for (const tx of block.transactions) {
        if (!tx.to || tx.value === 0n) continue;
        // a value transfer can revert, and only its receipt says so
        const receipt = await client.getTransactionReceipt({ hash: tx.hash });
        if (receipt.blockHash !== block.hash)
          throw new Error(`block ${height} changed in the scan`);
        if (receipt.status !== 'success') continue;
        const to = getAddress(tx.to);
        transfers.push({ txid: tx.hash, index: 0, to, asset: 'native', amount: tx.value });
      }
      // viem returns tx.to and the log addresses as the node spells them, lower-case on anvil, and
      // decodes args.to checksummed; the getAddress calls (above for tx.to, below for the token)
      // checksum the first two, so all compare equal to AssetIds and addresses elsewhere in the
      // kit. The size guard matters: an empty address filter would match every contract's logs.
      const logs =
        tokens.size > 0
          ? await client.getContractEvents({
              abi: erc20Abi,
              eventName: 'Transfer',
              address: [...tokens],
              blockHash: block.hash,
              strict: true,
            })
          : [];
      for (const { transactionHash: txid, logIndex: index, address, args } of logs) {
        transfers.push({
          txid,
          index,
          to: args.to,
          asset: getAddress(address),
          amount: args.value,
        });
      }
      return { block: { height, hash: block.hash }, parentHash: block.parentHash, transfers };
    },
  };
}
