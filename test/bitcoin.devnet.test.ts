// The Bitcoin regtest node and its devnet controls. Needs `docker compose up -d --wait bitcoind`.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { OutScript, SigHash, Transaction, p2wpkh } from '@scure/btc-signer';
import { hash160 } from '@scure/btc-signer/utils.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { RpcError, bitcoinRpc, btcToSats } from '../src/adapters/bitcoin/rpc.js';
import { createBitcoinDevnet, type BitcoinDevnet } from '../src/adapters/bitcoin/devnet.js';
import { config } from '../src/config.js';
import { LocalSigner } from '../src/core/local-signer.js';

const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

interface Unspent {
  txid: string;
  vout: number;
  amount: number;
  scriptPubKey: string;
}

let devnet: BitcoinDevnet;
beforeAll(async () => {
  devnet = await createBitcoinDevnet(config.bitcoinRpcUrl, config.bitcoinRpcAuth);
});

// A fresh test key (the node never sees it) and its P2WPKH address.
async function newKey() {
  const signer = LocalSigner.random();
  const pub = await signer.publicKey('k', 'secp256k1');
  return { signer, address: p2wpkh(pub, REGTEST).address };
}

async function coins(address: string) {
  const scan = await devnet.rpc.call<{ unspents: Unspent[] }>('scantxoutset', [
    'start',
    [`addr(${address})`],
  ]);
  return scan.unspents;
}

interface Coin {
  txid: string;
  vout: number;
  amount: bigint;
  script: Uint8Array;
}

// Spends `coin` (owned by the key) to `to` for `fee` sat, signed with the key. One input and
// one output: 110 vB, so the default 400 sat is about 3.6 sat/vB.
async function signSpend(
  key: Awaited<ReturnType<typeof newKey>>,
  coin: Coin,
  to: string,
  fee = 400n,
) {
  const tx = new Transaction({ version: 2, lockTime: 0 });
  tx.addInput({
    txid: hexToBytes(coin.txid),
    index: coin.vout,
    sequence: 0xfffffffd,
    witnessUtxo: { script: coin.script, amount: coin.amount },
  });
  const out = coin.amount - fee;
  tx.addOutputAddress(to, out, REGTEST);
  const program = OutScript.decode(coin.script);
  if (program.type !== 'wpkh') throw new Error('expected a P2WPKH coin');
  const scriptCode = OutScript.encode({ type: 'pkh', hash: program.hash });
  const digest = tx.preimageWitnessV0(0, scriptCode, SigHash.ALL, coin.amount); // the 32-byte digest
  const sig65 = await key.signer.sign('k', 'secp256k1', digest); // r || s || recovery id
  const sig = secp256k1.Signature.fromBytes(sig65.subarray(0, 64), 'compact');
  const pub = await key.signer.publicKey('k', 'secp256k1');
  if (bytesToHex(hash160(pub)) !== bytesToHex(program.hash)) throw new Error('wrong key');
  tx.updateInput(0, { partialSig: [[pub, Uint8Array.of(...sig.toBytes('der'), SigHash.ALL)]] });
  tx.finalize();
  return { raw: bytesToHex(tx.extract()), txid: tx.id, out };
}

// Spends the address's one confirmed coin.
async function spendFrom(key: Awaited<ReturnType<typeof newKey>>, to: string, fee?: bigint) {
  const [coin] = await coins(key.address);
  if (!coin) throw new Error(`no coin at ${key.address}`);
  return signSpend(
    key,
    {
      txid: coin.txid,
      vout: coin.vout,
      amount: btcToSats(coin.amount),
      script: hexToBytes(coin.scriptPubKey),
    },
    to,
    fee,
  );
}

const height = () => devnet.rpc.call<number>('getblockcount');
const inMempool = (txid: string) =>
  devnet.rpc
    .call('getmempoolentry', [txid])
    .then(() => true)
    .catch((error: unknown) => {
      if (error instanceof RpcError && error.code === -5) return false;
      throw error;
    });

