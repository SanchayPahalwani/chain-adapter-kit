import type { Coin, InputStore } from '../core/adapter.js';
import type { Queryable } from './db.js';

// `holder` is the id of the withdrawal that reserves coins.
export function pgInputStore(sql: Queryable, holder: string): InputStore {
  return {
    async seedSequence(key, value) {
      await sql`insert into chain_sequences (key, next) values (${key}, ${value}) on conflict (key) do nothing`;
    },

    // The update takes the row lock, so concurrent takers queue behind each other.
    // A rollback undoes the increment.
    async nextSequence(key) {
      const rows = await sql<{ taken: bigint }[]>`
        update chain_sequences set next = next + 1 where key = ${key} returning next - 1 as taken`;
      const row = rows[0];
      if (!row) throw new Error(`sequence ${key} was never seeded`);
      return row.taken;
    },

    async putCoins(coins) {
      for (const c of coins) {
        await sql`
          insert into chain_coins (id, owner, amount, data)
          values (${c.id}, ${c.owner}, ${c.amount}, ${sql.json(c.data)})
          on conflict (id) do nothing`;
      }
    },

    // skip locked: a coin another open transaction has selected is not offered to this one.
    async freeCoins(owner) {
      return sql<Coin[]>`
        select id, owner, amount, data from chain_coins
        where owner = ${owner} and reserved_by is null
        order by amount desc
        for update skip locked`;
    },

    async reserveCoins(ids) {
      const rows = await sql`
        update chain_coins set reserved_by = ${holder}
        where id = any(${ids}) and reserved_by is null`;
      if (rows.count !== ids.length) {
        throw new Error(`could not reserve all of ${ids.join(', ')}: missing or already reserved`);
      }
    },
  };
}
