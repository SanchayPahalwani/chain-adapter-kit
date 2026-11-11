import { randomUUID } from 'node:crypto';
import { hexToBytes } from '@noble/curves/utils.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  AssetId,
  InputStore,
  Json,
  SignedTx,
  TransferIntent,
  UnsignedTx,
} from '../core/adapter.js';
import { MemoryInputStore } from '../core/memory-input-store.js';
import type { ConformanceHarness } from './harness.js';

interface Wallet {
  keyId: string;
  address: string;
}

/**
 * The checks every adapter must pass, under `describe(name)`. The harness is built once,
 * in beforeAll, because building it talks to the devnet.
 */
export function runConformanceSuite(
  name: string,
  makeHarness: () => Promise<ConformanceHarness>,
): void {
  let h: ConformanceHarness;
  const native = (): AssetId => h.assets[0]!;

  async function newWallet(): Promise<Wallet> {
    const keyId = `conformance-${randomUUID()}`;
    const address = h.adapter.deriveAddress(await h.signer.publicKey(keyId, h.adapter.curve));
    return { keyId, address };
  }

  // A wallet holding 100 units of `asset`, plus native for fees when `asset` is a token.
  async function fundedWallet(asset: AssetId): Promise<Wallet> {
    const wallet = await newWallet();
    await h.devnet.fund(wallet.address, native(), 100n * h.unit(native()));
    if (asset !== native()) await h.devnet.fund(wallet.address, asset, 100n * h.unit(asset));
    return wallet;
  }

  async function prepare(
    from: Wallet,
    to: string,
    asset: AssetId,
    amount: bigint,
    store: InputStore,
  ) {
    const intent: TransferIntent = { from: from.address, to, asset, amount };
    const fee: Json = await h.adapter.quoteFee(intent);
    await h.adapter.syncInputs(store, from.address);
    const reservation = await h.adapter.reserveInputs(store, intent, fee);
    const unsigned: UnsignedTx = await h.adapter.buildTransfer(intent, reservation, fee);
    const { signed, signatures } = await sign(from, unsigned);
    return { signed, unsigned, signatures, fee, reservation, intent };
  }

  async function sign(from: Wallet, unsigned: UnsignedTx) {
    const signatures: Uint8Array[] = [];
    for (const payload of unsigned.signingPayloads) {
      signatures.push(await h.signer.sign(from.keyId, h.adapter.curve, hexToBytes(payload)));
    }
    const signed: SignedTx = h.adapter.attachSignatures(unsigned, signatures);
    return { signed, signatures };
  }

  // One transfer of one unit from a fresh funded wallet to a fresh wallet.
  async function transfer(asset: AssetId) {
    const from = await fundedWallet(asset);
    const to = (await newWallet()).address;
    const prepared = await prepare(from, to, asset, h.unit(asset), new MemoryInputStore());
    return { from, to, ...prepared };
  }

  async function confirmed(txid: string) {
    const status = await h.adapter.getTxStatus(txid);
    if (status.state !== 'confirmed') throw new Error(`${txid} is ${status.state}, not confirmed`);
    return status;
  }

  describe(name, () => {
    beforeAll(async () => {
      h = await makeHarness();
      // so the per-asset and per-address loops cannot pass by checking nothing
      expect(h.assets[0]).toBe('native');
      expect(h.invalidAddresses.length).toBeGreaterThan(0);
      await h.devnet.mine(1); // clear anything a previous run left in the mempool
    });

    it('C1 derives a deterministic, valid address', async () => {
      const pk = await h.signer.publicKey(`conformance-${randomUUID()}`, h.adapter.curve);
      const address = h.adapter.deriveAddress(pk);
      expect(h.adapter.deriveAddress(pk)).toBe(address);
      expect(h.adapter.validateAddress(address)).toBe(true);
    });

    it('C2 rejects malformed addresses', () => {
      for (const address of h.invalidAddresses) {
        expect(h.adapter.validateAddress(address), address).toBe(false);
      }
    });

    it('C3 getBalance reflects funding (every asset)', async () => {
      for (const asset of h.assets) {
        const { address } = await newWallet();
        expect(await h.adapter.getBalance(address, asset)).toBe(0n);
        await h.devnet.fund(address, asset, 100n * h.unit(asset));
        expect(await h.adapter.getBalance(address, asset)).toBe(100n * h.unit(asset));
      }
    });

    it('C4 a transfer built with quoteFee is included in the next block', async () => {
      const { signed } = await transfer(native());
      expect(await h.adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });
      await h.devnet.mine(1);
      expect((await h.adapter.getTxStatus(signed.txid)).state).toBe('confirmed');
    });

    it('C5 attachSignatures is pure', async () => {
      const { unsigned, signatures } = await transfer(native());
      for (const payload of unsigned.signingPayloads) expect(payload).toMatch(/^([0-9a-f]{2})+$/);
      const a = h.adapter.attachSignatures(unsigned, signatures);
      const b = h.adapter.attachSignatures(unsigned, signatures);
      expect(b).toEqual(a);
    });

    it('C6 the local txid is the one the chain reports; recipient gets exactly amount (every asset)', async () => {
      for (const asset of h.assets) {
        const { signed, to, intent } = await transfer(asset);
        expect(await h.adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });
        await h.devnet.mine(1);
        expect((await confirmed(signed.txid)).succeeded, asset).toBe(true);
        expect(await h.adapter.getBalance(to, asset), asset).toBe(intent.amount);
      }
    });

    it('C7 feePaid matches the sender native balance change', async () => {
      for (const asset of h.assets) {
        const { signed, from, intent } = await transfer(asset);
        const before = await h.adapter.getBalance(from.address, native());
        await h.adapter.broadcast(signed);
        await h.devnet.mine(1);
        const { feePaid } = await confirmed(signed.txid);
        const spent = before - (await h.adapter.getBalance(from.address, native()));
        expect(spent, asset).toBe(asset === native() ? intent.amount + feePaid : feePaid);
      }
    });

    it('C8 broadcasting the same bytes twice while pending is harmless', async () => {
      const { signed, to, intent } = await transfer(native());
      expect(await h.adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });
      expect(await h.adapter.broadcast(signed)).toEqual({ outcome: 'already_known' });
      await h.devnet.mine(1);
      expect(await h.adapter.getBalance(to, native())).toBe(intent.amount);
    });

    it('C9 broadcasting again after confirmation returns already_known', async () => {
      const { signed, to, intent } = await transfer(native());
      expect(await h.adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });
      await h.devnet.mine(1);
      expect(await h.adapter.broadcast(signed)).toEqual({ outcome: 'already_known' });
      await h.devnet.mine(1);
      expect(await h.adapter.getBalance(to, native())).toBe(intent.amount);
    });

    it('C10 status goes unknown -> pending -> confirmed with growing confirmations', async () => {
      const { signed } = await transfer(native());
      expect(await h.adapter.getTxStatus(h.unknownTxid())).toEqual({ state: 'unknown' });
      expect(await h.adapter.getTxStatus(signed.txid)).toEqual({ state: 'unknown' });

      await h.adapter.broadcast(signed);
      expect(await h.adapter.getTxStatus(signed.txid)).toEqual({ state: 'pending' });

      await h.devnet.mine(1);
      const first = await confirmed(signed.txid);
      expect(first.confirmations).toBe(1);
      expect(first.block.hash).toBe((await h.adapter.getTip()).hash);

      await h.devnet.mine(2);
      expect((await confirmed(signed.txid)).confirmations).toBe(3);
    });

    it('C11 a dropped transaction reports unknown and can be sent again', async () => {
      const { signed, to, intent } = await transfer(native());
      expect(await h.adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });
      await h.devnet.dropFromMempool(signed.txid);
      expect(await h.adapter.getTxStatus(signed.txid)).toEqual({ state: 'unknown' });
      expect(await h.adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });
      await h.devnet.mine(1);
      await confirmed(signed.txid);
      expect(await h.adapter.getBalance(to, native())).toBe(intent.amount);
    });

    it('C12 a reorged-out transaction is not confirmed, and confirms again in a different block', async () => {
      const { signed, to, intent } = await transfer(native());
      expect(await h.adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });
      await h.devnet.mine(1);
      const first = await confirmed(signed.txid);

      await h.devnet.reorg(1);
      expect((await h.adapter.getTip()).height).toBeGreaterThanOrEqual(first.block.height);
      expect((await h.adapter.getTxStatus(signed.txid)).state).not.toBe('confirmed');

      expect(['accepted', 'already_known']).toContain((await h.adapter.broadcast(signed)).outcome);
      await h.devnet.mine(1);
      expect((await confirmed(signed.txid)).block.hash).not.toBe(first.block.hash);
      expect(await h.adapter.getBalance(to, native())).toBe(intent.amount);
    });

    it('C13 two reservations from one store do not conflict', async () => {
      const from = await fundedWallet(native());
      const store = new MemoryInputStore();
      const a = await prepare(from, (await newWallet()).address, native(), h.unit(native()), store);
      const b = await prepare(from, (await newWallet()).address, native(), h.unit(native()), store);
      expect(await h.adapter.broadcast(a.signed)).toEqual({ outcome: 'accepted' });
      expect(await h.adapter.broadcast(b.signed)).toEqual({ outcome: 'accepted' });
      await h.devnet.mine(1);
      await confirmed(a.signed.txid);
      await confirmed(b.signed.txid);
    });

    // The 'after-expiry' form is added with the first chain that needs it.
    it('C14 an original and its replacement cannot both confirm', async ({ skip }) => {
      if (h.replacement !== 'conflict') skip();
      const { from, to, signed, unsigned, fee, reservation, intent } = await transfer(native());
      expect(await h.adapter.broadcast(signed)).toEqual({ outcome: 'accepted' });

      const replacement = await h.adapter.buildReplacement(intent, reservation, { unsigned, fee });
      if (!replacement) throw new Error('a conflict-rule adapter must return a replacement');
      const rep = (await sign(from, replacement.unsigned)).signed;
      expect(rep.txid).not.toBe(signed.txid);
      expect(await h.adapter.broadcast(rep)).toEqual({ outcome: 'accepted' });
      await h.devnet.mine(2);

      const states = [signed, rep].map((tx) => h.adapter.getTxStatus(tx.txid));
      const confirmedOnes = (await Promise.all(states)).filter((s) => s.state === 'confirmed');
      expect(confirmedOnes).toHaveLength(1);
      expect(await h.adapter.getBalance(to, native())).toBe(intent.amount);
    });

    it('C15 scanBlock reports incoming transfers, links hashes, and sees a reorg (every asset)', async () => {
      for (const asset of h.assets) {
        const { signed, to, intent } = await transfer(asset);
        expect(await h.adapter.broadcast(signed), asset).toEqual({ outcome: 'accepted' });
        await h.devnet.mine(1);
        const tip = await h.adapter.getTip();

        const scanned = await h.adapter.scanBlock(tip.height);
        expect(scanned.block.hash, asset).toBe(tip.hash);
        expect(scanned.transfers, asset).toContainEqual(
          expect.objectContaining({ to, asset, amount: intent.amount, txid: signed.txid }),
        );
        expect(scanned.parentHash, asset).toBe(
          (await h.adapter.scanBlock(tip.height - 1)).block.hash,
        );

        await h.devnet.reorg(1);
        await h.devnet.mine(1);
        const after = await h.adapter.scanBlock(tip.height);
        expect(after.block.hash, asset).not.toBe(tip.hash);
        expect(
          after.transfers.map((t) => t.txid),
          asset,
        ).not.toContain(signed.txid);
      }
    });
  });
}
