import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { canonicalBytes } from "./canonical.js";
import type { AEPRecord } from "./types.js";

/**
 * Result of verifying a chain of AEP records for hash-chain continuity.
 */
export interface ChainVerificationResult {
  valid: boolean;
  /** Index of the first record whose prev_record_hash does not match the hash of the previous record. */
  brokenAt?: number;
}

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
  if (record && typeof (record as any).then === "function") {
    throw new TypeError(
      "Received a Promise instead of an AEPRecord. Did you forget to await AEPEmitter.emit()?"
    );
  }
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

/**
 * verifyAEPChain — verify the inter-record hash chain across a sequence of AEP records.
 *
 * For each record after the first, checks that `prev_record_hash` equals the SHA-256 hex
 * digest of the canonical bytes (signature stripped) of the preceding record.
 *
 * Records without `prev_record_hash` (null/undefined) are treated as valid for
 * backward compatibility with records produced before hash chaining was introduced.
 *
 * @param records - An ordered array of AEPRecords representing a chain.
 * @returns A ChainVerificationResult indicating whether the chain is intact.
 */
export function verifyAEPChain(records: AEPRecord[]): ChainVerificationResult {
  if (records && typeof (records as any).then === "function") {
    throw new TypeError(
      "Received a Promise instead of an AEPRecord[]. Did you forget to await AEPEmitter.emit()?"
    );
  }
  if (records.length <= 1) {
    return { valid: true };
  }

  for (let i = 1; i < records.length; i++) {
    const current = records[i];
    const prev = records[i - 1];
    if (!current || !prev) continue;

    // If prev_record_hash is absent/null, treat as valid (backward compatibility)
    if (current.prev_record_hash == null) {
      continue;
    }

    // Compute the expected hash: SHA-256 hex of canonical bytes of previous record (without signature)
    const { signature: _sig, ...prevUnsigned } = prev;
    const prevBytes = canonicalBytes(prevUnsigned);
    const expectedHash = createHash("sha256").update(prevBytes).digest("hex");

    if (current.prev_record_hash !== expectedHash) {
      return { valid: false, brokenAt: i };
    }
  }

  return { valid: true };
}
