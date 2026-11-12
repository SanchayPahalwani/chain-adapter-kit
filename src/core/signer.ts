import type { Curve } from './adapter.js';

/**
 * The pipeline passes a key id and the adapter's signing payloads; it never sees key
 * material. An HSM or MPC signer implements the same two methods.
 */
export interface Signer {
  publicKey(keyId: string, curve: Curve): Promise<Uint8Array>; // 33-byte compressed secp256k1, or 32-byte ed25519
  sign(keyId: string, curve: Curve, payload: Uint8Array): Promise<Uint8Array>;
  // secp256k1: payload is a 32-byte digest; returns 65 bytes r || s || recovery id (0 or 1).
  //            s may be high or low: adapters accept either and send the low-S form.
  // ed25519:   payload is the message;       returns 64 bytes
}
