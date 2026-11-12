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
import { btcToSats } from '../src/adapters/bitcoin/rpc.js';
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

  // a signed transfer of `amount` from the confirmed coins of `from`, not sent
  async function prepare(from: { keyId: string; address: string }, to: string, amount: bigint) {
    const intent = { from: from.address, to, asset: 'native', amount };
    const fee = await adapter.quoteFee(intent);
    const store = new MemoryInputStore();
    await adapter.syncInputs(store, from.address);
    const reservation = await adapter.reserveInputs(store, intent, fee);
    const unsigned = await adapter.buildTransfer(intent, reservation, fee);
    const signed = adapter.attachSignatures(unsigned, await sign(from.keyId, unsigned));
    return { intent, fee, reservation, unsigned, signed };
  }

  // another transaction spending the coins of `tx`: the same payment to someone else
  async function conflictOf(keyId: string, tx: Awaited<ReturnType<typeof prepare>>) {
    const intent = { ...tx.intent, to: (await wallet()).address };
    const unsigned = await adapter.buildTransfer(intent, tx.reservation, tx.fee);
    return adapter.attachSignatures(unsigned, await sign(keyId, unsigned));
  }

  interface Decoded {
    vin: { txid: string; vout: number; sequence: number }[];
    vout: { value: number; n: number; scriptPubKey: { address?: string } }[];
  }
  const decode = (raw: string) => devnet.rpc.call<Decoded>('decoderawtransaction', [raw]);
  const pooledFee = async (txid: string) => {
    const entry = await devnet.rpc.call<{ vsize: number; fees: { base: number } }>(
      'getmempoolentry',
      [txid],
    );
    return { vsize: BigInt(entry.vsize), fee: btcToSats(entry.fees.base) };
  };

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

  it('B4 re-broadcast of a mined transaction whose outputs are spent is already_known, a real double spend is rejected', async () => {
    // 1 input at 2 sat/vB: a fee of 282 sat leaves no change, so the payment is the only output
    const from = await walletWith(100_000n);
    const mid = await wallet();
    const a = await prepare(from, mid.address, 100_000n - 282n);
    expect(await outputs(a.signed.raw)).toEqual([mid.address]);
    expect(await adapter.broadcast(a.signed)).toEqual({ outcome: 'accepted' });
    await devnet.mine(1);
    const b = await prepare(mid, (await wallet()).address, 50_000n);
    expect(await adapter.broadcast(b.signed)).toEqual({ outcome: 'accepted' });
    await devnet.mine(1);

    // every output of `a` is spent: the node answers its bytes as it answers a double spend
    expect(await devnet.rpc.call('gettxout', [a.signed.txid, 0])).toBeNull();
    await expect(devnet.rpc.call('sendrawtransaction', [a.signed.raw])).rejects.toThrow(
      /bad-txns-inputs-missingorspent/,
    );
    expect(await adapter.broadcast(a.signed)).toEqual({ outcome: 'already_known' });
    expect(await adapter.broadcast(await conflictOf(from.keyId, a))).toEqual({
      outcome: 'rejected',
      reason: expect.stringMatching(/bad-txns-inputs-missingorspent/) as string,
    });
  });

  it('B5 a reorged-out and conflicted transaction is unknown, never confirmed with 0 confirmations', async () => {
    const from = await walletWith(100_000n);
    const a = await prepare(from, (await wallet()).address, 50_000n);
    expect(await adapter.broadcast(a.signed)).toEqual({ outcome: 'accepted' });
    await devnet.mine(1);
    const first = await adapter.getTxStatus(a.signed.txid);
    if (first.state !== 'confirmed') throw new Error(`${a.signed.txid} is ${first.state}`);

    await devnet.rpc.call('invalidateblock', [first.block.hash]);
    expect(await adapter.getTxStatus(a.signed.txid)).toEqual({ state: 'pending' });
    // the new block at that height spends the same coin to someone else
    const conflict = await conflictOf(from.keyId, a);
    await devnet.rpc.call('generateblock', [(await wallet()).address, [conflict.raw]]);

    // the transaction index still serves `a`, with the block it left and 0 confirmations
    const raw = await devnet.rpc.call('getrawtransaction', [a.signed.txid, true]);
    expect(raw).toMatchObject({ blockhash: first.block.hash, confirmations: 0 });
    expect(await adapter.getTxStatus(a.signed.txid)).toEqual({ state: 'unknown' });
    expect(await adapter.getTxStatus(conflict.txid)).toMatchObject({
      state: 'confirmed',
      confirmations: 1,
    });
  });

  it('B6 buildReplacement throws when the coins cannot pay the bumped fee', async () => {
    const from = await wallet();
    const to = (await wallet()).address;
    // An invented coin of 100,000 sat (no chain needed). 1 input, 2 outputs: 141 vB, so the
    // fee is 282 sat at 2 sat/vB and 423 sat at 3 sat/vB, the first bump.
    const reservation: Json = { coins: [{ id: `${'cd'.repeat(32)}:0`, amount: '100000' }] };
    const fee: Json = { feeRate: '2' };
    const replace = async (change: bigint) => {
      const intent = { from: from.address, to, asset: 'native', amount: 100_000n - 282n - change };
      const unsigned = await adapter.buildTransfer(intent, reservation, fee);
      return adapter.buildReplacement(intent, reservation, { unsigned, fee });
    };
    // 100 sat of change: 41 sat short of the bumped fee
    await expect(replace(100n)).rejects.toThrow(
      /cannot afford replacement at 3 sat\/vB: the coins hold 100000 sat/,
    );
    // 293 sat of change went to the fee already. The bump fits in it, but the rest is folded
    // again: the same transaction, which pays no more.
    await expect(replace(293n)).rejects.toThrow(
      /cannot afford replacement at 3 sat\/vB: no change left/,
    );
    // 294 sat of change is kept at 2 sat/vB; at 3 sat/vB the 153 sat left is folded
    expect((await replace(294n))?.fee).toEqual({ feeRate: '3' });
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

  it('B8 a replacement pays at least 1 sat/vB more and the original is no longer known after it is accepted', async () => {
    // two coins, so that the order of the inputs matters
    const from = await walletWith(60_000n, 50_000n);
    const to = (await wallet()).address;
    const a = await prepare(from, to, 100_000n);
    expect(await adapter.broadcast(a.signed)).toEqual({ outcome: 'accepted' });
    let previous = { unsigned: a.unsigned, fee: a.fee, signed: a.signed };
    const attempts = [a.signed];
    let paid = await pooledFee(a.signed.txid);
    // a replacement of the replacement too: 2 sat/vB, then 3, then 4
    for (const feeRate of ['3', '4']) {
      const rep = await adapter.buildReplacement(a.intent, a.reservation, previous);
      if (!rep) throw new Error('a Bitcoin replacement is never null');
      expect(rep.fee).toEqual({ feeRate });
      const signed = adapter.attachSignatures(rep.unsigned, await sign(from.keyId, rep.unsigned));
      expect(await adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });

      // the same coins in the same order, the same payment, less change
      const [before, after] = await Promise.all([decode(previous.signed.raw), decode(signed.raw)]);
      const coins = (tx: Decoded) => tx.vin.map((i) => `${i.txid}:${i.vout}:${i.sequence}`);
      expect(coins(after)).toEqual(coins(before));
      expect(after.vout[0]).toEqual(before.vout[0]);
      expect(after.vout[1]!.value).toBeLessThan(before.vout[1]!.value);
      // at least 1 sat more per vbyte of the replacement, more than BIP-125's 0.1
      const now = await pooledFee(signed.txid);
      expect(now.fee - paid.fee).toBeGreaterThanOrEqual(now.vsize);

      expect(await adapter.getTxStatus(previous.signed.txid)).toEqual({ state: 'unknown' });
      expect(await adapter.getTxStatus(signed.txid)).toEqual({ state: 'pending' });
      previous = { ...rep, signed };
      attempts.push(signed);
      paid = now;
    }
    // the node keeps the replacement and refuses the original, which pays less
    expect(await adapter.broadcast(a.signed)).toEqual({
      outcome: 'rejected',
      reason: expect.stringMatching(/insufficient fee/) as string,
    });
    await devnet.mine(1);
    const states = await Promise.all(
      attempts.map(async (t) => (await adapter.getTxStatus(t.txid)).state),
    );
    expect(states).toEqual(['unknown', 'unknown', 'confirmed']);
    expect(await adapter.getBalance(to, 'native')).toBe(100_000n);
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

  it('B12 scanBlock lists every output that pays an address: payment, change, coinbase', async () => {
    const from = await walletWith(100_000n);
    const to = (await wallet()).address;
    const a = await prepare(from, to, 50_000n);
    expect(await adapter.broadcast(a.signed)).toEqual({ outcome: 'accepted' });
    await devnet.mine(1);
    const tip = await adapter.getTip();
    const { transfers } = await adapter.scanBlock(tip.height);

    const { txid } = a.signed;
    expect(transfers.filter((t) => t.txid === txid)).toEqual([
      { txid, index: 0, to, asset: 'native', amount: 50_000n },
      { txid, index: 1, to: from.address, asset: 'native', amount: 100_000n - 50_000n - 282n },
    ]);
    // the coinbase pays the miner in output 0; output 1, the witness commitment, pays no address
    const block = await devnet.rpc.call<{ tx: ({ txid: string } & Decoded)[] }>('getblock', [
      tip.hash,
      2,
    ]);
    const coinbase = block.tx[0]!;
    expect(coinbase.vout[1]?.scriptPubKey.address).toBeUndefined();
    expect(transfers.filter((t) => t.txid === coinbase.txid)).toEqual([
      {
        txid: coinbase.txid,
        index: 0,
        to: coinbase.vout[0]!.scriptPubKey.address,
        asset: 'native',
        amount: btcToSats(coinbase.vout[0]!.value),
      },
    ]);
    await expect(adapter.scanBlock(tip.height + 1)).rejects.toThrow(/Block height out of range/);
  });

  it('B13 buildReplacement refuses an intent or reservation that differs from the previous attempt', async () => {
    const from = await wallet();
    const other = (await wallet()).address;
    // invented coins (no chain needed); the replacement is built from the previous attempt
    const coins = [
      { id: `${'ef'.repeat(32)}:1`, amount: '60000' },
      { id: `${'ab'.repeat(32)}:0`, amount: '50000' },
    ];
    const intent = {
      from: from.address,
      to: (await wallet()).address,
      asset: 'native',
      amount: 100_000n,
    };
    const fee: Json = { feeRate: '2' };
    const previous = { unsigned: await adapter.buildTransfer(intent, { coins }, fee), fee };
    const replace = (i: typeof intent, c: typeof coins) =>
      adapter.buildReplacement(i, { coins: c }, previous);
    await expect(replace(intent, coins)).resolves.toMatchObject({ fee: { feeRate: '3' } });

    const intents = [
      { ...intent, to: other },
      { ...intent, from: other },
      { ...intent, asset: 'token' },
      { ...intent, amount: 99_999n },
    ];
    for (const i of intents) {
      const field = Object.keys(i).find(
        (k) => i[k as keyof typeof i] !== intent[k as keyof typeof i],
      );
      await expect(replace(i, coins)).rejects.toThrow(
        `the ${field} differs from the previous attempt`,
      );
    }
    const reservations = [
      [...coins].reverse(), // the same coins in another order
      coins.slice(0, 1),
      [...coins, { id: `${'cd'.repeat(32)}:2`, amount: '1000' }],
      [coins[0]!, { ...coins[1]!, amount: '50001' }],
      [coins[0]!, { ...coins[1]!, id: `${'ab'.repeat(32)}:1` }],
    ];
    for (const c of reservations)
      await expect(replace(intent, c)).rejects.toThrow('the reservation differs from the previous');
  });

  it('B14 a replacement that folds its change into the fee is accepted and confirms alone', async () => {
    // 1 input: 294 sat of change at 2 sat/vB is kept (the smallest relayed); the first bump to
    // 3 sat/vB leaves 153 sat, which go to the fee: 282 + 294 = 576 sat in all
    const from = await walletWith(100_000n);
    const to = (await wallet()).address;
    const a = await prepare(from, to, 100_000n - 282n - 294n);
    expect(await outputs(a.signed.raw)).toEqual([to, from.address]);
    expect(await adapter.broadcast(a.signed)).toEqual({ outcome: 'accepted' });
    const rep = await adapter.buildReplacement(a.intent, a.reservation, a);
    if (!rep) throw new Error('a Bitcoin replacement is never null');
    const signed = adapter.attachSignatures(rep.unsigned, await sign(from.keyId, rep.unsigned));
    expect(await outputs(signed.raw)).toEqual([to]);
    expect(await adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });
    expect((await pooledFee(signed.txid)).fee).toBe(576n);
    expect(await adapter.getTxStatus(a.signed.txid)).toEqual({ state: 'unknown' });

    await devnet.mine(1);
    expect(await adapter.getTxStatus(signed.txid)).toMatchObject({
      state: 'confirmed',
      feePaid: 576n,
    });
    expect(await adapter.getTxStatus(a.signed.txid)).toEqual({ state: 'unknown' });
    expect(await adapter.getBalance(to, 'native')).toBe(a.intent.amount);
    expect(await adapter.getBalance(from.address, 'native')).toBe(0n);
  });
});
