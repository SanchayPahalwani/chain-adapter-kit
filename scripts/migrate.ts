import { config } from '../src/config.js';
import { connect, migrate } from '../src/pipeline/db.js';

const db = connect(config.databaseUrl);
try {
  await migrate(db);
  console.log('migrations applied');
} finally {
  await db.end();
}
