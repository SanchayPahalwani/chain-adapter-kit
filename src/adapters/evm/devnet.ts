import {
  createTestClient,
  getAddress,
  http,
  publicActions,
  walletActions,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import type { AssetId } from '../../core/adapter.js';
import type { Devnet } from '../../conformance/harness.js';
import { testTokenAbi, testTokenBytecode } from './test-token.js';

// anvil's dev account 0. Its key is published with Foundry and printed by every anvil at
// start-up; it is used here only to deploy the test token and to mint it.
const DEV_ACCOUNT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export interface EvmDevnet extends Devnet {
  deployTestToken(): Promise<string>; // returns the contract address
  setNextBaseFee(wei: bigint): Promise<void>; // used by pipeline fault tests
}

export async function createEvmDevnet(rpcUrl: string): Promise<EvmDevnet> {
  const account = privateKeyToAccount(DEV_ACCOUNT_KEY);
  const client = createTestClient({
    mode: 'anvil',
    chain: foundry, // chain id 31337
    account,
    transport: http(rpcUrl),
    cacheTime: 0,
  })
    .extend(publicActions)
    .extend(walletActions);
  // this helper holds a key, so it refuses anything but a local anvil
  const chainId = await client.getChainId();
  if (chainId !== foundry.id) {
    throw new Error(`refusing chain id ${chainId}: only a local anvil (${foundry.id}) is allowed`);
  }

  // The nonce is read from the node before every send, with the `pending` tag: under
  // --no-mining a send from this account can still be in the pool (one an interrupted
  // earlier run left behind), and `latest` would hand out its nonce again. Passing it
  // explicitly also keeps viem from choosing a source of its own.
  const nextNonce = () =>
    client.getTransactionCount({ address: account.address, blockTag: 'pending' });
  async function mineAndCheck(hash: Hex) {
    await client.mine({ blocks: 1 });
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`devnet transaction ${hash} reverted`);
    return receipt;
  }

  return {
    // Not safe to call concurrently: two token mints would read the same nonce, and two
    // native top-ups would both add to the same starting balance.
    async fund(address: string, asset: AssetId, amount: bigint) {
      if (asset === 'native') {
        const current = await client.getBalance({ address: address as Address });
        await client.setBalance({ address: address as Address, value: current + amount });
        return;
      }
      const hash = await client.writeContract({
        address: asset as Address,
        abi: testTokenAbi,
        functionName: 'mint',
        args: [address, amount],
        nonce: await nextNonce(),
      });
      await mineAndCheck(hash);
    },

    async mine(blocks: number) {
      await client.mine({ blocks });
    },

    dropFromMempool(): Promise<void> {
      throw new Error('not implemented');
    },

    reorg(): Promise<void> {
      throw new Error('not implemented');
    },

    async deployTestToken() {
      const hash = await client.deployContract({
        abi: testTokenAbi,
        bytecode: testTokenBytecode,
        nonce: await nextNonce(),
      });
      const { contractAddress } = await mineAndCheck(hash);
      if (!contractAddress) throw new Error(`deploy ${hash} created no contract`);
      return getAddress(contractAddress); // the receipt's address is lower-case
    },

    async setNextBaseFee(wei: bigint) {
      await client.setNextBlockBaseFeePerGas({ baseFeePerGas: wei });
    },
  };
}
