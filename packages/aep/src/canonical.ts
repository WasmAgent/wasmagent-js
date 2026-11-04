/**
 * canonical.ts — deterministic serialisation for AEP record signing.
 *
 * Canonicalization Algorithm: RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Object keys are sorted lexicographically by UTF-16 code unit (as required
 * by RFC 8785 §3.2.3). This matches the ordering used by the `rfc8785`
 * Python package and other standard JCS implementations.
 *
 * Note on JS Array.prototype.sort: the default string comparison in JS uses
 * UTF-16 code-unit order, which is exactly what RFC 8785 requires. We rely
 * on this directly without a custom comparator.
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

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    // defineProperty (not assignment) so a literal `"__proto__"` key is
    // preserved as an own property: plain assignment would trigger the
    // prototype setter and silently DROP the key.
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      Object.defineProperty(sorted, k, {
        value: (value as Record<string, unknown>)[k],
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize an object to canonical UTF-8 bytes for signing (RFC 8785 JCS).
 *
 * Object keys are sorted by UTF-16 code unit (JS default sort order, which
 * is what RFC 8785 §3.2.3 requires). Arrays preserve their order.
 */
export function canonicalBytes(obj: unknown): Uint8Array {
  const json = JSON.stringify(obj, sortedReplacer);
  return new TextEncoder().encode(json);
}
