// ABI and bytecode of contracts/TestToken.sol, built by `make contracts`.
import type { Abi, Hex } from 'viem';
import artifact from '../../../contracts/TestToken.json' with { type: 'json' };

export const testTokenAbi = artifact.abi as Abi;
export const testTokenBytecode = artifact.bytecode as Hex;
