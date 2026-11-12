// Bitcoin adapter paths the conformance suite does not reach. B1 and B11 run against a stub node;
// the rest need `docker compose up -d --wait bitcoind`.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToNumberBE, hexToBytes, numberToBytesBE } from '@noble/curves/utils.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { createBitcoinAdapter } from '../src/adapters/bitcoin/adapter.js';
import { createBitcoinDevnet, type BitcoinDevnet } from '../src/adapters/bitcoin/devnet.js';
import { config } from '../src/config.js';
import type { ChainAdapter, Json, UnsignedTx } from '../src/core/adapter.js';
import { LocalSigner } from '../src/core/local-signer.js';
import { MemoryInputStore } from '../src/core/memory-input-store.js';

// A JSON-RPC server that answers every call with `results[method]` (null if absent).
async function stubNode(results: Record<string, unknown>) {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: results[method] ?? null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

describe('createBitcoinAdapter', () => {
  it('B1 refuses a node that is not regtest', async () => {
    const mainnet = await stubNode({ getblockchaininfo: { chain: 'main', blocks: 1 } });
    try {
      await expect(
        createBitcoinAdapter({ rpcUrl: mainnet.url, auth: config.bitcoinRpcAuth }),
      ).rejects.toThrow(/refusing chain "main"/);
    } finally {
      mainnet.close();
    }
  });

  it('B11 refuses a node without a synced transaction index, and a fee rate that is not positive', async () => {
    const regtest = { chain: 'regtest', blocks: 1 };
    const start = async (index: unknown, feeRate?: bigint) => {
      const node = await stubNode({ getblockchaininfo: regtest, getindexinfo: index });
      try {
        await createBitcoinAdapter({ rpcUrl: node.url, auth: config.bitcoinRpcAuth, feeRate });
      } finally {
        node.close();
      }
    };
    const synced = { txindex: { synced: true, best_block_height: 1 } };
    await expect(start({})).rejects.toThrow(/-txindex=1/); // started without -txindex
    await expect(start({ txindex: { synced: false, best_block_height: 0 } })).rejects.toThrow(
      /synced transaction index/,
    );
    await expect(start(synced, 0n)).rejects.toThrow(/fee rate must be above 0/);
    await expect(start(synced, -2n)).rejects.toThrow(/fee rate must be above 0/);
    await expect(start(synced)).resolves.toBeUndefined();
  });
});

describe('Bitcoin adapter against regtest', () => {
  const signer = LocalSigner.random();
  let adapter: ChainAdapter;
  let devnet: BitcoinDevnet;

  beforeAll(async () => {
    devnet = await createBitcoinDevnet(config.bitcoinRpcUrl, config.bitcoinRpcAuth);
    adapter = await createBitcoinAdapter({
      rpcUrl: config.bitcoinRpcUrl,
      auth: config.bitcoinRpcAuth,
    });
  });

  async function wallet() {
    const keyId = `bitcoin-test-${randomUUID()}`;
    return { keyId, address: adapter.deriveAddress(await signer.publicKey(keyId, 'secp256k1')) };
  }

  async function sign(keyId: string, unsigned: UnsignedTx) {
    const signatures: Uint8Array[] = [];
    for (const payload of unsigned.signingPayloads)
      signatures.push(await signer.sign(keyId, 'secp256k1', hexToBytes(payload)));
    return signatures;
  }

  // the output addresses of a raw transaction, as the node decodes them
  async function outputs(raw: string) {
    const tx = await devnet.rpc.call<{ vout: { scriptPubKey: { address: string } }[] }>(
      'decoderawtransaction',
      [raw],
    );
    return tx.vout.map((o) => o.scriptPubKey.address);
  }

  // a wallet holding one confirmed coin per amount
  async function walletWith(...coins: bigint[]) {
    const w = await wallet();
    for (const amount of coins) await devnet.fund(w.address, 'native', amount);
    return w;
  }

  it('B2 syncInputs and getBalance survive a parallel scan', async () => {
    // the node runs one UTXO scan at a time and answers -8 to a second one
    const from = await wallet();
    await devnet.fund(from.address, 'native', 250_000n);
    const store = new MemoryInputStore();
    const results = await Promise.all([
      adapter.syncInputs(store, from.address),
      adapter.getBalance(from.address, 'native'),
      adapter.syncInputs(store, from.address),
      adapter.getBalance(from.address, 'native'),
      adapter.getBalance(from.address, 'native'),
    ]);
    expect(results).toEqual([undefined, 250_000n, undefined, 250_000n, 250_000n]);
    const coins = await store.freeCoins(from.address);
    expect(coins).toHaveLength(1);
    expect(coins[0]).toMatchObject({ owner: from.address, amount: 250_000n, data: {} });
    expect(coins[0]?.id).toMatch(/^[0-9a-f]{64}:\d+$/);
  });

  it('B3 change below dust is folded into the fee; the recipient gets exactly amount', async () => {
    // 1 input, 2 outputs: 141 vB at 2 sat/vB = 282 sat. Change of 294 sat is the smallest
    // P2WPKH output the node relays (3 sat/vB dust rate).
    const coin = 100_000n;
    const fee = 282n;
    const cases = [
      { change: 294n, outputs: 2, feePaid: fee },
      { change: 293n, outputs: 1, feePaid: fee + 293n },
    ];
    const sent = [];
    for (const { change, outputs: count, feePaid } of cases) {
      const from = await wallet();
      const to = (await wallet()).address;
      await devnet.fund(from.address, 'native', coin);
      const intent = { from: from.address, to, asset: 'native', amount: coin - fee - change };
      const quote = await adapter.quoteFee(intent);
      const store = new MemoryInputStore();
      await adapter.syncInputs(store, from.address);
      const reservation = await adapter.reserveInputs(store, intent, quote);
      const unsigned = await adapter.buildTransfer(intent, reservation, quote);
      const signed = adapter.attachSignatures(unsigned, await sign(from.keyId, unsigned));
      const outs = await outputs(signed.raw);
      expect(outs).toHaveLength(count);
      expect(outs[0]).toBe(to);
      expect(await adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });
      sent.push({ signed, from, to, intent, change: count === 2 ? change : 0n, feePaid });
    }
    await devnet.mine(1);
    for (const { signed, from, to, intent, change, feePaid } of sent) {
      const status = await adapter.getTxStatus(signed.txid);
      expect(status).toMatchObject({ state: 'confirmed', feePaid });
      expect(await adapter.getBalance(to, 'native')).toBe(intent.amount);
      expect(await adapter.getBalance(from.address, 'native')).toBe(change);
    }
  });

  it('B7 attachSignatures rejects a signature from another key', async () => {
    const from = await wallet();
    const other = await wallet();
    const intent = { from: from.address, to: other.address, asset: 'native', amount: 50_000n };
    const fee: Json = { feeRate: '2' };
    // attachSignatures and buildTransfer need no chain: an invented coin of `from` will do
    const reservation: Json = { coins: [{ id: `${'ab'.repeat(32)}:1`, amount: '100000' }] };
    const unsigned = await adapter.buildTransfer(intent, reservation, fee);

    const [good] = await sign(from.keyId, unsigned);
    const signed = adapter.attachSignatures(unsigned, [good!]);
    expect(signed.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(() => adapter.attachSignatures(unsigned, [])).toThrow(/0 signatures for 1 inputs/);

    const wrongKey = await sign(other.keyId, unsigned);
    expect(() => adapter.attachSignatures(unsigned, wrongKey)).toThrow(/does not own/);
    // the right key with the other recovery id recovers some other public key
    const flipped = Uint8Array.from(good!);
    flipped[64] = flipped[64]! ^ 1;
    expect(() => adapter.attachSignatures(unsigned, [flipped])).toThrow(/does not own/);

    // (r, n - s) with the other recovery id is the same key's signature in high-S form, which
    // the node would not relay: it gives the same transaction as the low-S one
    const s = bytesToNumberBE(good!.subarray(32, 64));
    const highS = Uint8Array.of(
      ...good!.subarray(0, 32),
      ...numberToBytesBE(secp256k1.Point.Fn.ORDER - s, 32),
      good![64]! ^ 1,
    );
    expect(adapter.attachSignatures(unsigned, [highS])).toEqual(signed);

    // malformed: a signature without its recovery id, a recovery id of 2, one signature too many
    expect(() => adapter.attachSignatures(unsigned, [good!.subarray(0, 64)])).toThrow(
      /64 bytes, not 65/,
    );
    const two = Uint8Array.from(good!);
    two[64] = 2;
    expect(() => adapter.attachSignatures(unsigned, [two])).toThrow(/recovery id must be 0 or 1/);
    expect(() => adapter.attachSignatures(unsigned, [good!, good!])).toThrow(
      /2 signatures for 1 inputs/,
    );
  });

  it('B9 a transfer from two coins signs each input with its own amount; change and fee are exact', async () => {
    // 2 inputs, 2 outputs: 209 vB at 2 sat/vB = 418 sat; change 60,000 + 50,000 - 100,000 - 418
    const from = await walletWith(60_000n, 50_000n);
    const to = (await wallet()).address;
    const intent = { from: from.address, to, asset: 'native', amount: 100_000n };
    const fee = await adapter.quoteFee(intent);
    const store = new MemoryInputStore();
    await adapter.syncInputs(store, from.address);
    const reservation = await adapter.reserveInputs(store, intent, fee);
    // largest first: the 60,000 coin alone does not pay 100,000 plus the fee
    expect((reservation as { coins: { amount: string }[] }).coins.map((c) => c.amount)).toEqual([
      '60000',
      '50000',
    ]);
    const unsigned = await adapter.buildTransfer(intent, reservation, fee);
    expect(unsigned.signingPayloads).toHaveLength(2);
    expect(unsigned.signingPayloads[0]).not.toBe(unsigned.signingPayloads[1]);
    const signed = adapter.attachSignatures(unsigned, await sign(from.keyId, unsigned));
    expect(await outputs(signed.raw)).toEqual([to, from.address]);
    expect(await adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });
    await devnet.mine(1);

    const node = await devnet.rpc.call<{ vin: unknown[]; vout: { value: number }[]; fee: number }>(
      'getrawtransaction',
      [signed.txid, 2],
    );
    expect(node.vin).toHaveLength(2);
    expect(node.vout.map((o) => o.value)).toEqual([0.001, 0.00009582]);
    expect(node.fee).toBe(0.00000418);
    expect(await adapter.getTxStatus(signed.txid)).toMatchObject({
      state: 'confirmed',
      feePaid: 418n,
    });
    expect(await adapter.getBalance(to, 'native')).toBe(100_000n);
    expect(await adapter.getBalance(from.address, 'native')).toBe(9_582n);
  });

  it('B10 quoteFee refuses dust; reserveInputs refuses what the free coins cannot pay and reserves nothing', async () => {
    const from = await walletWith(60_000n, 50_000n);
    const to = (await wallet()).address;
    const intent = (amount: bigint, asset = 'native') => ({
      from: from.address,
      to,
      asset,
      amount,
    });
    await expect(adapter.quoteFee(intent(293n))).rejects.toThrow(/below the 294 sat dust limit/);
    await expect(adapter.quoteFee(intent(294n))).resolves.toEqual({ feeRate: '2' });

    const fee: Json = { feeRate: '2' };
    const store = new MemoryInputStore();
    await adapter.syncInputs(store, from.address);
    // both coins together hold 110,000, short of 110,000 plus the fee
    await expect(adapter.reserveInputs(store, intent(110_000n), fee)).rejects.toThrow(
      /not enough free coins/,
    );
    await expect(adapter.reserveInputs(store, intent(1_000n, 'token'), fee)).rejects.toThrow(
      /unknown asset token/,
    );
    expect(await store.freeCoins(from.address)).toHaveLength(2);
    // the largest coin is still free: it pays a smaller transfer on its own
    const reservation = await adapter.reserveInputs(store, intent(50_000n), fee);
    expect(reservation).toEqual({
      coins: [{ id: expect.stringMatching(/:\d+$/) as string, amount: '60000' }],
    });
    expect(await store.freeCoins(from.address)).toHaveLength(1);
  });
});
