import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { canonicalBytes } from "./canonical.js";
import { type InTotoStatement, verifyDSSEEnvelope } from "./dsse.js";
import type { AEPRecord } from "./types.js";

/**
 * Result of verifying a chain of AEP records for hash-chain continuity.
 */
export interface ChainVerificationResult {
  valid: boolean;
  /** Index of the first record whose prev_record_hash does not match the hash of the previous record. */
  brokenAt?: number;
}

/** Hex SHA-256 of canonical bytes — content equality for two values. */
function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

/**
 * Bind a v0.4 record's inline fields to its DSSE envelope.
 *
 * The envelope's signature only covers the in-toto Statement payload —
 * without this check an attacker could modify `actions`, `run_id`,
 * `created_at_ms`, `prev_record_hash`, etc. on a signed record and still
 * pass verification. Two bindings are enforced:
 *
 * 1. **Predicate binding** — `statement.predicate` must equal the record
 *    minus `signature` / `dsse_envelope` / `timestamp_proof` (the proof is
 *    attached after signing by design, and carries its own authority
 *    signature). Records emitted before the schema_version stamp moved
 *    pre-signing carry `aep/v0.3` inside the predicate; that single field
 *    is normalised to the record's value before comparison.
 * 2. **Subject binding** — `subject[0].digest.sha256` must be the SHA-256
 *    of the canonical predicate bytes (the emitter's payloadDigest), and
 *    `subject[0].name` must reference the record's run_id.
 */
function dsseEnvelopeBindsRecord(record: AEPRecord): boolean {
  const envelope = record.dsse_envelope;
  if (!envelope) return false;
  try {
    const statement = JSON.parse(
      Buffer.from(envelope.payload, "base64").toString("utf8")
    ) as InTotoStatement;
    if (statement.predicate === undefined || !Array.isArray(statement.subject)) return false;

    const { signature: _sig, dsse_envelope: _dsse, timestamp_proof: _tp, ...unsigned } = record;

    // 1. Predicate binding (schema_version normalised for pre-fix emitters).
    const predicate = { ...(statement.predicate as Record<string, unknown>) };
    if (predicate.schema_version !== unsigned.schema_version) {
      predicate.schema_version = unsigned.schema_version;
    }
    if (canonicalDigest(predicate) !== canonicalDigest(unsigned)) return false;

    // 2. Subject binding.
    const subject = statement.subject[0];
    if (!subject) return false;
    const digestMatches =
      subject.digest?.sha256 === canonicalDigest(predicate) ||
      // Pre-fix emitters digested the un-normalised predicate bytes — same
      // bytes as `predicate` here, so the first check covers them; keep the
      // unsigned-record hash as an alternate for forward compatibility.
      subject.digest?.sha256 === canonicalDigest(unsigned);
    if (!digestMatches) return false;
    if (subject.name && unsigned.run_id && !subject.name.includes(unsigned.run_id)) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * verifyAEPRecord — verify the ed25519 signature on an AEPRecord.
 *
 * For v0.4 records with a `dsse_envelope`, verifies via DSSE (PAE encoding)
 * AND checks that the envelope's signed payload binds the record's inline
 * fields — an envelope lifted from another (or tampered) record fails.
 * For legacy records, falls back to canonical-bytes verification.
 *
 * @param record    - A complete AEPRecord (including `signature`).
 * @param publicKey - 32-byte Ed25519 public key matching the `key_id` in the record.
 * @returns `true` if the signature is valid and covers the current record contents.
 */
export async function verifyAEPRecord(record: AEPRecord, publicKey: Uint8Array): Promise<boolean> {
  // biome-ignore lint/suspicious/noExplicitAny: intentional Promise check — typeof obj.then is the standard way to detect thenables
  if (record && typeof (record as any).then === "function") {
    throw new TypeError(
      "Received a Promise instead of an AEPRecord. Did you forget to await AEPEmitter.emit()?"
    );
  }
  try {
    // DSSE path: envelope signature + payload↔record field binding.
    if (record.dsse_envelope) {
      if (!(await verifyDSSEEnvelope(record.dsse_envelope, publicKey))) return false;
      return dsseEnvelopeBindsRecord(record);
    }

    // Legacy verification path
    const { signature, dsse_envelope: _dsse, ...unsigned } = record;
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
  // biome-ignore lint/suspicious/noExplicitAny: intentional Promise check — typeof obj.then is the standard way to detect thenables
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

    // Compute the expected hash: SHA-256 hex of canonical bytes of previous record (without signature/dsse_envelope)
    const { signature: _sig, dsse_envelope: _dsse, ...prevUnsigned } = prev;
    const prevBytes = canonicalBytes(prevUnsigned);
    const expectedHash = createHash("sha256").update(prevBytes).digest("hex");

    if (current.prev_record_hash !== expectedHash) {
      return { valid: false, brokenAt: i };
    }
  }

  return { valid: true };
}
