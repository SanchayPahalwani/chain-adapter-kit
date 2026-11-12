import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { Address, OutScript, SigHash, Transaction, p2wpkh } from '@scure/btc-signer';
import { hash160 } from '@scure/btc-signer/utils.js';
import type { ChainAdapter, TxStatus, UnsignedTx } from '../../core/adapter.js';
import { RpcError, bitcoinRpc, btcToSats } from './rpc.js';

export interface BitcoinAdapterOptions {
  rpcUrl: string;
  auth: { user: string; password: string };
  finalityDepth?: number; // default 3
  feeRate?: bigint; // sat/vB, default 2
}

const chain = 'bitcoin-regtest';
const REGTEST = { bech32: 'bcrt', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
// Signals that the transaction may be replaced (BIP-125); Core 32 replaces any transaction anyway.
const SEQUENCE = 0xfffffffd;
// The smallest P2WPKH output the node relays (dust rate 3 sat/vB). Smaller change would get the
// whole transaction refused, so it goes to the fee instead.
const DUST = 294n;

// The opaque JSON values this adapter hands the pipeline. Every amount is a decimal string.
type Fee = { feeRate: string }; // sat/vB
type Reservation = { coins: { id: string; amount: string }[] }; // id is "<txid>:<vout>"
// The unsigned transaction, and what its digests commit to besides it: each input's amount, and
// its script, which is that of `from` (every input is a coin of the sender).
type Body = { tx: string; from: string; amounts: string[] };

interface Scan {
  success: boolean;
  total_amount: number;
  unspents: { txid: string; vout: number; amount: number }[];
}

// Only the lower-case form, which deriveAddress returns and the node reports, so that one address
// has one spelling when the kit compares addresses as strings.
function isP2wpkh(address: string): boolean {
  try {
    return Address(REGTEST).decode(address).type === 'wpkh' && address === address.toLowerCase();
  } catch {
    return false;
  }
}

function keyHash(address: string): Uint8Array {
  const decoded = Address(REGTEST).decode(address);
  if (decoded.type !== 'wpkh') throw new Error(`not a P2WPKH address: ${address}`);
  return decoded.hash;
}

// Size before signing, P2WPKH inputs and outputs (fewer than 253 of each): 41 bytes per input,
// 31 per output, and a witness of at most 109 bytes per input (a DER signature of up to 72 bytes
// with its sighash byte, the 33-byte key, three length bytes) that counts a quarter.
function vsize(inputs: number, outputs: number): bigint {
  return BigInt(Math.ceil((4 * (10 + 41 * inputs + 31 * outputs) + 2 + 109 * inputs) / 4));
}

// One BIP-143 digest per input, unlike EVM's one per transaction; each commits to its input's
// amount. A P2WPKH coin's script code is the P2PKH script of the same key hash, not the coin's
// own script. preimageWitnessV0 returns the digest, despite its name.
function digests(tx: Transaction, from: string, amounts: bigint[]): Uint8Array[] {
  const code = OutScript.encode({ type: 'pkh', hash: keyHash(from) });
  return amounts.map((amount, i) => tx.preimageWitnessV0(i, code, SigHash.ALL, amount));
}

function unsignedTx(tx: Transaction, from: string, amounts: bigint[]): UnsignedTx {
  const body: Body = { tx: bytesToHex(tx.unsignedTx), from, amounts: amounts.map(String) };
  return { body, signingPayloads: digests(tx, from, amounts).map((d) => bytesToHex(d)) };
}

// -5: the node has no such transaction (in a block or in the mempool, by the call).
function notFound(error: unknown): null {
  if (error instanceof RpcError && error.code === -5) return null;
  throw error;
}

export async function createBitcoinAdapter(opts: BitcoinAdapterOptions): Promise<ChainAdapter> {
  const rpc = bitcoinRpc(opts.rpcUrl, opts.auth);
  const info = await rpc.call<{ chain: string }>('getblockchaininfo');
  if (info.chain !== 'regtest') {
    throw new Error(`refusing chain "${info.chain}": only regtest is allowed`);
  }
  const feeRate = opts.feeRate ?? 2n;

  function native(asset: string): void {
    if (asset !== 'native') throw new Error(`unknown asset ${asset}`);
  }

  // The node scans the UTXO set for one caller at a time and answers -8 to any other (this
  // adapter or another client), so wait for that scan to finish.
  async function scan(address: string): Promise<Scan> {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await rpc.call<Scan>('scantxoutset', ['start', [`addr(${address})`]]);
        if (!result.success) throw new Error(`the scan for ${address} was aborted`);
        return result;
      } catch (error) {
        const busy = error instanceof RpcError && /already in progress/.test(error.message);
        if (!busy || attempt === 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  // In the mempool, or in a block of the active chain.
  async function nodeHas(txid: string): Promise<boolean> {
    return (await getTxStatus(txid)).state !== 'unknown';
  }

  async function getTxStatus(txid: string): Promise<TxStatus> {
    // txindex is on, so this finds any transaction in a block, not only the node wallet's
    const tx = await rpc
      .call<{ blockhash?: string; fee: number }>('getrawtransaction', [txid, 2])
      .catch(notFound);
    if (!tx) return { state: 'unknown' };
    if (!tx.blockhash) return { state: 'pending' }; // answered from the mempool
    // Confirmed means at least one confirmation: txindex still finds a transaction whose block
    // was reorganised out, with that block's hash.
    const block = await rpc.call<{ height: number; confirmations: number }>('getblockheader', [
      tx.blockhash,
    ]);
    if (block.confirmations < 1) {
      const pooled = await rpc.call('getmempoolentry', [txid]).catch(notFound);
      return pooled ? { state: 'pending' } : { state: 'unknown' };
    }
    return {
      state: 'confirmed',
      block: { height: block.height, hash: tx.blockhash },
      confirmations: block.confirmations,
      succeeded: true, // a Bitcoin transaction in a block cannot fail
      feePaid: btcToSats(tx.fee), // reported for a transaction in a block
    };
  }

  return {
    chain,
    curve: 'secp256k1',
    finalityDepth: opts.finalityDepth ?? 3,

    deriveAddress(publicKey) {
      secp256k1.Point.fromBytes(publicKey); // throws unless a point; p2wpkh checks only the length
      return p2wpkh(publicKey, REGTEST).address;
    },

    validateAddress: isP2wpkh,

    // Confirmed coins only: the UTXO set holds no mempool outputs.
    async getBalance(address, asset) {
      native(asset);
      return btcToSats((await scan(address)).total_amount);
    },

    async getTip() {
      const hash = await rpc.call<string>('getbestblockhash');
      const { height } = await rpc.call<{ height: number }>('getblockheader', [hash]);
      return { height, hash };
    },

    // A fixed rate: estimatesmartfee answers "Insufficient data" on regtest, where blocks hold a
    // few payments. A real network would use estimatesmartfee, raised to the mempoolminfee.
    // eslint-disable-next-line @typescript-eslint/require-await -- async so a bad intent rejects
    async quoteFee(intent): Promise<Fee> {
      native(intent.asset);
      return { feeRate: feeRate.toString() };
    },

    // Coins instead of a nonce. Confirmed coins only, so a transfer never spends an output that
    // could vanish with the transaction that created it.
    async syncInputs(store, address) {
      const { unspents } = await scan(address);
      await store.putCoins(
        unspents.map((u) => ({
          id: `${u.txid}:${u.vout}`,
          owner: address,
          amount: btcToSats(u.amount),
          data: {},
        })),
      );
    },

    // Largest coins first, until they pay the amount and the fee of a transaction with change.
    async reserveInputs(store, intent, fee): Promise<Reservation> {
      const rate = BigInt((fee as Fee).feeRate);
      const need = (inputs: number) => intent.amount + vsize(inputs, 2) * rate;
      const free = await store.freeCoins(intent.from);
      free.sort((a, b) => (a.amount === b.amount ? 0 : a.amount < b.amount ? 1 : -1));
      const coins = [];
      let total = 0n;
      for (const coin of free) {
        coins.push(coin);
        total += coin.amount;
        if (total >= need(coins.length)) break;
      }
      if (total < need(coins.length)) throw new Error(`not enough free coins at ${intent.from}`);
      await store.reserveCoins(coins.map((c) => c.id));
      return { coins: coins.map((c) => ({ id: c.id, amount: c.amount.toString() })) };
    },

    // eslint-disable-next-line @typescript-eslint/require-await -- async so a bad intent rejects
    async buildTransfer(intent, reservation, fee) {
      native(intent.asset);
      if (!isP2wpkh(intent.to)) throw new Error(`not a regtest P2WPKH address: ${intent.to}`);
      const { coins } = reservation as Reservation;
      const tx = new Transaction({ version: 2, lockTime: 0 });
      for (const { id } of coins) {
        const [txid, vout] = id.split(':');
        tx.addInput({ txid: hexToBytes(txid!), index: Number(vout), sequence: SEQUENCE });
      }
      tx.addOutputAddress(intent.to, intent.amount, REGTEST);
      const amounts = coins.map((c) => BigInt(c.amount));
      const total = amounts.reduce((sum, a) => sum + a, 0n);
      const change = total - intent.amount - vsize(coins.length, 2) * BigInt((fee as Fee).feeRate);
      if (change < 0n) throw new Error(`the reserved ${total} sat do not pay amount and fee`);
      if (change >= DUST) tx.addOutputAddress(intent.from, change, REGTEST);
      return unsignedTx(tx, intent.from, amounts);
    },

    attachSignatures(unsigned, signatures) {
      const { tx: rawTx, from, amounts: decimals } = unsigned.body as Body;
      const tx = Transaction.fromRaw(hexToBytes(rawTx));
      const amounts = decimals.map((a) => BigInt(a));
      if (signatures.length !== tx.inputsLength) {
        throw new Error(`${signatures.length} signatures for ${tx.inputsLength} inputs`);
      }
      const owner = keyHash(from);
      const script = OutScript.encode({ type: 'wpkh', hash: owner });
      digests(tx, from, amounts).forEach((digest, i) => {
        const sig65 = signatures[i]!;
        if (sig65.length !== 65) throw new Error(`signature ${i}: ${sig65.length} bytes, not 65`);
        const recovery = sig65[64]!;
        if (recovery > 1)
          throw new Error(`signature ${i}: recovery id must be 0 or 1, got ${recovery}`);
        // The body holds no public key: it is recovered from the signature, which is why the
        // signer returns the recovery id. A wrong key or a wrong recovery id gives another key.
        let sig = secp256k1.Signature.fromBytes(sig65.subarray(0, 64), 'compact');
        const publicKey = sig.addRecoveryBit(recovery).recoverPublicKey(digest).toBytes(true);
        if (bytesToHex(hash160(publicKey)) !== bytesToHex(owner)) {
          throw new Error(`signature ${i}: the key that made it does not own the input`);
        }
        // the node relays only low-S signatures; (r, n - s) is the same signature
        if (sig.hasHighS()) sig = new secp256k1.Signature(sig.r, secp256k1.Point.Fn.ORDER - sig.s);
        tx.updateInput(i, {
          witnessUtxo: { script, amount: amounts[i]! },
          finalScriptWitness: [Uint8Array.of(...sig.toBytes('der'), SigHash.ALL), publicKey],
        });
      });
      // the txid hashes the transaction without its witness, so it is fixed before signing
      return { txid: tx.id, raw: bytesToHex(tx.extract()) };
    },

    buildReplacement: () => Promise.reject(new Error('not implemented')),

    async broadcast({ txid, raw }) {
      if (await nodeHas(txid)) return { outcome: 'already_known' };
      let sent: string;
      try {
        sent = await rpc.call<string>('sendrawtransaction', [raw]);
      } catch (error) {
        if (!(error instanceof RpcError)) throw error; // no answer from the node
        // The code does not say whether the node has these bytes (a mined transaction whose
        // outputs are all spent gets -25 bad-txns-inputs-missingorspent, as a double spend
        // does); the txid lookup does.
        return (await nodeHas(txid))
          ? { outcome: 'already_known' }
          : { outcome: 'rejected', reason: error.message };
      }
      if (sent !== txid) throw new Error(`node reports txid ${sent} for local txid ${txid}`);
      return { outcome: 'accepted' };
    },

    getTxStatus,

    scanBlock: () => Promise.reject(new Error('not implemented')),
  };
}
