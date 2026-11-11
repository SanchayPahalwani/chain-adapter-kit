// Test keys only. Each key is derived from a seed chosen at run time; no key is stored anywhere.
/* eslint-disable @typescript-eslint/require-await -- the interface is async; this implementation has nothing to await */
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Curve } from './adapter.js';
import type { Signer } from './signer.js';

export class LocalSigner implements Signer {
  private readonly seed: Uint8Array;
  readonly seedHex: string; // to hand the same test keys to a child process

  constructor(seed: Uint8Array) {
    if (seed.length !== 32) throw new Error('seed must be 32 bytes');
    this.seed = Uint8Array.from(seed); // slice() on a Node Buffer is a view, not a copy
    this.seedHex = bytesToHex(seed);
  }

  static random(): LocalSigner {
    return new LocalSigner(crypto.getRandomValues(new Uint8Array(32)));
  }

  static fromHex(seedHex: string): LocalSigner {
    return new LocalSigner(hexToBytes(seedHex));
  }

  // private key = sha256(seed || utf8(curve:keyId)); for secp256k1, hash again until it is a valid scalar
  private privateKey(keyId: string, curve: Curve): Uint8Array {
    const label = new TextEncoder().encode(`${curve}:${keyId}`);
    let key = sha256(concatBytes(this.seed, label));
    while (curve === 'secp256k1' && !secp256k1.utils.isValidSecretKey(key)) key = sha256(key);
    return key;
  }

  async publicKey(keyId: string, curve: Curve): Promise<Uint8Array> {
    const key = this.privateKey(keyId, curve);
    return curve === 'secp256k1' ? secp256k1.getPublicKey(key, true) : ed25519.getPublicKey(key);
  }

  async sign(keyId: string, curve: Curve, payload: Uint8Array): Promise<Uint8Array> {
    const key = this.privateKey(keyId, curve);
    if (curve === 'ed25519') return ed25519.sign(payload, key);
    if (payload.length !== 32) throw new Error('secp256k1 payload must be a 32-byte digest');
    // noble returns recovery id || r || s; the Signer contract is r || s || recovery id
    const sig = secp256k1.sign(payload, key, { prehash: false, format: 'recovered' });
    return concatBytes(sig.subarray(1), sig.subarray(0, 1));
  }
}
