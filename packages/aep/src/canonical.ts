/**
 * canonical.ts — deterministic serialisation for AEP record signing.
 *
 * Canonicalization Algorithm: RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Object keys are sorted by UTF-16 code unit (RFC 8785 §3.2.3), matching the
 * ordering used by the `rfc8785` Python package and the Rust JCS implementation
 * in wasmagent-proxy.
 *
 * Limitations vs full RFC 8785:
 * - Floating-point numbers are serialised using V8/engine-default
 *   `Number.toString()` rules, which may differ from JCS IEEE 754 output
 *   for edge-case values (NaN, ±Infinity, subnormals). AEP records contain
 *   only integer timestamps and string fields, so this does not affect
 *   any existing fixture.
 * - Large integers outside Number.MAX_SAFE_INTEGER are not specially handled.
 *
 * The `signature` field MUST be stripped before calling this function.
 * That is the responsibility of the caller (AEPEmitter / verifyAEPRecord).
 */

function compareUtf16(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = a.charCodeAt(i) - b.charCodeAt(i);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

function serializeValue(value: unknown): string {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + (value as unknown[]).map(serializeValue).join(",") + "]";
  }
  // Plain object: sort keys by UTF-16 code unit order.
  // We must NOT rely on JSON.stringify's object key ordering because V8 always
  // outputs integer-index properties first (numeric ascending), regardless of
  // insertion order or sort(). Manually building the JSON string avoids this.
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  keys.sort(compareUtf16);
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + serializeValue(obj[k]));
  return "{" + pairs.join(",") + "}";
}

/**
 * Serialize an object to canonical UTF-8 bytes for signing (RFC 8785 JCS).
 *
 * Object keys are sorted by UTF-16 code unit (RFC 8785 §3.2.3). Arrays
 * preserve their order. Integer-index keys are sorted as strings, not
 * numerically (required by RFC 8785).
 */
export function canonicalBytes(obj: unknown): Uint8Array {
  const json = serializeValue(obj);
  return new TextEncoder().encode(json);
}
