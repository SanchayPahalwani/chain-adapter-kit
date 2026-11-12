import type { AssetId } from '../../core/adapter.js';
import type { Devnet } from '../../conformance/harness.js';
import { RpcError, bitcoinRpc, type BitcoinRpc } from './rpc.js';

const FUNDER = 'funder';
const FEE_RATE = 2; // sat/vB for the funder's own payments
const EXPIRY_HOURS = 336; // bitcoind's default -mempoolexpiry

export interface BitcoinDevnet extends Devnet {
  rpc: BitcoinRpc;
}

interface MempoolEntry {
  time: number;
  ancestorcount: number;
  depends: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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

  // The node scans the UTXO set for one caller at a time; a parallel scan answers -8.
  async function scan(address: string) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        const r = await rpc.call<{ unspents: { txid: string; vout: number }[] }>('scantxoutset', [
          'start',
          [`addr(${address})`],
        ]);
        return r.unspents;
      } catch (error) {
        if (!(error instanceof RpcError && error.code === -8) || Date.now() > deadline) throw error;
        await sleep(50);
      }
    }
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

  const mine = async (blocks: number) => {
    await rpc.call('generatetoaddress', [blocks, await freshAddress()]);
  };

  return {
    rpc,

    // Not safe to call concurrently with itself: the funder picks its coins when it sends.
    async fund(address: string, asset: AssetId, amount: bigint) {
      if (asset !== 'native') throw new Error(`bitcoin has no asset "${asset}"`);
      // positional: address, amount, comment, comment_to, subtract_fee, replaceable, conf_target, mode, avoid_reuse, fee_rate
      await funder('sendtoaddress', [
        address,
        satsToBtc(amount),
        '',
        '',
        false,
        true,
        null,
        'unset',
        null,
        FEE_RATE,
      ]);
      await mine(1);
    },

    // A fresh address each time: after invalidateblock, a block with the same template as an
    // invalidated one is rejected as a duplicate.
    mine,

    // Replaces the last `depth` blocks with empty ones at the same heights. Their
    // transactions go back to the mempool, so they are pending, not confirmed.
    async reorg(depth: number) {
      const height = await rpc.call<number>('getblockcount');
      if (!Number.isInteger(depth) || depth < 1 || depth > height)
        throw new Error(`bad depth ${depth}`);
      await rpc.call('invalidateblock', [
        await rpc.call<string>('getblockhash', [height - depth + 1]),
      ]);
      for (let i = 0; i < depth; i++) await rpc.call('generateblock', [await freshAddress(), []]);
    },

    // No RPC removes a transaction, so this uses the mempool's 336 h expiry: move the node's
    // clock past it, submit one payment (expiry runs when a transaction is accepted), put the
    // clock back. That expires every transaction in the pool, so the others are put back
    // afterwards (a child of the dropped one cannot return, as on a real eviction). A transaction
    // paying a funder address would be resubmitted by the wallet, so tests send elsewhere.
    // Nothing is mined while the clock is moved: block times would be 337 h ahead.
    // A txid the node does not hold passes silently; a caller dropping "every attempt" includes
    // ones already replaced.
    async dropFromMempool(txid: string) {
      const pool = await mempool();
      if (!pool[txid]) return;
      const others = await Promise.all(
        Object.entries(pool)
          .filter(([id]) => id !== txid)
          .sort(([, a], [, b]) => a.ancestorcount - b.ancestorcount)
          .map(async ([id, entry]) => ({
            id,
            entry,
            raw: await rpc.call<string>('getrawtransaction', [id]),
          })),
      );
      const newest = Math.max(...Object.values(pool).map((e) => e.time));
      await rpc.call('setmocktime', [newest + (EXPIRY_HOURS + 1) * 3600]);
      try {
        await funder('sendtoaddress', [
          await freshAddress(),
          '0.0001',
          '',
          '',
          false,
          true,
          null,
          'unset',
          null,
          FEE_RATE,
        ]);
      } finally {
        await rpc.call('setmocktime', [0]);
      }
      const gone = new Set([txid]);
      for (const { id, entry, raw } of others) {
        if (entry.depends.some((parent) => gone.has(parent))) gone.add(id);
        else await rpc.call('sendrawtransaction', [raw]);
      }
      if (await inMempool(txid)) throw new Error(`${txid} is still in the mempool after the drop`);
    },

    // Confirmed coins of the address (scantxoutset sees no mempool outputs), then who spends
    // them in the mempool. A spend of an unconfirmed output of the address is not counted.
    async pendingFrom(address: string) {
      const coins = await scan(address);
      if (coins.length === 0) return 0;
      const spends = await rpc.call<{ spendingtxid?: string }[]>('gettxspendingprevout', [
        coins.map(({ txid, vout }) => ({ txid, vout })),
      ]);
      return new Set(spends.flatMap((s) => (s.spendingtxid ? [s.spendingtxid] : []))).size;
    },
  };
}
