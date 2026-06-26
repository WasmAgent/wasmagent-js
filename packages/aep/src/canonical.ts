/**
 * canonical.ts — deterministic serialisation for AEP record signing.
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
