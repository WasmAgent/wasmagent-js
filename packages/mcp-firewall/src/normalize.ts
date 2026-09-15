/**
 * Deterministic, bounded normalization pipeline for MCP tool text.
 *
 * Applies 11 structural transforms in a fixed order (size_limit through whitespace_fold),
 * with recursive base64 decode bounded by MAX_DECODE_DEPTH and MAX_TRANSFORMS.
 * Case-folding is a separate export so callers choose whether to apply it.
 */

export const MAX_DECODE_DEPTH = 3;
export const MAX_EXPANDED_BYTES = 65536;
export const MAX_TRANSFORMS = 16;

export interface NormalizedPayload {
  original: string;
  normalized: string;
  /** Transform names applied, in order (only those that actually changed the string). */
  transforms: string[];
  /** True if input exceeded MAX_EXPANDED_BYTES and was truncated. */
  truncated: boolean;
}

export interface NormalizeOptions {
  /** Current recursion depth (default 0). */
  decodeDepth?: number;
  /** Transforms applied so far in the outer call chain (default 0). */
  transformCount?: number;
  /** Skip base64 decode to avoid infinite loops (default false). */
  skipBase64?: boolean;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function truncateToMaxBytes(text: string): { result: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= MAX_EXPANDED_BYTES) return { result: text, truncated: false };
  return { result: buf.subarray(0, MAX_EXPANDED_BYTES).toString("utf-8"), truncated: true };
}

// Zero-width characters:
//   U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ,
//   U+2060 WJ, U+00AD soft hyphen, U+FEFF BOM/ZWNBSP (anywhere).
const ZERO_WIDTH_REPLACE_RE = /[​‌‍⁠­﻿]/g;
const ZERO_WIDTH_TEST_RE = /[​‌‍⁠­﻿]/;

// Full-width ASCII equivalents: U+FF01 (!) through U+FF5E (~).
const FULL_WIDTH_REPLACE_RE = /[！-～]/g;
const FULL_WIDTH_TEST_RE = /[！-～]/;

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};
const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|#39|nbsp);/g;

// Matches JSON-style escape sequences: \n \t \r \\ \" \uXXXX
const JSON_ESCAPE_RE = /\\([ntr\\"])|\\u([0-9a-fA-F]{4})/g;
const JSON_ESCAPE_TEST_RE = /\\[ntr\\"]|\\u[0-9a-fA-F]{4}/;

// Matches \xNN hex escape sequences.
const HEX_ESCAPE_RE = /\\x([0-9a-fA-F]{2})/g;

function applyUrlDecode(text: string): string {
  let result = text;
  for (let i = 0; i < MAX_DECODE_DEPTH; i++) {
    // Handle non-standard %uXXXX encoding before standard %XX.
    let decoded = result.replace(/%u([0-9a-fA-F]{4})/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16))
    );
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Malformed percent-sequence — keep current state.
    }
    if (decoded === result) break;
    result = decoded;
  }
  return result;
}

function applyHtmlEntityDecode(text: string): string {
  let result = text;
  for (let i = 0; i < MAX_DECODE_DEPTH; i++) {
    const decoded = result.replace(HTML_ENTITY_RE, (m) => HTML_ENTITIES[m] ?? m);
    if (decoded === result) break;
    result = decoded;
  }
  return result;
}

function applyJsonUnescape(text: string): string {
  if (!JSON_ESCAPE_TEST_RE.test(text)) return text;
  return text.replace(JSON_ESCAPE_RE, (match, simple, unicodeHex) => {
    if (unicodeHex !== undefined) {
      return String.fromCodePoint(Number.parseInt(unicodeHex, 16));
    }
    switch (simple) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return match;
    }
  });
}

function applyHexEscapeDecode(text: string): string {
  if (!text.includes("\\x")) return text;
  return text.replace(HEX_ESCAPE_RE, (_, hex) =>
    String.fromCodePoint(Number.parseInt(hex, 16))
  );
}

