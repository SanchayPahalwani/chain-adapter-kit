import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

export type Db = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type Queryable = Db | Tx;

const migrationsDir = new URL('../../migrations/', import.meta.url);

// numeric(78,0) is the only numeric type in the schema, so every numeric result becomes a bigint.
// A query must not return a fractional numeric (avg, extract(epoch ...)): cast it in SQL.
const numericAsBigint = {
  to: 1700,
  from: [1700],
  serialize: (x: bigint) => x.toString(),
  parse: (x: string) => BigInt(x),
};

export function connect(url: string, schema?: string): Db {
  return postgres(url, {
    types: { numeric: numericAsBigint },
    onnotice: () => {}, // "already exists, skipping" and "drop cascades" are expected
    connection: schema ? { search_path: schema } : {},
  });
}

export async function migrate(db: Db): Promise<void> {
  await db.begin(async (tx) => {
    // first statement: even create table if not exists races between two sessions
    await tx`select pg_advisory_xact_lock(hashtext(current_schema()))`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
    const names = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const name of names) {
      const done = await tx`select 1 from schema_migrations where name = ${name}`;
      if (done.length > 0) continue;
      await tx.file(fileURLToPath(new URL(name, migrationsDir)));
      await tx`insert into schema_migrations (name) values (${name})`;
    }
  });
}
