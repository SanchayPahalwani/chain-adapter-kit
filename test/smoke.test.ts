import { expect, it } from 'vitest';
import postgres from 'postgres';
import { createPublicClient, http } from 'viem';
import { config } from '../src/config.js';

it('postgres answers', async () => {
  const sql = postgres(config.databaseUrl);
  try {
    expect((await sql`select 1 as one`)[0]?.one).toBe(1);
  } finally {
    await sql.end();
  }
});

it('anvil is the local dev chain', async () => {
  const client = createPublicClient({ transport: http(config.evmRpcUrl) });
  expect(await client.getChainId()).toBe(31337);
});
