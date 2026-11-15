// EVM adapter paths the conformance suite does not reach: send errors, races between
// lookups, bad signatures and the chain-id guard. Most run against a stub JSON-RPC server.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToNumberBE, hexToBytes, numberToBytesBE } from '@noble/curves/utils.js';
import {
  BlockNotFoundError,
  HttpRequestError,
  createPublicClient,
  http,
  keccak256,
  numberToHex,
  parseTransaction,
  recoverTransactionAddress,
  type Hash,
  type Hex,
} from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvmAdapter } from '../src/adapters/evm/adapter.js';
import { createEvmDevnet } from '../src/adapters/evm/devnet.js';
import { config } from '../src/config.js';
import type { ChainAdapter, InputStore, Json } from '../src/core/adapter.js';
import { LocalSigner } from '../src/core/local-signer.js';
import { MemoryInputStore } from '../src/core/memory-input-store.js';

type Reply =
  | { result: unknown }
  | { error: { code: number; message: string }; status?: number }
  | 'http500'
  | 'hangup';
type Script = Record<string, Reply[]>; // per method, replies in order; the last one repeats

// A JSON-RPC server that answers chain id `chainId` and otherwise follows the current script
// (null for any method the script does not name).
async function stubNode(chainId: string) {
  let script: Script = {};
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const queue = script[method] ?? [];
      const reply: Reply =
        method === 'eth_chainId'
          ? { result: chainId }
          : ((queue.length > 1 ? queue.shift() : queue[0]) ?? { result: null });
      if (reply === 'hangup') return void req.socket.destroy();
      if (reply === 'http500') {
        res.statusCode = 500;
        return void res.end('upstream says no');
      }
      // `status` steers this server; it is not part of the JSON-RPC body
      const { status, ...payload } = reply as {
        status?: number;
        result?: unknown;
        error?: unknown;
      };
      if (status) res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    play: (next: Script) => (script = next),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const TXID = '0x' + 'ab'.repeat(32);
const RAW = '0x02' + 'cd'.repeat(40);
const tx = (blockNumber: string | null) => ({
  hash: TXID,
  blockHash: blockNumber && '0x' + '11'.repeat(32),
  blockNumber,
  transactionIndex: blockNumber && '0x0',
  from: '0x' + '22'.repeat(20),
  to: '0x' + '33'.repeat(20),
  gas: '0x5208',
  input: '0x',
  nonce: '0x0',
  value: '0x1',
  type: '0x2',
  chainId: '0x7a69',
  maxFeePerGas: '0x77359400',
  maxPriorityFeePerGas: '0x3b9aca00',
  accessList: [],
  v: '0x1',
  r: '0x1',
  s: '0x1',
  yParity: '0x1',
});
const receipt = (blockNumber: string) => ({
  transactionHash: TXID,
  blockHash: '0x' + '11'.repeat(32),
  blockNumber,
  transactionIndex: '0x0',
  from: '0x' + '22'.repeat(20),
  to: '0x' + '33'.repeat(20),
  contractAddress: null,
  cumulativeGasUsed: '0x5208',
  gasUsed: '0x5208',
  effectiveGasPrice: '0x3b9aca00',
  logs: [],
  logsBloom: '0x' + '00'.repeat(256),
  status: '0x1',
  type: '0x2',
});
const BLOCK_HASH = '0x' + '11'.repeat(32);
const block = (height: string) => ({
  number: height,
  hash: BLOCK_HASH,
  parentHash: '0x' + '00'.repeat(32),
  nonce: '0x0000000000000000',
  sha3Uncles: '0x' + '00'.repeat(32),
  logsBloom: '0x' + '00'.repeat(256),
  transactionsRoot: '0x' + '00'.repeat(32),
  stateRoot: '0x' + '00'.repeat(32),
  receiptsRoot: '0x' + '00'.repeat(32),
  miner: '0x' + '00'.repeat(20),
  difficulty: '0x0',
  totalDifficulty: '0x0',
  extraData: '0x',
  size: '0x1',
  gasLimit: '0x1c9c380',
  gasUsed: '0x5208',
  timestamp: '0x1',
  mixHash: '0x' + '00'.repeat(32),
  baseFeePerGas: '0x7',
  uncles: [],
  transactions: [tx(height)],
});
const nodeSays = (message: string): Reply => ({ error: { code: -32003, message } });

describe('createEvmAdapter', () => {
  it('rejects a node whose chain id is not 31337', async () => {
    const mainnet = await stubNode('0x1');
    try {
      await expect(createEvmAdapter({ rpcUrl: mainnet.url })).rejects.toThrow(/chain id 1\b/);
    } finally {
      mainnet.close();
    }
  });
});

describe('EVM adapter against a stub node', () => {
  let node: Awaited<ReturnType<typeof stubNode>>;
  let adapter: ChainAdapter;
  const send = () => adapter.broadcast({ txid: TXID, raw: RAW });

  beforeAll(async () => {
    node = await stubNode('0x7a69');
    adapter = await createEvmAdapter({ rpcUrl: node.url });
  });
  afterAll(() => node.close());

  it('broadcast throws on a transport failure instead of classifying it', async () => {
    node.play({ eth_sendRawTransaction: ['http500'] });
    await expect(send()).rejects.toThrow(HttpRequestError);
    node.play({ eth_sendRawTransaction: ['hangup'] });
    await expect(send()).rejects.toThrow(HttpRequestError);
  });

  it('broadcast throws on a JSON-RPC error that came with HTTP 500', async () => {
    node.play({
      eth_sendRawTransaction: [
        { error: { code: -32003, message: 'upstream failed' }, status: 500 },
      ],
    });
    await expect(send()).rejects.toThrow(/Status: 500/);
  });

  it('broadcast throws when the lookup after a send error fails in transport', async () => {
    node.play({
      eth_sendRawTransaction: [nodeSays('nonce too low: next nonce 5, tx nonce 3')],
      eth_getTransactionReceipt: [{ result: null }, 'hangup'],
    });
    await expect(send()).rejects.toThrow(HttpRequestError);
  });

  it('broadcast answers already_known after a send error when the node has the txid', async () => {
    // in the pool: absent at the pre-check, present when looked up after the error
    node.play({
      eth_sendRawTransaction: [nodeSays('nonce too low: next nonce 5, tx nonce 3')],
      eth_getTransactionByHash: [{ result: null }, { result: tx(null) }],
    });
    expect(await send()).toEqual({ outcome: 'already_known' });
    // in a block
    node.play({
      eth_sendRawTransaction: [nodeSays('nonce too low: next nonce 5, tx nonce 3')],
      eth_getTransactionReceipt: [{ result: null }, { result: receipt('0x5') }],
    });
    expect(await send()).toEqual({ outcome: 'already_known' });
  });

  it('broadcast answers rejected with the node text when the node does not have the txid', async () => {
    node.play({ eth_sendRawTransaction: [nodeSays('nonce too low: next nonce 5, tx nonce 3')] });
    expect(await send()).toEqual({
      outcome: 'rejected',
      reason: 'nonce too low: next nonce 5, tx nonce 3',
    });
  });

  it('broadcast throws when the node reports a different hash from the local txid', async () => {
    node.play({ eth_sendRawTransaction: [{ result: '0x' + 'ef'.repeat(32) }] });
    await expect(send()).rejects.toThrow(/local txid/);
  });

  it('getTxStatus is not confirmed when the tip reads below the receipt block', async () => {
    node.play({
      eth_getTransactionReceipt: [{ result: receipt('0x9') }],
      eth_blockNumber: [{ result: '0x7' }],
    });
    expect(await adapter.getTxStatus(TXID)).toEqual({ state: 'unknown' });
  });

  it('scanBlock throws when a receipt belongs to a different block than the one scanned', async () => {
    // control: a receipt from the same block lists the transfer
    node.play({
      eth_getBlockByNumber: [{ result: block('0x5') }],
      eth_getTransactionReceipt: [{ result: receipt('0x5') }],
    });
    const scanned = await adapter.scanBlock(5);
    expect(scanned.transfers).toHaveLength(1);
    expect(scanned.transfers[0]).toMatchObject({ txid: TXID, index: 0, asset: 'native' });

    // the node answers the receipt from another block: the chain moved under the scan
    node.play({
      eth_getBlockByNumber: [{ result: block('0x5') }],
      eth_getTransactionReceipt: [
        { result: { ...receipt('0x5'), blockHash: '0x' + '22'.repeat(32) } },
      ],
    });
    await expect(adapter.scanBlock(5)).rejects.toThrow(/block 5 changed in the scan/);
  });

  // A native transfer from the key `keyId` of `signer`, nonce 0; building it needs no node.
  async function unsignedFrom(signer: LocalSigner, keyId: string) {
    const from = adapter.deriveAddress(await signer.publicKey(keyId, 'secp256k1'));
    const intent = {
      from,
      to: '0x52908400098527886E0F7030069857D2E4169EE7',
      asset: 'native',
      amount: 1n,
    };
    const fee = {
      gasLimit: '21000',
      maxFeePerGas: '2000000000',
      maxPriorityFeePerGas: '1000000000',
    };
    const unsigned = await adapter.buildTransfer(intent, { nonce: '0', from }, fee);
    const sign = (key: string) =>
      signer.sign(key, 'secp256k1', hexToBytes(unsigned.signingPayloads[0]!));
    return { from, unsigned, sign };
  }

  it('attachSignatures accepts only a signature by the sender in the body, recovery id 0 or 1', async () => {
    const signer = LocalSigner.random();
    const { from, unsigned, sign } = await unsignedFrom(signer, 'hot');
    expect((unsigned.body as { from: string }).from).toBe(from);
    const good = await sign('hot');
    const signed = adapter.attachSignatures(unsigned, [good]);
    expect(signed.txid).toBe(keccak256(signed.raw as Hex));
    expect(
      await recoverTransactionAddress({ serializedTransaction: signed.raw as `0x02${string}` }),
    ).toBe(from);

    // another key of the same signer, a key of another signer: each would send from another address
    const otherKey = await sign('other');
    expect(() => adapter.attachSignatures(unsigned, [otherKey])).toThrow(
      new RegExp(`^signed by 0x[0-9a-fA-F]{40}, not the sender ${from}$`),
    );
    const otherSeed = await LocalSigner.random().sign(
      'hot',
      'secp256k1',
      hexToBytes(unsigned.signingPayloads[0]!),
    );
    expect(() => adapter.attachSignatures(unsigned, [otherSeed])).toThrow(/not the sender/);
    // the right key with the other recovery id recovers some other key
    const flipped = Uint8Array.from(good);
    flipped[64] = flipped[64]! ^ 1;
    expect(() => adapter.attachSignatures(unsigned, [flipped])).toThrow(/not the sender/);
    // a 27/28 signer, and a recovery id viem would read as 1
    for (const recovery of [27, 2]) {
      const bad = Uint8Array.from(good);
      bad[64] = recovery;
      expect(() => adapter.attachSignatures(unsigned, [bad])).toThrow(/recovery id must be 0 or 1/);
    }
    // a body from before the sender was part of it is refused, not signed for nobody
    const noSender: Record<string, Json> = { ...(unsigned.body as Record<string, Json>) };
    delete noSender.from;
    expect(() => adapter.attachSignatures({ ...unsigned, body: noSender }, [good])).toThrow(
      /not the sender undefined/,
    );
  });

  it('attachSignatures takes a high-S signature as its low-S form', async () => {
    const signer = LocalSigner.random();
    const { unsigned, sign } = await unsignedFrom(signer, 'hot');
    const low = await sign('hot'); // LocalSigner (noble) signs low-S
    const s = bytesToNumberBE(low.subarray(32, 64));
    expect(s <= secp256k1.Point.Fn.ORDER / 2n).toBe(true);
    // (r, n - s) with the other recovery id: the same key's signature in high-S form
    const high = Uint8Array.of(
      ...low.subarray(0, 32),
      ...numberToBytesBE(secp256k1.Point.Fn.ORDER - s, 32),
      low[64]! ^ 1,
    );
    const signed = adapter.attachSignatures(unsigned, [low]);
    expect(adapter.attachSignatures(unsigned, [high])).toEqual(signed);
    expect(parseTransaction(signed.raw as Hex).s).toBe(numberToHex(s, { size: 32 }));
  });
});

describe('EVM adapter broadcast against anvil', () => {
  const signer = LocalSigner.random();
  let adapter: ChainAdapter;
  let devnet: Awaited<ReturnType<typeof createEvmDevnet>>;
  const client = createPublicClient({ transport: http(config.evmRpcUrl), cacheTime: 0 });

  beforeAll(async () => {
    devnet = await createEvmDevnet(config.evmRpcUrl);
    adapter = await createEvmAdapter({ rpcUrl: config.evmRpcUrl });
  });

  async function wallet() {
    const keyId = `evm-test-${randomUUID()}`;
    return { keyId, address: adapter.deriveAddress(await signer.publicKey(keyId, 'secp256k1')) };
  }

  async function unsignedTransfer(
    from: { address: string },
    store: InputStore,
    { to, amount = 1n, fee }: { to?: string; amount?: bigint; fee?: Json } = {},
  ) {
    const intent = {
      from: from.address,
      to: to ?? (await wallet()).address,
      asset: 'native',
      amount,
    };
    fee ??= await adapter.quoteFee(intent);
    await adapter.syncInputs(store, from.address);
    const reservation = await adapter.reserveInputs(store, intent, fee);
    return {
      intent,
      reservation,
      fee,
      unsigned: await adapter.buildTransfer(intent, reservation, fee),
    };
  }

  async function signedTransfer(
    from: { keyId: string; address: string },
    store: InputStore,
    options?: { to?: string; amount?: bigint },
  ) {
    const { unsigned } = await unsignedTransfer(from, store, options);
    const payload = hexToBytes(unsigned.signingPayloads[0]!);
    return adapter.attachSignatures(unsigned, [
      await signer.sign(from.keyId, 'secp256k1', payload),
    ]);
  }

  it('a sender with no funds is rejected with the node reason', async () => {
    const result = await adapter.broadcast(
      await signedTransfer(await wallet(), new MemoryInputStore()),
    );
    expect(result).toEqual({
      outcome: 'rejected',
      reason: expect.stringMatching(/insufficient funds/i) as string,
    });
  });

  it('a different transaction reusing a mined nonce is rejected', async () => {
    const from = await wallet();
    await devnet.fund(from.address, 'native', 10n ** 18n);
    // two stores seeded from the same chain state hand out the same nonce
    const first = await signedTransfer(from, new MemoryInputStore());
    const second = await signedTransfer(from, new MemoryInputStore());
    expect(await adapter.broadcast(first)).toEqual({ outcome: 'accepted' });
    await devnet.mine(1);
    expect(await adapter.broadcast(second)).toEqual({
      outcome: 'rejected',
      reason: expect.stringMatching(/nonce too low/) as string,
    });
  });

  it('pendingFrom also counts a transaction waiting behind a nonce gap', async () => {
    const from = await wallet();
    await devnet.fund(from.address, 'native', 10n ** 18n);
    const store = new MemoryInputStore(); // one store: nonces n and n + 1
    const first = await signedTransfer(from, store);
    const second = await signedTransfer(from, store);
    expect(await adapter.broadcast(second)).toEqual({ outcome: 'accepted' }); // queued: n is missing
    expect(await devnet.pendingFrom(from.address)).toBe(1);
    expect(await adapter.broadcast(first)).toEqual({ outcome: 'accepted' });
    expect(await devnet.pendingFrom(from.address)).toBe(2);
    await devnet.mine(1);
    expect(await devnet.pendingFrom(from.address)).toBe(0);
  });

  it('buildReplacement keeps every field but the fees, and bumps each by at least one eighth', async () => {
    const from = await wallet();
    const high = {
      gasLimit: '21000',
      maxFeePerGas: '1000000000000001', // 10^15 + 1 wei, far above any market fee
      maxPriorityFeePerGas: '100000000000001', // 10^14 + 1
    };
    const previous = await unsignedTransfer(from, new MemoryInputStore(), { fee: high });
    const replacement = await adapter.buildReplacement(
      previous.intent,
      previous.reservation,
      previous,
    );
    const fee = {
      gasLimit: '21000',
      maxFeePerGas: '1125000000000002', // previous + ceil(previous / 8)
      maxPriorityFeePerGas: '112500000000002',
    };
    expect(replacement?.fee).toEqual(fee);
    expect(replacement?.unsigned.body).toEqual({
      ...(previous.unsigned.body as object),
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    });
  });

  it('buildReplacement refuses a sender or a nonce other than the previous attempt', async () => {
    const from = await wallet();
    const previous = await unsignedTransfer(from, new MemoryInputStore());
    const { nonce } = previous.reservation as { nonce: string };
    // control: the same sender and reservation are replaced
    await expect(
      adapter.buildReplacement(previous.intent, previous.reservation, previous),
    ).resolves.toMatchObject({ unsigned: { body: { from: from.address, nonce } } });

    const other = (await wallet()).address;
    await expect(
      adapter.buildReplacement({ ...previous.intent, from: other }, previous.reservation, previous),
    ).rejects.toThrow(`the sender ${other} differs from the previous attempt's ${from.address}`);
    const next = String(BigInt(nonce) + 1n);
    await expect(
      adapter.buildReplacement(
        previous.intent,
        { ...(previous.reservation as object), nonce: next },
        previous,
      ),
    ).rejects.toThrow(`the reservation (nonce ${next}) differs from the previous attempt's nonce`);
  });

  it('buildTransfer refuses a reservation made for another address', async () => {
    const from = await wallet();
    const other = (await wallet()).address;
    const previous = await unsignedTransfer(from, new MemoryInputStore());
    const { nonce } = previous.reservation as { nonce: string };
    const fee = { gasLimit: '21000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1' };
    await expect(
      adapter.buildTransfer(previous.intent, { nonce, from: other }, fee),
    ).rejects.toThrow(`differs from the address ${other} the nonce was reserved for`);
    await expect(
      adapter.buildReplacement(previous.intent, { nonce, from: other }, previous),
    ).rejects.toThrow(`the reservation's address ${other} differs`);
  });

  it('buildReplacement follows the market when it is above the bumped fee', async () => {
    const from = await wallet();
    const low = { gasLimit: '21000', maxFeePerGas: '8', maxPriorityFeePerGas: '1' };
    const previous = await unsignedTransfer(from, new MemoryInputStore(), { fee: low });
    // The market is a function of the latest block, so compare only reads taken in one block.
    for (let attempt = 0; attempt < 5; attempt++) {
      const before = await adapter.getTip();
      const market = await adapter.quoteFee(previous.intent);
      const replacement = await adapter.buildReplacement(
        previous.intent,
        previous.reservation,
        previous,
      );
      const after = await adapter.getTip();
      if (before.hash !== after.hash) continue; // a block arrived between the reads: read again
      expect(replacement?.fee).toEqual(market);
      return;
    }
    throw new Error('a block was mined during every attempt');
  });

  it('scanBlock lists a value transfer and the configured token, and skips the rest', async () => {
    const [token, other] = [await devnet.deployTestToken(), await devnet.deployTestToken()];
    // `scanner` knows one token; `builder` knows both, to build a transfer of the other
    const scanner = await createEvmAdapter({ rpcUrl: config.evmRpcUrl, tokens: [token] });
    const builder = await createEvmAdapter({ rpcUrl: config.evmRpcUrl, tokens: [token, other] });
    const [a, b, c, d] = [await wallet(), await wallet(), await wallet(), await wallet()];
    for (const w of [a, b, c, d]) await devnet.fund(w.address, 'native', 10n ** 18n);
    await devnet.fund(c.address, token, 100n);
    await devnet.fund(c.address, other, 100n);
    const recipient = (await wallet()).address;

    // value sent to a contract with only the intrinsic 21000 gas runs out of gas and reverts
    const reverted = await signedTransfer(a, new MemoryInputStore(), { to: token });
    const zero = await signedTransfer(b, new MemoryInputStore(), { amount: 0n });
    const value = await signedTransfer(d, new MemoryInputStore(), { to: recipient, amount: 7n });
    const cStore = new MemoryInputStore(); // one store: the two token transfers get nonces n, n+1
    const tokenTransfer = async (asset: string) => {
      const intent = { from: c.address, to: recipient, asset, amount: 5n };
      const fee = await builder.quoteFee(intent);
      await builder.syncInputs(cStore, c.address);
      const reservation = await builder.reserveInputs(cStore, intent, fee);
      const unsigned = await builder.buildTransfer(intent, reservation, fee);
      const sig = await signer.sign(c.keyId, 'secp256k1', hexToBytes(unsigned.signingPayloads[0]!));
      return builder.attachSignatures(unsigned, [sig]);
    };
    const wanted = await tokenTransfer(token);
    const unwanted = await tokenTransfer(other);
    for (const t of [reverted, zero, value, wanted, unwanted]) {
      expect(await adapter.broadcast(t)).toEqual({ outcome: 'accepted' });
    }
    await devnet.mine(1);
    expect(await adapter.getTxStatus(reverted.txid)).toMatchObject({ succeeded: false });
    expect(await adapter.getTxStatus(zero.txid)).toMatchObject({ succeeded: true });

    const tip = await adapter.getTip();
    expect(await adapter.getTxStatus(zero.txid)).toMatchObject({ block: tip });
    const { transfers } = await scanner.scanBlock(tip.height);
    const ids = transfers.map((t) => t.txid);
    expect(ids).not.toContain(reverted.txid);
    expect(ids).not.toContain(zero.txid);
    expect(ids).not.toContain(unwanted.txid);
    expect(transfers.filter((t) => t.asset === other)).toEqual([]);
    // positive controls
    expect(transfers.filter((t) => t.txid === value.txid)).toEqual([
      { txid: value.txid, index: 0, to: recipient, asset: 'native', amount: 7n },
    ]);
    const logIndex = (await client.getTransactionReceipt({ hash: wanted.txid as Hash })).logs[0]
      ?.logIndex;
    expect(logIndex).toBeDefined();
    expect(transfers.filter((t) => t.txid === wanted.txid)).toEqual([
      { txid: wanted.txid, index: logIndex, to: recipient, asset: token, amount: 5n },
    ]);
    await expect(adapter.scanBlock(tip.height + 1)).rejects.toThrow(BlockNotFoundError);
  });
});
