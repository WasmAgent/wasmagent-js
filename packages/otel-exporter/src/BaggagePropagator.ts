/**
 * BaggagePropagator — W3C Baggage header parsing & serialization.
 *
 * Baggage is the spec-compliant way to carry user-defined key/value
 * context across service boundaries (user-id, session-id, tenant, etc.).
 * Pair with traceparent/tracestate for full distributed tracing.
 *
 * @see https://www.w3.org/TR/baggage/
 */

export type Baggage = Record<string, string>;

const BAGGAGE_HEADER = "baggage";

/**
 * Parse a `baggage:` header into a key/value map.
 *
 * Whitespace is trimmed. Unknown / malformed entries are skipped
 * silently rather than throwing — the caller usually wants to keep
 * processing requests even with corrupt baggage.
 */
export function parseBaggageHeader(header: string | null | undefined): Baggage {
  if (!header) return {};
  const out: Baggage = {};
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    // Strip optional metadata after a semicolon (e.g. "name=foo;property=value")
    const semi = value.indexOf(";");
    if (semi >= 0) value = value.slice(0, semi).trim();
    if (key) {
      try {
        out[decodeURIComponent(key)] = decodeURIComponent(value);
      } catch {
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * Serialize a key/value map to a `baggage:` header value.
 * Keys + values are URI-encoded for safety.
 */
export function serializeBaggage(baggage: Baggage): string {
  return Object.entries(baggage)
    .filter(([k]) => k.length > 0)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join(",");
}

/**
 * Convenience: extract baggage from a Fetch / Hono request.
 */
export function extractBaggage(request: {
  headers: { get(name: string): string | null };
}): Baggage {
  return parseBaggageHeader(request.headers.get(BAGGAGE_HEADER));
}

/**
 * Inject baggage into outgoing fetch headers (e.g. when calling a
 * downstream service from inside an agent run).
 */
export function injectBaggage(headers: Headers, baggage: Baggage): void {
  const value = serializeBaggage(baggage);
  if (value) headers.set(BAGGAGE_HEADER, value);
}
