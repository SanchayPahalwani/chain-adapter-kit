import { randomBytes } from 'node:crypto';
import { config } from '../../src/config.js';
import { connect, migrate, type Db } from '../../src/pipeline/db.js';

// One schema per call, so test files never see each other's rows.
export async function createTestDb(): Promise<{ db: Db; schema: string; close(): Promise<void> }> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = connect(config.databaseUrl);
  const db = connect(config.databaseUrl, schema);
  try {
    await admin.unsafe(`create schema ${schema}`);
    await migrate(db);
  } catch (e) {
    await db.end();
    await admin.unsafe(`drop schema if exists ${schema} cascade`);
    await admin.end();
    throw e;
  }
  return {
    db,
    schema,
    async close() {
      try {
        await db.end();
        await admin.unsafe(`drop schema if exists ${schema} cascade`);
      } finally {
        await admin.end();
      }
    },
  };
}
