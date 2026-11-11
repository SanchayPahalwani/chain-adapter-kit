import { randomBytes } from 'node:crypto';
import { config } from '../../src/config.js';
import { connect, migrate, type Db } from '../../src/pipeline/db.js';

// One schema per call, so test files never see each other's rows.
export async function createTestDb(): Promise<{ db: Db; schema: string; close(): Promise<void> }> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = connect(config.databaseUrl);
  const db = connect(config.databaseUrl, schema);
  async function drop(): Promise<void> {
    try {
      await db.end({ timeout: 5 }); // a test that timed out may leave a transaction open
      await admin`drop schema if exists ${admin(schema)} cascade`;
    } finally {
      await admin.end();
    }
  }
  try {
    await admin`create schema ${admin(schema)}`;
    await migrate(db);
  } catch (e) {
    await drop().catch(() => undefined);
    throw e;
  }
  return { db, schema, close: drop };
}
