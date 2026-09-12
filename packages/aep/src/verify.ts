import { createHash } from "node:crypto";
import { canonicalBytes } from "./canonical.js";
import { type InTotoStatement, verifyDSSEEnvelope } from "./dsse.js";
import type { AEPRecord } from "./types.js";

/**
 * How the inline record fields bind to a DSSE envelope's signed payload.
 *
 * - `exact` — the signed predicate matches the record byte-for-byte.
 * - `legacy-normalized` — the only tolerated mismatch: pre-fix emitters
 *   carried `aep/v0.3` inside the signed predicate while the record stamps
 *   `aep/v0.4`. Any other signed↔outer version pair is a binding FAILURE,
 *   never a normalisation opportunity (silent normalisation would let a
 *   v0.3-signed payload masquerade as a v0.5 record).
 * - `not-applicable` — no envelope (legacy signature path).
 * - `invalid` — predicate/subject binding did not hold.
 */
export type BindingMode = "exact" | "legacy-normalized" | "not-applicable" | "invalid";

/**
 * What the verification actually established about the record's origin.
 * `unsigned` is distinct from `invalid`: an unsigned record is
 * protocol-valid, it just carries no authenticity claim.
 */
export type AuthenticityMode = "dsse-valid" | "unsigned" | "invalid" | "not-checked";

export interface AEPDetailedVerificationResult {
  valid: boolean;
  authenticity: AuthenticityMode;
  binding: BindingMode;
}

/** Assurance state of the inter-record hash chain (see verifyAEPChain). */
export type ChainStatus = "intact" | "not-present" | "partial" | "broken";

/**
 * Result of verifying a chain of AEP records for hash-chain continuity.
 *
 * `valid` alone cannot distinguish "chain was present and intact" from
 * "chain was absent and therefore not checked" — `status` carries that:
 * high-assurance consumers must require `status === "intact"`.
 */
export interface ChainVerificationResult {
  valid: boolean;
  status: ChainStatus;
  /** Index of the first record whose prev_record_hash does not match the hash of the previous record. */
  brokenAt?: number;
}

/** Hex SHA-256 of canonical bytes — content equality for two values. */
function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

/**
 * Evaluate how a v0.4+ record's inline fields bind to its DSSE envelope.
 *
 * The envelope's signature only covers the in-toto Statement payload —
 * without this check an attacker could modify `actions`, `run_id`,
 * `created_at_ms`, `prev_record_hash`, etc. on a signed record and still
 * pass verification. Two bindings are enforced:
 *
 * 1. **Predicate binding** — `statement.predicate` must equal the record
 *    minus `signature` / `dsse_envelope` / `timestamp_proof` (the proof is
 *    attached after signing by design, and carries its own authority
 *    signature). The single tolerated exception is the documented legacy
 *    window: `aep/v0.3` inside the signed predicate with `aep/v0.4` on the
 *    record — normalised before comparison and reported as
 *    `legacy-normalized`.
 * 2. **Subject binding** — `subject[0].digest.sha256` must be the SHA-256
 *    of the canonical predicate bytes (the emitter's payloadDigest), and
 *    `subject[0].name` must reference the record's run_id.
 */
function dsseEnvelopeBinding(record: AEPRecord): BindingMode {
  const envelope = record.dsse_envelope;
  if (!envelope) return "invalid";
  try {
    const statement = JSON.parse(
      Buffer.from(envelope.payload, "base64").toString("utf8")
    ) as InTotoStatement;
    if (statement.predicate === undefined || !Array.isArray(statement.subject)) return "invalid";

    const { signature: _sig, dsse_envelope: _dsse, timestamp_proof: _tp, ...unsigned } = record;

    // 1. Predicate binding.
    const predicate = { ...(statement.predicate as Record<string, unknown>) };
    let binding: BindingMode = "exact";
    if (predicate.schema_version !== unsigned.schema_version) {
      // Legacy window only — everything else fails closed.
      if (predicate.schema_version !== "aep/v0.3" || unsigned.schema_version !== "aep/v0.4") {
        return "invalid";
      }
      predicate.schema_version = unsigned.schema_version;
      binding = "legacy-normalized";
    }
    if (canonicalDigest(predicate) !== canonicalDigest(unsigned)) return "invalid";

    // 2. Subject binding.
    const subject = statement.subject[0];
    if (!subject) return "invalid";
    const digestMatches =
      subject.digest?.sha256 === canonicalDigest(predicate) ||
      // Pre-fix emitters digested the un-normalised predicate bytes — same
      // bytes as `predicate` here, so the first check covers them; keep the
      // unsigned-record hash as an alternate for forward compatibility.
      subject.digest?.sha256 === canonicalDigest(unsigned);
    if (!digestMatches) return "invalid";
    if (subject.name && unsigned.run_id && !subject.name.includes(unsigned.run_id))
      return "invalid";

    return binding;
  } catch {
    return "invalid";
  }
}

