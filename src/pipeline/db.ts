import { readdir } from 'node:fs/promises';
import postgres from 'postgres';

export type Db = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type Queryable = Db | Tx;

const migrationsDir = new URL('../../migrations/', import.meta.url);

// numeric(78,0) is the only numeric type in the schema, so every numeric becomes a bigint.
const numericAsBigint = {
  to: 1700,
  from: [1700],
  serialize: (x: bigint) => x.toString(),
  parse: (x: string) => BigInt(x),
};

export function connect(url: string, schema?: string): Db {
  return postgres(url, {
    types: { numeric: numericAsBigint },
    connection: schema ? { search_path: schema } : {},
  });
}

export async function migrate(db: Db): Promise<void> {
  await db.begin(async (tx) => {
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    // one migrator at a time; the lock is released at commit
    await tx`select pg_advisory_xact_lock(hashtext(current_schema()))`;
    const names = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const name of names) {
      const done = await tx`select 1 from schema_migrations where name = ${name}`;
      if (done.length > 0) continue;
      await tx.file(new URL(name, migrationsDir).pathname);
      await tx`insert into schema_migrations (name) values (${name})`;
    }
  });
}
