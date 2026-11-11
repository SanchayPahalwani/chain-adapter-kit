/* eslint-disable @typescript-eslint/require-await -- fake devnet methods have nothing to await */
import { describe, expect, it } from 'vitest';
import { startMiner, type Devnet } from '../src/conformance/harness.js';

function fakeDevnet(mine: () => Promise<void>): Devnet {
  return {
    mine,
    fund: async () => {},
    dropFromMempool: async () => {},
    reorg: async () => {},
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('startMiner', () => {
  it('mines repeatedly until stopped, and stop() does not wait out the sleep', async () => {
    let blocks = 0;
    const stop = startMiner(
      fakeDevnet(async () => void blocks++),
      10,
    );
    await sleep(100);
    await stop();
    const mined = blocks;
    expect(mined).toBeGreaterThan(2);
    await sleep(50);
    expect(blocks).toBe(mined);

    const slow = startMiner(
      fakeDevnet(async () => {}),
      60_000,
    );
    const started = performance.now();
    await slow();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('stops mining after a failed mine and rethrows the error from stop()', async () => {
    let calls = 0;
    const stop = startMiner(
      fakeDevnet(async () => {
        calls++;
        throw new Error('node down');
      }),
      5,
    );
    await sleep(60);
    expect(calls).toBe(1);
    await expect(stop()).rejects.toThrow('node down');
  });
});
