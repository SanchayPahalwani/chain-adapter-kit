import { config } from '../src/config.js';
import { connect, migrate } from '../src/pipeline/db.js';

const db = connect(config.databaseUrl, process.env.DB_SCHEMA);
try {
  await migrate(db);
  console.log('migrations applied');
} finally {
  await db.end();
}
