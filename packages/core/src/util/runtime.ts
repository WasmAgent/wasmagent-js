/**
 * Edge-safe runtime utilities — replacement for the small subset of
 * `node:crypto` / `node:fs` / `node:path` features that we need from
 * core agent code.
 *
 * Why this file exists
 *
 *   The core packages (`agents/`, `streaming/`, `workspace/`,
 *   `executor/`) are imported by every framework adapter and are
 *   bundled for Cloudflare Workers, Vercel Edge, Bun, Deno, and
 *   browsers. A bare `import { randomUUID } from "node:crypto"` at
 *   module scope is a parse-time failure on those runtimes — even if
 *   the function is never called.
 *
 *   This module provides Web-API-first replacements that fall back to
 *   the Node implementation only when called from Node, via dynamic
 *   import inside a `typeof globalThis.crypto === "undefined"` guard.
 *   Bundlers tree-shake the dynamic import correctly because nothing
 *   touches it on edge.
 *
 * Coverage
 *
 *   - `randomUUID()` — `globalThis.crypto.randomUUID()` (Node ≥16.7,
 *     CF Workers, Vercel Edge, browsers ≥92).
 *   - `sha256Hex(bytes | string)` — `crypto.subtle.digest("SHA-256", ...)`.
 *   - `byteLength(text)` — `TextEncoder.encode(text).byteLength` (no
 *     Buffer dep).
 *
 *   Anything heavier (file system, path resolution) stays in
 *   `executor/capabilities.ts` and is only loaded inside Node-only
 *   branches via dynamic `await import("node:fs/promises")`.
 */

// We can't statically type globalThis.crypto as `Crypto` (the DOM
// type may not be in the lib target), so we feature-detect at runtime
// and use unknown internally with explicit narrow casts at call sites.
// biome-ignore lint/suspicious/noExplicitAny: env-feature-detection only — globalThis.crypto is not typed in older lib targets
const _globalCrypto: any = (globalThis as any).crypto;

/**
 * Generate a v4-style UUID. Equivalent to `node:crypto`'s `randomUUID()`
 * on Node, but uses the Web Crypto API everywhere it's available so the
 * function is callable on Cloudflare Workers / Vercel Edge / browsers
 * without a polyfill.
 *
 * On runtimes where `globalThis.crypto.randomUUID` is missing (very old
 * Node, edge environments without WebCrypto) we fall back to a
 * `getRandomValues`-backed implementation. As a last resort we use
 * `Math.random()` — non-cryptographic, but the UUID is only used as an
 * id, never as a secret, so this is safe degradation rather than silent
 * weakness.
 */
export function randomUUID(): string {
  if (_globalCrypto?.randomUUID) {
    return _globalCrypto.randomUUID();
  }
  // Fallback 1: getRandomValues + RFC 4122 v4 layout.
  if (_globalCrypto?.getRandomValues) {
    const bytes = new Uint8Array(16);
    _globalCrypto.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
  // Fallback 2: Math.random — non-crypto, last resort.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Hex-encoded SHA-256 of a string or byte array. Web-Crypto-based —
 * works on every runtime that ships SubtleCrypto. Async because
 * SubtleCrypto is async; callers that need sync hashing on Node can
 * still use `node:crypto.createHash` directly inside Node-only files.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (!_globalCrypto?.subtle) {
    throw new Error(
      "sha256Hex: globalThis.crypto.subtle is not available — call this from a runtime that ships WebCrypto (Node ≥16, CF Workers, Vercel Edge, browsers)."
    );
  }
  const digest = await _globalCrypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Byte length of a string in UTF-8 encoding. Replaces
 * `Buffer.byteLength(s, "utf8")` so the function is callable on edge
 * runtimes that don't ship the `Buffer` global by default.
 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Synchronous 64-bit non-cryptographic hash of a string, returned as a
 * 16-char hex string. Two FNV-1a passes (offset basis vs golden-ratio
 * seed) give two 32-bit hashes which we concatenate; collision rate is
 * fine for file-version tracking (the only caller — `FileTreeManager`),
 * never used as a security signal.
 *
 * Why not `crypto.subtle.digest("SHA-256", ...)`? That call is async,
 * and `FileTreeManager.#makeEntry` is sync because callers expect to
 * snapshot a file in a single tick. Migrating it to async would ripple
 * through every workspace consumer; this hash function is the
 * minimal-blast-radius edge-portable replacement.
 */
export function syncHash16(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let h1 = 0x811c9dc5; // FNV-1a 32-bit offset basis
  let h2 = 0x9e3779b1; // golden-ratio seed
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    h1 = Math.imul((h1 ^ b) >>> 0, 0x01000193) >>> 0; // FNV-1a prime
    h2 = Math.imul((h2 ^ b) >>> 0, 0x85ebca6b) >>> 0; // Murmur-family mixing const
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
