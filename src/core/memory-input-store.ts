/* eslint-disable @typescript-eslint/require-await -- the interface is async; this implementation has nothing to await */
import type { Coin, InputStore } from './adapter.js';

// Plain in-memory InputStore for the conformance suite. No locking: one caller at a time.
export class MemoryInputStore implements InputStore {
  private sequences = new Map<string, bigint>();
  private coins = new Map<string, { coin: Coin; reserved: boolean }>();

  async seedSequence(key: string, value: bigint): Promise<void> {
    if (!this.sequences.has(key)) this.sequences.set(key, value);
  }

  async nextSequence(key: string): Promise<bigint> {
    const value = this.sequences.get(key);
    if (value === undefined) throw new Error(`sequence ${key} was never seeded`);
    this.sequences.set(key, value + 1n);
    return value;
  }

  async putCoins(coins: Coin[]): Promise<void> {
    for (const coin of coins) {
      if (!this.coins.has(coin.id)) this.coins.set(coin.id, { coin, reserved: false });
    }
  }

  async freeCoins(owner: string): Promise<Coin[]> {
    return [...this.coins.values()]
      .filter((entry) => entry.coin.owner === owner && !entry.reserved)
      .map((entry) => entry.coin);
  }

  async reserveCoins(ids: string[]): Promise<void> {
    // check all first so a failed call reserves nothing
    if (new Set(ids).size !== ids.length) throw new Error('duplicate coin id in reservation');
    const entries = ids.map((id) => {
      const entry = this.coins.get(id);
      if (!entry) throw new Error(`coin ${id} does not exist`);
      if (entry.reserved) throw new Error(`coin ${id} is already reserved`);
      return entry;
    });
    for (const entry of entries) entry.reserved = true;
  }
}
