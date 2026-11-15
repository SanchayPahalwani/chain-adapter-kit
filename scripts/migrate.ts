// Applies the migrations to the schema KIT_DB_SCHEMA names, or to the database's default schema.
// The schema must exist: one named by mistake fails here rather than starting out empty.
import { config } from '../src/config.js';
import { connect, migrate } from '../src/pipeline/db.js';
import { dbSchema } from '../src/pipeline/runtime.js';

let schema: string | undefined;
try {
  schema = dbSchema(process.env);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
const db = connect(config.databaseUrl, schema);
try {
  // null when the search path names no schema that exists
  const [row] = await db<{ name: string | null }[]>`select current_schema() as name`;
  if (!row?.name) {
    console.error(`schema ${schema ?? '(default)'} does not exist`);
    process.exitCode = 1;
  } else {
    await migrate(db);
    console.log(`migrations applied to schema ${row.name}`);
  }
} finally {
  await db.end();
}
