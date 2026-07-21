/**
 * canonical.ts — deterministic serialisation for AEP record signing.
 *
 * IMPORTANT — Canonicalization Algorithm
 * ========================================
 * This module uses **sorted-key JSON.stringify** (recursive lexicographic key
 * sort via a replacer function), NOT RFC 8785 (JSON Canonicalization Scheme /
 * JCS).
 *
 * Implications:
 * - Floating-point numbers are serialised using V8/engine-default
 *   `Number.toString()` rules, which may differ from JCS IEEE 754 output.
 * - Large integers outside Number.MAX_SAFE_INTEGER are not specially handled.
 * - Non-ASCII strings use the engine's default JSON escape behaviour, which
 *   may differ from JCS's UTF-8 normalisation rules.
 *
 * As a result, the canonical bytes produced here may NOT match those of a
 * JCS-compliant implementation for the same logical object when floats,
 * large integers, or non-ASCII strings are present.
 *
 * The DSSE envelope's `predicateType` field
 * ("https://wasmagent.dev/attestations/aep/v0.4") distinguishes our canonical
 * form from JCS-based attestations. Verifiers MUST use this module (or an
 * equivalent sorted-key JSON.stringify) when checking signatures against
 * v0.x predicate types.
 *
 * Future: Before AEP v1.0, we may migrate to RFC 8785 (JCS) for full
 * cross-implementation interoperability. This will be signalled by a
 * predicate version bump.
 *
 * Rules:
 * - Object keys are sorted lexicographically (recursive).
 * - Arrays preserve order.
 * - The result is UTF-8 encoded JSON with no trailing newline.
 *
 * The `signature` field MUST be stripped before calling this function.
 * That is the responsibility of the caller (AEPEmitter / verifyAEPRecord).
 */

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize an object to canonical UTF-8 bytes for signing.
 *
 * Object keys are sorted recursively; arrays preserve their order.
 */
export function canonicalBytes(obj: unknown): Uint8Array {
  const json = JSON.stringify(obj, sortedReplacer);
  return new TextEncoder().encode(json);
}
