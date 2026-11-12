import { secp256k1 } from '@noble/curves/secp256k1.js';
import { p2wpkh } from '@scure/btc-signer';
import type { AssetId } from '../../core/adapter.js';
import type { Devnet } from '../../conformance/harness.js';
import { REGTEST } from './adapter.js';
import { RpcError, bitcoinRpc, btcToSats, scanAddress, type BitcoinRpc } from './rpc.js';

const FUNDER = 'funder';
const ENOUGH = 100; // BTC; while the funder holds less, the blocks pay it
const FEE_RATE = 2; // sat/vB for the funder's own payments
const EXPIRY_HOURS = 336; // bitcoind's default -mempoolexpiry

export interface BitcoinDevnet extends Devnet {
  rpc: BitcoinRpc;
  // Mines `blocks` blocks that hold only the mempool transactions paying at least `satPerVb` by
  // the node's BIP-141 vsize (and only once their mempool parents are in); the rest stay pending.
  mineAtLeast(blocks: number, satPerVb: bigint): Promise<void>;
}

interface MempoolEntry {
  time: number;
  ancestorcount: number;
  depends: string[];
  vsize_bip141: number;
  fees: { base: number };
}

const satsToBtc = (sats: bigint) =>
  `${sats / 100_000_000n}.${(sats % 100_000_000n).toString().padStart(8, '0')}`;

