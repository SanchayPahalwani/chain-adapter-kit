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
    chain: foundry, // chain id 31337; viem refuses to send if the node reports another
    account,
    transport: http(rpcUrl),
    cacheTime: 0,
  })
    .extend(publicActions)
    .extend(walletActions);
  await client.getChainId(); // fail here, not mid-test, if the node is down

  // anvil runs with --no-mining, so every send is followed by a block; the next nonce is
  // re-read from the node each time rather than tracked here.
  const nextNonce = () =>
    client.getTransactionCount({ address: account.address, blockTag: 'pending' });
  async function mineAndCheck(hash: Hex) {
    await client.mine({ blocks: 1 });
    const receipt = await client.getTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`devnet transaction ${hash} reverted`);
    return receipt;
  }

  return {
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
