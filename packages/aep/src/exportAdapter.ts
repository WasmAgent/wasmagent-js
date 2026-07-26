import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalBytes } from "./canonical.js";
import { type AEPRecord, AEPRecordSchema } from "./types.js";
import { verifyAEPChain, verifyAEPRecord } from "./verify.js";

/**
 * exportBundle.ts — verifiable evidence bundle export adapter (Milestone 5).
 *
 * An `EvidenceBundle` is a self-describing, tamper-evident package of ordered
 * AEP records intended for external consumers: `@wasmagent/trust-cli`, auditors,
 * and long-term evidence archives. It is the portable counterpart to the
 * in-process `EvidenceStore`.
 *
 * ## Tamper-evidence model
 *
 * The bundle carries a `manifest` with:
 *   - one content digest per record (`records[].digest`), computed over the
 *     canonical bytes of the record with `signature` and `dsse_envelope`
 *     stripped — the same projection `verifyAEPChain` hashes;
 *   - a top-level `bundle_digest`, the SHA-256 of the canonical bytes of the
 *     manifest with `bundle_digest` itself excluded.
 *
 * An auditor recomputes both to detect mutation of any record or of the
 * manifest, optionally verifies each record's ed25519 signature against a
 * trusted public key, and checks the inter-record hash chain. See
 * {@link verifyEvidenceBundle}.
 *
 * The canonicalisation is the package-wide sorted-key `JSON.stringify`
 * (see `canonical.ts`), so byte-identical bundles reproduce byte-identical
 * digests across implementations.
 */

/** Bundle schema version identifier. */
export const EVIDENCE_BUNDLE_SCHEMA_VERSION = "aep-bundle/v0.1";

/** Default producer string recorded in the manifest. */
export const EVIDENCE_BUNDLE_PRODUCER = "@wasmagent/aep";

// Per-record manifest entry: position, content digest, and denormalised run_id.
export const EvidenceBundleRecordEntrySchema = z.object({
  index: z.number().int().min(0),
  digest: z.string(),
  run_id: z.string(),
});
export type EvidenceBundleRecordEntry = z.infer<typeof EvidenceBundleRecordEntrySchema>;

/**
 * Manifest describing the bundle. `bundle_digest` is computed over the
 * canonical bytes of the manifest with `bundle_digest` excluded, so a verifier
 * can recompute it independently.
 */
export const EvidenceBundleManifestSchema = z.object({
  schema_version: z.literal(EVIDENCE_BUNDLE_SCHEMA_VERSION),
  producer: z.string(),
  /** ISO 8601 timestamp at which the bundle was assembled. */
  created_at: z.string(),
  record_count: z.number().int().min(0),
  /** Distinct run_id values present in the bundle, sorted lexicographically. */
  run_ids: z.array(z.string()),
  /** Earliest `created_at_ms` across records (ms epoch); 0 for an empty bundle. */
  started_at_ms: z.number().int(),
  /** Latest `created_at_ms` across records (ms epoch); 0 for an empty bundle. */
  ended_at_ms: z.number().int(),
  records: z.array(EvidenceBundleRecordEntrySchema),
  bundle_digest: z.string(),
});
export type EvidenceBundleManifest = z.infer<typeof EvidenceBundleManifestSchema>;

/**
 * A verifiable evidence bundle: a manifest plus the full ordered AEP records.
 *
 * Consumers should call {@link verifyEvidenceBundle} before trusting the
 * contents, even though construction validates the shape.
 */
export const EvidenceBundleSchema = z.object({
  schema_version: z.literal(EVIDENCE_BUNDLE_SCHEMA_VERSION),
  manifest: EvidenceBundleManifestSchema,
  records: z.array(AEPRecordSchema),
});
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

/** Options for {@link buildEvidenceBundle}. */
export interface BuildEvidenceBundleOptions {
  /** Override the producer string (defaults to {@link EVIDENCE_BUNDLE_PRODUCER}). */
  producer?: string;
  /** Override the ISO 8601 `created_at` timestamp (defaults to now). */
  createdAt?: string;
}

