import * as ed from "@noble/ed25519";
import { canonicalBytes } from "./canonical.js";
import type { AEPRecord } from "./types.js";

/**
 * verifyAEPRecord — verify the ed25519 signature on an AEPRecord.
 *
 * Steps:
 * 1. Strip the `signature` field to reconstruct the unsigned payload.
 * 2. Re-compute the canonical bytes the signer would have signed.
 * 3. Base64-decode the `sig` field and verify against the provided public key.
 *
 * @param record    - A complete AEPRecord (including `signature`).
 * @param publicKey - 32-byte Ed25519 public key matching the `key_id` in the record.
 * @returns `true` if the signature is valid and covers the current record contents.
 */
export async function verifyAEPRecord(record: AEPRecord, publicKey: Uint8Array): Promise<boolean> {
  try {
    const { signature, ...unsigned } = record;
    if (!signature) return false;

    const bytes = canonicalBytes(unsigned);
    const sigBytes = Uint8Array.from(Buffer.from(signature.sig, "base64"));
    return await ed.verifyAsync(sigBytes, bytes, publicKey);
  } catch {
    return false;
  }
}