function tryDecodeBase64(text: string): string | null {
  const trimmed = text.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed)) return null;
  if (trimmed.length < 8) return null;
  if (trimmed.length % 4 !== 0) return null;
  try {
    const bytes = Buffer.from(trimmed, "base64");
    if (bytes.length > MAX_EXPANDED_BYTES) return null;
    // Fatal mode rejects invalid UTF-8 byte sequences.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return decoder.decode(bytes);
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Apply deterministic normalization pipeline to `text`.
 *
 * Stages applied in order:
 *   1  size_limit              truncate to MAX_EXPANDED_BYTES UTF-8 bytes
 *   2  unicode_nfc             NFC normalization
 *   3  bom_removal             strip leading U+FEFF
 *   4  zero_width_removal      remove U+200B/C/D, U+2060, U+00AD, U+FEFF (anywhere)
 *   5  full_width_folding      fold U+FF01-U+FF5E to ASCII equivalents
 *   6  url_decode              percent-decode (bounded MAX_DECODE_DEPTH iterations)
 *   7  html_entity_decode      decode &amp; &lt; &gt; &quot; &#39; &nbsp;
 *   8  json_unescape           unescape \\n \\t \\r \\\\ \\" \\uXXXX
 *   9  hex_escape_decode       decode \\xNN sequences
 *  10  base64_candidate_decode detect + recursively decode valid base64 payloads
 *  11  whitespace_fold         collapse whitespace, trim
 *
 * Case-fold (step 12) is NOT applied here. Use caseFoldNormalize or
 * normalizeForDetection for that.
 */
export function normalizePayload(text: string, options?: NormalizeOptions): NormalizedPayload {
  const decodeDepth = options?.decodeDepth ?? 0;
  let transformCount = options?.transformCount ?? 0;
  const transforms: string[] = [];
  let truncated = false;

  function record(name: string, next: string, prev: string): string {
    if (next !== prev) {
      transforms.push(name);
      transformCount++;
    }
    return next;
  }

  // Step 1: size_limit
  const sizeResult = truncateToMaxBytes(text);
  if (sizeResult.truncated) {
    truncated = true;
    transforms.push("size_limit");
    transformCount++;
  }
  let s = sizeResult.result;

  // Step 2: unicode_nfc
  s = record("unicode_nfc", s.normalize("NFC"), s);

  // Step 3: bom_removal — strip leading U+FEFF
  if (s.codePointAt(0) === 0xFEFF) {
    s = s.slice(1);
    transforms.push("bom_removal");
    transformCount++;
  }

  // Step 4: zero_width_removal
  s = record("zero_width_removal", s.replace(ZERO_WIDTH_REPLACE_RE, ""), s);

  // Step 5: full_width_folding
  s = record(
    "full_width_folding",
    s.replace(FULL_WIDTH_REPLACE_RE, (ch) =>
      String.fromCodePoint((ch.codePointAt(0) ?? 0xFF01) - 0xFF01 + 0x21)
    ),
    s
  );

  // Step 6: url_decode
  s = record("url_decode", applyUrlDecode(s), s);

  // Step 7: html_entity_decode
  s = record("html_entity_decode", applyHtmlEntityDecode(s), s);

  // Step 8: json_unescape
  s = record("json_unescape", applyJsonUnescape(s), s);

  // Step 9: hex_escape_decode
  s = record("hex_escape_decode", applyHexEscapeDecode(s), s);

  // Step 10: base64_candidate_decode
  if (
    !(options?.skipBase64 ?? false) &&
    decodeDepth < MAX_DECODE_DEPTH &&
    transformCount < MAX_TRANSFORMS
  ) {
    const decoded = tryDecodeBase64(s);
    if (decoded !== null) {
      transforms.push("base64_candidate_decode");
      transformCount++;
      // Decoded content re-enters the pipeline from step 1.
      const inner = normalizePayload(decoded, {
        decodeDepth: decodeDepth + 1,
        transformCount,
      });
      for (const t of inner.transforms) {
        transforms.push(t);
        transformCount++;
      }
      if (inner.truncated) truncated = true;
      s = inner.normalized;
      // inner.normalized has already been through steps 2-11;
      // step 11 below is idempotent and will record no transform.
    }
  }

  // Step 11: whitespace_fold
  s = record("whitespace_fold", s.replace(/\s+/g, " ").trim(), s);

  return { original: text, normalized: s, transforms, truncated };
}

/**
 * Apply case-fold (lowercase) to already-normalised text.
 * Exported for use in comparison contexts.
 */
export function caseFoldNormalize(text: string): string {
  return text.toLowerCase();
}

/**
 * Apply all structural transforms plus case-fold.
 * For use by the semantic detector and keyword scanning.
 */
export function normalizeForDetection(text: string): string {
  return caseFoldNormalize(normalizePayload(text).normalized);
}

/**
 * Apply structural transforms only (no case-fold).
 * For use in policy evaluation where case must be preserved.
 */
export function normalizeForPolicy(text: string): string {
  return normalizePayload(text).normalized;
}

/**
 * Return true if text contains any zero-width characters.
 * Does not modify the input.
 */
export function containsZeroWidth(text: string): boolean {
  return ZERO_WIDTH_TEST_RE.test(text);
}

/**
 * Return true if text contains any full-width ASCII characters (U+FF01-U+FF5E).
 * Does not modify the input.
 */
export function containsFullWidth(text: string): boolean {
  return FULL_WIDTH_TEST_RE.test(text);
}
