// EVM adapter paths the conformance suite does not reach: send errors, races between
// lookups, bad signatures and the chain-id guard. Most run against a stub JSON-RPC server.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { hexToBytes } from '@noble/curves/utils.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEvmAdapter } from '../src/adapters/evm/adapter.js';
import { createEvmDevnet } from '../src/adapters/evm/devnet.js';
import { config } from '../src/config.js';
import type { ChainAdapter, InputStore, UnsignedTx } from '../src/core/adapter.js';
import { LocalSigner } from '../src/core/local-signer.js';
import { MemoryInputStore } from '../src/core/memory-input-store.js';

type Reply =
  { result: unknown } | { error: { code: number; message: string } } | 'http500' | 'hangup';
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
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, ...reply }));
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
    await expect(send()).rejects.toThrow();
    node.play({ eth_sendRawTransaction: ['hangup'] });
    await expect(send()).rejects.toThrow();
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

  it('attachSignatures accepts recovery id 0 or 1 only', () => {
    const unsigned: UnsignedTx = {
      body: {
        chainId: '31337',
        nonce: '0',
        to: '0x52908400098527886E0F7030069857D2E4169EE7',
        value: '1',
        data: '0x',
        gas: '21000',
        maxFeePerGas: '2000000000',
        maxPriorityFeePerGas: '1000000000',
      },
      signingPayloads: [],
    };
    const sig = (recovery: number) => new Uint8Array([...new Uint8Array(64).fill(0x34), recovery]);
    expect(adapter.attachSignatures(unsigned, [sig(0)]).raw).not.toBe(
      adapter.attachSignatures(unsigned, [sig(1)]).raw,
    );
    expect(() => adapter.attachSignatures(unsigned, [sig(27)])).toThrow(/recovery id/);
    expect(() => adapter.attachSignatures(unsigned, [sig(2)])).toThrow(/recovery id/);
  });
});

describe('EVM adapter broadcast against anvil', () => {
  const signer = LocalSigner.random();
  let adapter: ChainAdapter;
  let devnet: Awaited<ReturnType<typeof createEvmDevnet>>;

  beforeAll(async () => {
    devnet = await createEvmDevnet(config.evmRpcUrl);
    adapter = await createEvmAdapter({ rpcUrl: config.evmRpcUrl });
  });

  async function wallet() {
    const keyId = `evm-test-${randomUUID()}`;
    return { keyId, address: adapter.deriveAddress(await signer.publicKey(keyId, 'secp256k1')) };
  }

  async function signedTransfer(from: { keyId: string; address: string }, store: InputStore) {
    const intent = {
      from: from.address,
      to: (await wallet()).address,
      asset: 'native',
      amount: 1n,
    };
    const fee = await adapter.quoteFee(intent);
    await adapter.syncInputs(store, from.address);
    const unsigned = await adapter.buildTransfer(
      intent,
      await adapter.reserveInputs(store, intent, fee),
      fee,
    );
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
});
