import { describe, expect, it } from 'vitest';
import type { Coin } from '../src/core/adapter.js';
import { MemoryInputStore } from '../src/core/memory-input-store.js';

const coin = (id: string): Coin => ({ id, owner: 'alice', amount: 1n, data: null });

describe('MemoryInputStore', () => {
  it('nextSequence returns the seeded value then counts up', async () => {
    const store = new MemoryInputStore();
    await store.seedSequence('n', 7n);
    expect([
      await store.nextSequence('n'),
      await store.nextSequence('n'),
      await store.nextSequence('n'),
    ]).toEqual([7n, 8n, 9n]);
  });

  it('seedSequence never moves an existing counter', async () => {
    const store = new MemoryInputStore();
    await store.seedSequence('n', 7n);
    await store.nextSequence('n');
    await store.seedSequence('n', 100n);
    expect(await store.nextSequence('n')).toBe(8n);
  });

  it('nextSequence throws for a key that was never seeded', async () => {
    await expect(new MemoryInputStore().nextSequence('missing')).rejects.toThrow(/never seeded/);
  });

  it('putCoins inserts once; freeCoins excludes reserved coins', async () => {
    const store = new MemoryInputStore();
    await store.putCoins([coin('a'), coin('b')]);
    await store.reserveCoins(['a']);
    await store.putCoins([coin('a')]);
    expect((await store.freeCoins('alice')).map((c) => c.id)).toEqual(['b']);
  });

  it('reserveCoins throws if a coin is missing or already reserved', async () => {
    const store = new MemoryInputStore();
    await store.putCoins([coin('a')]);
    await expect(store.reserveCoins(['nope'])).rejects.toThrow(/does not exist/);
    await store.reserveCoins(['a']);
    await expect(store.reserveCoins(['a'])).rejects.toThrow(/already reserved/);
  });

  it('a failed reservation reserves nothing', async () => {
    const store = new MemoryInputStore();
    await store.putCoins([coin('a'), coin('b')]);
    await expect(store.reserveCoins(['a', 'nope'])).rejects.toThrow(/does not exist/);
    expect((await store.freeCoins('alice')).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('reserveCoins rejects a duplicate id and leaves the coin free', async () => {
    const store = new MemoryInputStore();
    await store.putCoins([coin('a')]);
    await expect(store.reserveCoins(['a', 'a'])).rejects.toThrow(/duplicate coin id a /);
    expect((await store.freeCoins('alice')).map((c) => c.id)).toEqual(['a']);
  });
});