describe('bitcoin devnet', () => {
  it('D1 the node is regtest and answers', async () => {
    const info = await devnet.rpc.call<{ chain: string }>('getblockchaininfo');
    expect(info.chain).toBe('regtest');
  });

  it('D2 fund creates one confirmed coin of exactly the amount at the address', async () => {
    const { address } = await newKey();
    await devnet.fund(address, 'native', 123_457n);
    const found = await coins(address);
    expect(found).toHaveLength(1);
    expect(btcToSats(found[0]!.amount)).toBe(123_457n);
  });

  it('D2b fundMany pays each amount as a confirmed coin of its own, in one transaction and one block', async () => {
    const { address } = await newKey();
    const before = await height();
    const amounts = [10_000n, 20_000n, 20_000n, 30_001n];
    await devnet.fundMany(address, amounts);
    expect(await height()).toBe(before + 1);
    const found = await coins(address);
    expect(found.map((c) => btcToSats(c.amount)).sort((a, b) => Number(a - b))).toEqual(amounts);
    expect(new Set(found.map((c) => c.txid)).size).toBe(1);
  });

  it('D3 mine advances the height by n, twice in a row after an invalidateblock', async () => {
    const before = await height();
    await devnet.mine(2);
    expect(await height()).toBe(before + 2);
    const tip = await devnet.rpc.call<string>('getbestblockhash');
    await devnet.rpc.call('invalidateblock', [tip]);
    expect(await height()).toBe(before + 1);
    await devnet.mine(1);
    await devnet.mine(1);
    expect(await height()).toBe(before + 3);
  });

  it('D4 reorg(1) keeps the height, changes the tip hash, and puts the transaction back in the mempool', async () => {
    const key = await newKey();
    await devnet.fund(key.address, 'native', 100_000n);
    const { raw, txid } = await spendFrom(key, (await newKey()).address);
    await devnet.rpc.call('sendrawtransaction', [raw]);
    await devnet.mine(1);
    expect(await inMempool(txid)).toBe(false);
    const heightBefore = await height();
    const tipBefore = await devnet.rpc.call<string>('getbestblockhash');

    await devnet.reorg(1);

    expect(await height()).toBe(heightBefore);
    expect(await devnet.rpc.call<string>('getbestblockhash')).not.toBe(tipBefore);
    expect(await inMempool(txid)).toBe(true);
    await devnet.mine(1); // leave the pool empty for the next test
    expect(await inMempool(txid)).toBe(false);
  });

  it('D5 dropFromMempool removes a pending transaction and the node accepts the same bytes again', async () => {
    const key = await newKey();
    await devnet.fund(key.address, 'native', 100_000n);
    const { raw, txid } = await spendFrom(key, (await newKey()).address);
    await devnet.rpc.call('sendrawtransaction', [raw]);
    expect(await inMempool(txid)).toBe(true);

    await devnet.dropFromMempool(txid);

    expect(await inMempool(txid)).toBe(false);
    // the clock is back to normal: mining works and block times are sane
    const prev = await devnet.rpc.call<{ time: number }>('getblockheader', [
      await devnet.rpc.call<string>('getbestblockhash'),
    ]);
    const [hash] = await devnet.rpc.call<string[]>('generatetoaddress', [
      1,
      await devnet.rpc.call<string>('getnewaddress', [], 'funder'),
    ]);
    const block = await devnet.rpc.call<{ time: number }>('getblockheader', [hash]);
    expect(block.time - prev.time).toBeLessThan(600); // not 337 h later
    expect(await devnet.rpc.call<string>('sendrawtransaction', [raw])).toBe(txid);
    expect(await inMempool(txid)).toBe(true);
    await devnet.mine(1);
  });

  it('D5b dropping A also drops its child B, and leaves the unrelated C pending', async () => {
    const [k1, k2, k3, k4] = await Promise.all([newKey(), newKey(), newKey(), newKey()]);
    await devnet.fund(k1.address, 'native', 100_000n);
    await devnet.fund(k4.address, 'native', 100_000n);
    const a = await spendFrom(k1, k2.address);
    const b = await signSpend(
      k2,
      {
        txid: a.txid,
        vout: 0,
        amount: a.out,
        script: p2wpkh(await k2.signer.publicKey('k', 'secp256k1'), REGTEST).script,
      },
      k3.address,
    );
    const c = await spendFrom(k4, k3.address);
    for (const tx of [a, b, c]) await devnet.rpc.call('sendrawtransaction', [tx.raw]);

    await devnet.dropFromMempool(a.txid);

    expect(await inMempool(a.txid)).toBe(false);
    expect(await inMempool(b.txid)).toBe(false);
    expect(await inMempool(c.txid)).toBe(true);
    await devnet.mine(1);
  });

  it('D6 pendingFrom counts a pending spend from the address and 0 after mining', async () => {
    const key = await newKey();
    await devnet.fund(key.address, 'native', 100_000n);
    expect(await devnet.pendingFrom(key.address)).toBe(0);
    const { raw } = await spendFrom(key, (await newKey()).address);
    await devnet.rpc.call('sendrawtransaction', [raw]);
    expect(await devnet.pendingFrom(key.address)).toBe(1);
    await devnet.mine(1);
    expect(await devnet.pendingFrom(key.address)).toBe(0);
  });

  it('D7 RpcError carries the node code; a transport failure is not an RpcError', async () => {
    const error = await devnet.rpc
      .call('getrawtransaction', ['00'.repeat(32), true])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(-5);

    const down = bitcoinRpc('http://127.0.0.1:1', config.bitcoinRpcAuth);
    const failure = await down.call('getblockcount').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RpcError);
  });

  it('D8 mineAtLeast mines what pays the rate, and a child only once its parent is mined', async () => {
    const [k1, k2, k3, k4] = await Promise.all([newKey(), newKey(), newKey(), newKey()]);
    await devnet.fund(k1.address, 'native', 100_000n);
    await devnet.fund(k4.address, 'native', 100_000n);
    const low = await spendFrom(k1, k2.address, 220n); // 2 sat/vB
    const child = await signSpend(
      k2,
      {
        txid: low.txid,
        vout: 0,
        amount: low.out,
        script: p2wpkh(await k2.signer.publicKey('k', 'secp256k1'), REGTEST).script,
      },
      k3.address,
      2_000n, // well above the rate, but its parent is not
    );
    const high = await spendFrom(k4, k3.address); // 400 sat: about 3.6 sat/vB
    for (const tx of [low, child, high]) await devnet.rpc.call('sendrawtransaction', [tx.raw]);
    const before = await height();

    await devnet.mineAtLeast(1, 3n);

    expect(await height()).toBe(before + 1);
    expect(await inMempool(high.txid)).toBe(false);
    expect(await inMempool(low.txid)).toBe(true);
    expect(await inMempool(child.txid)).toBe(true);
    await devnet.mine(1);
    expect(await inMempool(low.txid)).toBe(false);
    expect(await inMempool(child.txid)).toBe(false);
  });
});
