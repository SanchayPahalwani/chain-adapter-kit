import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createEvmAdapter } from '../src/adapters/evm/adapter.js';
import { createEvmDevnet } from '../src/adapters/evm/devnet.js';
import { config } from '../src/config.js';
import { runConformanceSuite } from '../src/conformance/suite.js';
import { LocalSigner } from '../src/core/local-signer.js';

runConformanceSuite(async () => {
  const devnet = await createEvmDevnet(config.evmRpcUrl);
  const token = await devnet.deployTestToken();
  const adapter = await createEvmAdapter({ rpcUrl: config.evmRpcUrl, tokens: [token] });
  return {
    name: 'evm-anvil',
    adapter,
    signer: LocalSigner.random(),
    devnet,
    assets: ['native', token],
    unit: (asset) => (asset === 'native' ? 10n ** 16n : 1000n),
    invalidAddresses: [
      '',
      '0x',
      '0x1234',
      '0x52908400098527886e0f7030069857d2e4169ee7', // valid bytes, lower-case: not canonical
      '0x52908400098527886E0F7030069857D2E4169Ee7', // bad checksum
      'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', // another chain's format
    ],
    replacement: 'conflict',
  };
});

describe('createEvmAdapter', () => {
  it('rejects a node whose chain id is not 31337', async () => {
    // a stub node that answers every JSON-RPC call with chain id 1 (mainnet)
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const { id } = JSON.parse(body) as { id: number };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x1' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(createEvmAdapter({ rpcUrl: `http://127.0.0.1:${port}` })).rejects.toThrow(
        /chain id 1\b/,
      );
    } finally {
      server.close();
    }
  });
});