/** Options for {@link verifyEvidenceBundle}. */
export interface VerifyEvidenceBundleOptions {
  /**
   * When provided, each record's ed25519 signature is verified against this
   * 32-byte public key and the per-record results are returned in `signatures`.
   */
  publicKey?: Uint8Array;
}

/**
 * Detailed result of verifying an evidence bundle. `valid` is true iff every
 * populated check passed.
 */
export interface EvidenceBundleVerificationResult {
  /** True iff every performed check passed. */
  valid: boolean;
  /** Recomputed `bundle_digest` matched the manifest. */
  bundle_digest_valid: boolean;
  /** Every record digest matched its manifest entry. */
  record_digests_valid: boolean;
  /** `record_count` agrees with both `records.length` and `manifest.records.length`. */
  record_count_valid: boolean;
  /** Inter-record hash chain is continuous (trivially true for ≤1 record). */
  chain_valid: boolean;
  /** Index of the first record whose digest mismatches, when known. */
  broken_record_at?: number;
  /** Index of the first broken hash link, when known. */
  broken_chain_at?: number;
  /** Per-record signature results, present only when a `publicKey` was supplied. */
  signatures?: Array<{ index: number; valid: boolean }>;
}

/**
 * Compute the SHA-256 hex digest of a record's canonical bytes, with
 * `signature` and `dsse_envelope` stripped — the same projection used by
 * `verifyAEPChain`, so chain links and bundle entries stay consistent.
 */
function recordDigest(record: AEPRecord): string {
  const { signature: _sig, dsse_envelope: _dsse, ...unsigned } = record;
  return createHash("sha256").update(canonicalBytes(unsigned)).digest("hex");
}

/**
 * Compute the bundle digest over the manifest fields excluding `bundle_digest`.
 */
function computeBundleDigest(manifestBase: Omit<EvidenceBundleManifest, "bundle_digest">): string {
  return createHash("sha256").update(canonicalBytes(manifestBase)).digest("hex");
}

/**
 * Build a verifiable evidence bundle from an ordered list of AEP records.
 *
 * Records are normalised through `AEPRecordSchema` and emitted in the order
 * supplied. Pass records in insertion order (e.g. `await store.query()`) so the
 * embedded hash chain stays intact and chain verification succeeds.
 *
 * @param records  - Ordered AEP records to package. May be empty.
 * @param options  - Optional producer / timestamp overrides.
 *
 * @example
 * ```ts
 * import { buildEvidenceBundle, serializeEvidenceBundle } from "@wasmagent/aep";
 *
 * const bundle = buildEvidenceBundle(await store.query());
 * const json = serializeEvidenceBundle(bundle); // write to disk for an auditor
 * ```
 */
export function buildEvidenceBundle(
  records: AEPRecord[],
  options?: BuildEvidenceBundleOptions
): EvidenceBundle {
  // Normalise once so the stored records and the manifest digests share a
  // single, stable serialisation.
  const normalised = records.map((r) => AEPRecordSchema.parse(r));

  const entries: EvidenceBundleRecordEntry[] = normalised.map((r, i) => ({
    index: i,
    digest: recordDigest(r),
    run_id: r.run_id,
  }));

  let startedAtMs = Number.POSITIVE_INFINITY;
  let endedAtMs = Number.NEGATIVE_INFINITY;
  for (const r of normalised) {
    if (r.created_at_ms < startedAtMs) startedAtMs = r.created_at_ms;
    if (r.created_at_ms > endedAtMs) endedAtMs = r.created_at_ms;
  }
  const empty = normalised.length === 0;

  const manifestBase: Omit<EvidenceBundleManifest, "bundle_digest"> = {
    schema_version: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    producer: options?.producer ?? EVIDENCE_BUNDLE_PRODUCER,
    created_at: options?.createdAt ?? new Date().toISOString(),
    record_count: normalised.length,
    run_ids: [...new Set(normalised.map((r) => r.run_id))].sort(),
    started_at_ms: empty ? 0 : startedAtMs,
    ended_at_ms: empty ? 0 : endedAtMs,
    records: entries,
  };
  const bundle_digest = computeBundleDigest(manifestBase);

  return EvidenceBundleSchema.parse({
    schema_version: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    manifest: { ...manifestBase, bundle_digest },
    records: normalised,
  });
}

