import { describe, expect, it } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { equalBytes } from '@noble/curves/utils.js';
import { LocalSigner } from '../src/core/local-signer.js';

const digest = sha256(new TextEncoder().encode('hello'));

describe('LocalSigner', () => {
  it('derives the same key for the same seed and key id, and different keys otherwise', async () => {
    const a = LocalSigner.random();
    const again = LocalSigner.fromHex(a.seedHex);
    expect(await again.publicKey('k', 'secp256k1')).toEqual(await a.publicKey('k', 'secp256k1'));
    expect(await a.publicKey('k1', 'secp256k1')).not.toEqual(await a.publicKey('k2', 'secp256k1'));
    expect(a.seedHex).not.toEqual(LocalSigner.random().seedHex);
  });

  it('secp256k1: 33-byte compressed key, 65-byte signature that recovers to it', async () => {
    const signer = LocalSigner.random();
    const publicKey = await signer.publicKey('k', 'secp256k1');
    const sig = await signer.sign('k', 'secp256k1', digest);
    expect(publicKey.length).toBe(33);
    expect(sig.length).toBe(65);
    expect(sig[64]).toBeLessThanOrEqual(1);
    // noble wants the recovery id first: move the last byte to the front
    const recovered = new Uint8Array([sig[64]!, ...sig.subarray(0, 64)]);
    const recoveredKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
    expect(equalBytes(recoveredKey, publicKey)).toBe(true);
  });

  it('secp256k1: rejects a payload that is not 32 bytes', async () => {
    await expect(LocalSigner.random().sign('k', 'secp256k1', new Uint8Array(31))).rejects.toThrow();
  });

  it('ed25519: 32-byte key, 64-byte signature that verifies over the message', async () => {
    const signer = LocalSigner.random();
    const message = new TextEncoder().encode('a message of any length');
    const publicKey = await signer.publicKey('k', 'ed25519');
    const sig = await signer.sign('k', 'ed25519', message);
    expect(publicKey.length).toBe(32);
    expect(sig.length).toBe(64);
    expect(ed25519.verify(sig, message, publicKey)).toBe(true);
  });
});
