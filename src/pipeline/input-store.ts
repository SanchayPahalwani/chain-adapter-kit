import type { Coin, InputStore } from '../core/adapter.js';
import type { Queryable } from './db.js';

// reserveCoins is one statement, so it is atomic on a pool as well as in a transaction.
// nextSequence and freeCoins need db.begin: a sequence number comes back only if the
// transaction rolls back, and freeCoins' row locks last only as long as the transaction.
// seedSequence and putCoins are fine on a pool.
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

    // One statement: the rows are locked first, and nothing is updated unless all ids matched.
    // Duplicate ids collapse to one row, so the count check rejects them too.
    async reserveCoins(ids) {
      const rows = await sql`
        with wanted as (
          select id from chain_coins
          where id = any(${ids}) and reserved_by is null
          for update)
        update chain_coins set reserved_by = ${holder}
        where id in (select id from wanted)
          and (select count(*) from wanted) = ${ids.length}`;
      if (rows.count !== ids.length) {
        throw new Error(
          `could not reserve all of ${ids.join(', ')}: missing, duplicate or already reserved`,
        );
      }
    },
  };
}