/**
 * Verify an evidence bundle's integrity and (optionally) per-record signatures.
 *
 * Checks performed:
 *   1. `record_count` consistency across the manifest and records array;
 *   2. every record's recomputed digest matches its manifest entry;
 *   3. the recomputed `bundle_digest` matches the manifest;
 *   4. the inter-record hash chain is continuous;
 *   5. if `publicKey` is supplied, each record's ed25519 signature verifies.
 *
 * `valid` is true iff every check that was performed passed.
 */
export async function verifyEvidenceBundle(
  bundle: EvidenceBundle,
  options?: VerifyEvidenceBundleOptions
): Promise<EvidenceBundleVerificationResult> {
  const { records, manifest } = bundle;

  // 1. record_count consistency
  const record_count_valid =
    manifest.record_count === records.length && manifest.records.length === records.length;

  // 2. per-record digest
  let record_digests_valid = true;
  let broken_record_at: number | undefined;
  for (let i = 0; i < records.length; i++) {
    const expected = manifest.records[i]?.digest;
    const actual = recordDigest(records[i] as AEPRecord);
    if (expected !== actual) {
      record_digests_valid = false;
      broken_record_at = i;
      break;
    }
  }

  // 3. bundle digest (recompute over manifest with bundle_digest stripped)
  const { bundle_digest: _bd, ...manifestBase } = manifest;
  const bundle_digest_valid = computeBundleDigest(manifestBase) === manifest.bundle_digest;

  // 4. inter-record hash chain
  const chainResult = verifyAEPChain(records);
  const chain_valid = chainResult.valid;

  // 5. per-record signatures (optional)
  let signatures: Array<{ index: number; valid: boolean }> | undefined;
  if (options?.publicKey) {
    signatures = [];
    for (let i = 0; i < records.length; i++) {
      const valid = await verifyAEPRecord(records[i] as AEPRecord, options.publicKey);
      signatures.push({ index: i, valid });
    }
  }

  const sigsOk = signatures === undefined || signatures.every((s) => s.valid);

  const valid =
    record_count_valid && record_digests_valid && bundle_digest_valid && chain_valid && sigsOk;

  const result: EvidenceBundleVerificationResult = {
    valid,
    record_count_valid,
    record_digests_valid,
    bundle_digest_valid,
    chain_valid,
  };
  if (broken_record_at !== undefined) result.broken_record_at = broken_record_at;
  if (chainResult.brokenAt !== undefined) result.broken_chain_at = chainResult.brokenAt;
  if (signatures !== undefined) result.signatures = signatures;
  return result;
}

/**
 * Serialize a bundle to a deterministic JSON string using the package's
 * canonical (sorted-key) serialisation. The same bundle always produces the
 * same bytes, which lets auditors pin and re-check a bundle by digest.
 */
export function serializeEvidenceBundle(bundle: EvidenceBundle): string {
  return new TextDecoder().decode(canonicalBytes(bundle));
}

/**
 * Parse and validate a serialized evidence bundle.
 *
 * @param json - Canonical or pretty-printed JSON produced by
 *               {@link serializeEvidenceBundle} or any compatible writer.
 * @returns The validated bundle.
 * @throws {z.ZodError} if the payload is not a well-formed evidence bundle.
 */
export function parseEvidenceBundle(json: string): EvidenceBundle {
  return EvidenceBundleSchema.parse(JSON.parse(json));
}
