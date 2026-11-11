import { bytesToHex } from 'viem';
import { createEvmAdapter } from '../src/adapters/evm/adapter.js';
import { createEvmDevnet } from '../src/adapters/evm/devnet.js';
import { config } from '../src/config.js';
import { runConformanceSuite } from '../src/conformance/suite.js';
import { LocalSigner } from '../src/core/local-signer.js';

runConformanceSuite('evm-anvil', async () => {
  const devnet = await createEvmDevnet(config.evmRpcUrl);
  const token = await devnet.deployTestToken();
  const adapter = await createEvmAdapter({ rpcUrl: config.evmRpcUrl, tokens: [token] });
  return {
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
    unknownTxid: () => bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    replacement: 'conflict',
  };
});