/**
 * verifyAEPRecord — verify the ed25519 signature on an AEPRecord.
 * For v0.4+ records with a `dsse_envelope`, verifies via DSSE (PAE encoding)
 * AND checks that the envelope's signed payload binds the record's inline
 * fields — an envelope lifted from another (or tampered) record fails.
 * DSSE is the only supported signing profile: records without a
 * `dsse_envelope` are `unsigned` (no signature field) or `invalid`
 * (a legacy inline signature — no longer a verification target).
 *
 * Use {@link verifyAEPRecordDetailed} when the caller needs to know WHICH
 * guarantee held; an unsigned record returns `false` rather than throwing.
 *
 * @param record    - A complete AEPRecord (including `signature`, if signed).
 * @param publicKey - 32-byte Ed25519 public key matching the `key_id` in the record.
 * @returns `true` if the signature is valid and covers the current record contents.
 */
export async function verifyAEPRecord(record: AEPRecord, publicKey: Uint8Array): Promise<boolean> {
  const detailed = await verifyAEPRecordDetailed(record, publicKey);
  return detailed.valid;
}

/**
 * Detailed verification — same checks as {@link verifyAEPRecord}, but the
 * result distinguishes WHY: unsigned vs invalid, exact vs legacy-normalized
 * DSSE binding. See {@link AEPDetailedVerificationResult}.
 */
export async function verifyAEPRecordDetailed(
  record: AEPRecord,
  publicKey: Uint8Array
): Promise<AEPDetailedVerificationResult> {
  // biome-ignore lint/suspicious/noExplicitAny: intentional Promise check — typeof obj.then is the standard way to detect thenables
  if (record && typeof (record as any).then === "function") {
    throw new TypeError(
      "Received a Promise instead of an AEPRecord. Did you forget to await AEPEmitter.emit()?"
    );
  }
  try {
    // DSSE path: envelope signature + payload↔record field binding.
    if (record.dsse_envelope) {
      if (!(await verifyDSSEEnvelope(record.dsse_envelope, publicKey))) {
        return { valid: false, authenticity: "invalid", binding: "not-applicable" };
      }
      const binding = dsseEnvelopeBinding(record);
      return {
        valid: binding !== "invalid",
        authenticity: binding === "invalid" ? "invalid" : "dsse-valid",
        binding,
      };
    }

    // No envelope: unsigned if no signature field at all; a legacy inline
    // signature (historical construction, unsupported) is simply invalid.
    if (!record.signature) {
      return { valid: false, authenticity: "unsigned", binding: "not-applicable" };
    }
    return { valid: false, authenticity: "invalid", binding: "not-applicable" };
  } catch {
    return { valid: false, authenticity: "invalid", binding: "not-applicable" };
  }
}

/**
 * verifyAEPChain — verify the inter-record hash chain across a sequence of AEP records.
 *
 * For each record after the first, checks that `prev_record_hash` equals the SHA-256 hex
 * digest of the canonical bytes (signature stripped) of the preceding record.
 *
 * `status` distinguishes assurance levels a boolean cannot express:
 * - `intact` — every expected link present and correct (high-assurance).
 * - `not-present` — no record carries links; nothing was checked. Backward
 *   compatible with records produced before hash chaining was introduced.
 * - `partial` — some links present, some missing.
 * - `broken` — a present link does not match (`valid: false`, `brokenAt` set).
 *
 * @param records - An ordered array of AEPRecords representing a chain.
 */
export function verifyAEPChain(records: AEPRecord[]): ChainVerificationResult {
  // biome-ignore lint/suspicious/noExplicitAny: intentional Promise check — typeof obj.then is the standard way to detect thenables
  if (records && typeof (records as any).then === "function") {
    throw new TypeError(
      "Received a Promise instead of an AEPRecord[]. Did you forget to await AEPEmitter.emit()?"
    );
  }
  if (records.length === 0) {
    return { valid: true, status: "not-present" };
  }
  if (records.length === 1) {
    return { valid: true, status: records[0]?.prev_record_hash == null ? "not-present" : "intact" };
  }

  let linked = 0;
  let missing = 0;
  for (let i = 1; i < records.length; i++) {
    const current = records[i];
    const prev = records[i - 1];
    if (!current || !prev) {
      missing++;
      continue;
    }

    // Absent/null link: counted, not checked (backward compatibility).
    if (current.prev_record_hash == null) {
      missing++;
      continue;
    }

    // Compute the expected hash: SHA-256 hex of canonical bytes of previous record (without signature/dsse_envelope)
    const { signature: _sig, dsse_envelope: _dsse, ...prevUnsigned } = prev;
    const prevBytes = canonicalBytes(prevUnsigned);
    const expectedHash = createHash("sha256").update(prevBytes).digest("hex");

    if (current.prev_record_hash !== expectedHash) {
      return { valid: false, status: "broken", brokenAt: i };
    }
    linked++;
  }

  if (linked === 0) return { valid: true, status: "not-present" };
  if (missing > 0) return { valid: true, status: "partial" };
  return { valid: true, status: "intact" };
}
