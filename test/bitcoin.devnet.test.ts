// The Bitcoin regtest node and its devnet controls. Needs `docker compose up -d --wait bitcoind`.
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
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

// Spends the address's one coin to `to` (fee 400 sat), signed with the signer's key.
async function spendFrom(key: Awaited<ReturnType<typeof newKey>>, to: string) {
  const [coin] = await coins(key.address);
  if (!coin) throw new Error(`no coin at ${key.address}`);
  const amount = btcToSats(coin.amount);
  const script = hex.decode(coin.scriptPubKey);
  const tx = new Transaction({ version: 2, lockTime: 0 });
  tx.addInput({
    txid: hex.decode(coin.txid),
    index: coin.vout,
    sequence: 0xfffffffd,
    witnessUtxo: { script, amount },
  });
  tx.addOutputAddress(to, amount - 400n, REGTEST);
  const program = OutScript.decode(script);
  if (program.type !== 'wpkh') throw new Error('expected a P2WPKH coin');
  const scriptCode = OutScript.encode({ type: 'pkh', hash: program.hash });
  const digest = tx.preimageWitnessV0(0, scriptCode, SigHash.ALL, amount); // the 32-byte digest
  const sig65 = await key.signer.sign('k', 'secp256k1', digest); // r || s || recovery id
  const sig = secp256k1.Signature.fromBytes(sig65.subarray(0, 64), 'compact');
  const pub = await key.signer.publicKey('k', 'secp256k1');
  if (hex.encode(hash160(pub)) !== hex.encode(program.hash)) throw new Error('wrong key');
  tx.updateInput(0, { partialSig: [[pub, Uint8Array.of(...sig.toBytes('der'), SigHash.ALL)]] });
  tx.finalize();
  return { raw: hex.encode(tx.extract()), txid: tx.id };
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
    const [hash] = await devnet.rpc.call<string[]>('generatetoaddress', [
      1,
      await devnet.rpc.call<string>('getnewaddress', [], 'funder'),
    ]);
    const block = await devnet.rpc.call<{ time: number }>('getblockheader', [hash]);
    expect(Math.abs(block.time - Date.now() / 1000)).toBeLessThan(600);
    expect(await devnet.rpc.call<string>('sendrawtransaction', [raw])).toBe(txid);
    expect(await inMempool(txid)).toBe(true);
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
});