export async function createBitcoinDevnet(
  url: string,
  auth: { user: string; password: string },
): Promise<BitcoinDevnet> {
  const rpc = bitcoinRpc(url, auth);
  // this helper mines and spends from a wallet, so it refuses anything but regtest
  const info = await rpc.call<{ chain: string }>('getblockchaininfo');
  if (info.chain !== 'regtest') {
    throw new Error(`refusing chain "${info.chain}": only regtest is allowed`);
  }

  const funder = <T>(method: string, params: unknown[] = []) => rpc.call<T>(method, params, FUNDER);
  const freshAddress = () => funder<string>('getnewaddress');
  // positional: address, amount, comment, comment_to, subtract_fee, replaceable, conf_target, mode, avoid_reuse, fee_rate
  const pay = (address: string, btc: string) =>
    funder('sendtoaddress', [address, btc, '', '', false, true, null, 'unset', null, FEE_RATE]);
  await rpc.call('setmocktime', [0]); // a killed run may have left the clock moved

  const loaded = await rpc.call<string[]>('listwallets');
  if (!loaded.includes(FUNDER)) {
    await rpc.call('loadwallet', [FUNDER]).catch(async (error: unknown) => {
      if (!(error instanceof RpcError && error.code === -18)) throw error; // -18: no such wallet
      await rpc.call('createwallet', [FUNDER]);
    });
  }
  if ((await funder<number>('getbalance')) < 50) {
    await rpc.call('generatetoaddress', [101, await freshAddress()]);
  }

  const mempool = () => rpc.call<Record<string, MempoolEntry>>('getrawmempool', [true]);
  const inMempool = (txid: string) =>
    rpc
      .call('getmempoolentry', [txid])
      .then(() => true)
      .catch((error: unknown) => {
        if (error instanceof RpcError && error.code === -5) return false; // not in mempool
        throw error;
      });

  // Every coin in the funder wallet makes each sendtoaddress slower, so once it holds enough, blocks
  // pay a key that is thrown away. A new address every time either way: after invalidateblock, a
  // block with the same template as an invalidated one is rejected as a duplicate.
  const minerAddress = async () =>
    (await funder<number>('getbalance')) < ENOUGH
      ? freshAddress()
      : p2wpkh(secp256k1.keygen().publicKey, REGTEST).address;

  const mine = async (blocks: number) => {
    await rpc.call('generatetoaddress', [blocks, await minerAddress()]);
  };

  return {
    rpc,

    // Not safe to call concurrently with itself: the funder picks its coins when it sends.
    async fund(address: string, asset: AssetId, amount: bigint) {
      if (asset !== 'native') throw new Error(`bitcoin has no asset "${asset}"`);
      await pay(address, satsToBtc(amount));
      await mine(1);
    },

    mine,

    async mineAtLeast(blocks: number, satPerVb: bigint) {
      for (let i = 0; i < blocks; i++) {
        // fewer ancestors first: parents before children, the order generateblock needs
        const pool = Object.entries(await mempool()).sort(
          ([, a], [, b]) => a.ancestorcount - b.ancestorcount,
        );
        const picked = new Set<string>();
        for (const [txid, e] of pool) {
          const pays = btcToSats(e.fees.base) >= satPerVb * BigInt(e.vsize_bip141);
          if (pays && e.depends.every((parent) => picked.has(parent))) picked.add(txid);
        }
        await rpc.call('generateblock', [await minerAddress(), [...picked]]);
      }
    },

    // Replaces the last `depth` blocks with empty ones at the same heights. Their
    // transactions go back to the mempool, so they are pending, not confirmed.
    async reorg(depth: number) {
      const height = await rpc.call<number>('getblockcount');
      if (!Number.isInteger(depth) || depth < 1 || depth > height)
        throw new Error(`bad depth ${depth}`);
      await rpc.call('invalidateblock', [
        await rpc.call<string>('getblockhash', [height - depth + 1]),
      ]);
      for (let i = 0; i < depth; i++) await rpc.call('generateblock', [await minerAddress(), []]);
    },

    // No RPC removes a transaction, so this uses the mempool's 336 h expiry: move the node's
    // clock past it, submit one payment (expiry runs when a transaction is accepted), put the
    // clock back. That expires every transaction in the pool, so the others are put back
    // afterwards (a child of the dropped one cannot return, as on a real eviction).
    // Caller rule: while this runs no other process may submit transactions and nothing may
    // mine (block times would be 337 h ahead); the fault run and the tests comply.
    // A transaction paying a funder address would be resubmitted by the wallet, so tests send
    // elsewhere. A txid the node does not hold passes silently (a caller dropping "every
    // attempt" includes ones already replaced); a mined one throws, as mined is not dropped.
    async dropFromMempool(txid: string) {
      const pool = await mempool();
      if (!pool[txid]) {
        const tx = await rpc
          .call<{ confirmations?: number }>('getrawtransaction', [txid, true])
          .catch((error: unknown) => {
            if (error instanceof RpcError && error.code === -5) return null;
            throw error;
          });
        if ((tx?.confirmations ?? 0) >= 1) throw new Error(`${txid} is mined, not pending`);
        return;
      }
      // Parents before children (fewer ancestors first), so they can be resubmitted in this order.
      const order = Object.entries(pool)
        .filter(([id]) => id !== txid)
        .sort(([, a], [, b]) => a.ancestorcount - b.ancestorcount);
      const others: { id: string; depends: string[]; raw: string }[] = [];
      for (const [id, entry] of order) {
        others.push({
          id,
          depends: entry.depends,
          raw: await rpc.call<string>('getrawtransaction', [id]),
        });
      }
      // Based on the newest entry, not on the host clock: the node's clock may differ from this
      // machine's, and every entry must be more than 336 h old at the mocked time.
      const newest = Math.max(...Object.values(pool).map((e) => e.time));
      await rpc.call('setmocktime', [newest + (EXPIRY_HOURS + 1) * 3600]);
      try {
        await pay(await freshAddress(), '0.0001');
      } finally {
        await rpc.call('setmocktime', [0]);
      }
      const gone = new Set([txid]);
      const failures: string[] = [];
      for (const { id, depends, raw } of others) {
        if (depends.some((parent) => gone.has(parent))) {
          gone.add(id);
          continue;
        }
        try {
          await rpc.call('sendrawtransaction', [raw]);
        } catch (error) {
          failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (await inMempool(txid)) throw new Error(`${txid} is still in the mempool after the drop`);
      if (failures.length > 0) {
        throw new Error(
          `could not put back ${failures.length} transaction(s): ${failures.join('; ')}`,
        );
      }
    },

    // Confirmed coins of the address (scantxoutset sees no mempool outputs), then who spends
    // them in the mempool. A spend of an unconfirmed output of the address is not counted.
    async pendingFrom(address: string) {
      const { unspents: coins } = await scanAddress(rpc, address);
      if (coins.length === 0) return 0;
      const spends = await rpc.call<{ spendingtxid?: string }[]>('gettxspendingprevout', [
        coins.map(({ txid, vout }) => ({ txid, vout })),
      ]);
      return new Set(spends.flatMap((s) => (s.spendingtxid ? [s.spendingtxid] : []))).size;
    },
  };
}
