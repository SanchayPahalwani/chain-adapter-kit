// Needs `docker compose up -d --wait bitcoind`.
import { bytesToHex } from '@noble/hashes/utils.js';
import { NETWORK, TEST_NETWORK, p2pkh, p2sh, p2tr, p2wpkh } from '@scure/btc-signer';
import { beforeEach } from 'vitest';
import { createBitcoinAdapter } from '../src/adapters/bitcoin/adapter.js';
import { createBitcoinDevnet } from '../src/adapters/bitcoin/devnet.js';
import { config } from '../src/config.js';
import { runConformanceSuite } from '../src/conformance/suite.js';
import { LocalSigner } from '../src/core/local-signer.js';

// regtest addresses: testnet's base58 prefixes, and bech32 prefix bcrt
const REGTEST = { ...TEST_NETWORK, bech32: 'bcrt' };

// Not implemented until the next task (buildReplacement, scanBlock). Delete this list then.
const notYet = ['C14', 'C15'];
beforeEach(({ task, skip }) => {
  if (notYet.some((check) => task.name.startsWith(`${check} `))) skip('not implemented yet');
});

runConformanceSuite('bitcoin-regtest', async () => {
  const devnet = await createBitcoinDevnet(config.bitcoinRpcUrl, config.bitcoinRpcAuth);
  const adapter = await createBitcoinAdapter({
    rpcUrl: config.bitcoinRpcUrl,
    auth: config.bitcoinRpcAuth,
  });
  // other encodings of one key: each is a valid address somewhere, none is regtest P2WPKH
  const pub = await LocalSigner.random().publicKey('other', 'secp256k1');
  const ours = p2wpkh(pub, REGTEST).address;
  return {
    adapter,
    signer: LocalSigner.random(),
    devnet,
    assets: ['native'],
    unit: () => 100_000n,
    invalidAddresses: [
      '',
      p2wpkh(pub, NETWORK).address, // mainnet bc1q
      p2wpkh(pub, TEST_NETWORK).address, // testnet tb1q
      p2tr(pub.subarray(1), undefined, REGTEST).address, // regtest taproot bcrt1p
      p2pkh(pub, REGTEST).address, // regtest legacy m.../n...
      p2sh(p2wpkh(pub, REGTEST), REGTEST).address, // regtest P2SH 2...
      ours.slice(0, -1) + (ours.endsWith('q') ? 'p' : 'q'), // bad checksum
      ours.slice(0, 8) + ours.slice(8).toUpperCase(), // mixed case: not bech32 at all
      ours.toUpperCase(), // valid bech32, but not the canonical lower-case form
      '0x52908400098527886E0F7030069857D2E4169EE7', // another chain's format
    ],
    unknownTxid: () => bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    replacement: 'conflict',
  };
});
