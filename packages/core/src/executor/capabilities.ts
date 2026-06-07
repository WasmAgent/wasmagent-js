import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { CapabilityManifest } from "./types.js";

const MAX_REDIRECT_HOPS = 5;

/**
 * Builds a sandboxed fetch function that enforces the allowedHosts list (A2).
 *
 * If allowedHosts is empty, fetch is not injected into the sandbox (default deny-all).
 * If allowedHosts is non-empty, only URLs whose hostname matches one of the glob
 * patterns in the list are permitted; all others throw CapabilityDenied.
 *
 * Redirects are followed manually: each Location header is validated against
 * allowedHosts before following, preventing SSRF-via-redirect attacks where a
 * whitelisted host returns a 302 pointing to an internal/metadata endpoint.
 */
export function buildSandboxFetch(
  allowedHosts: string[]
): ((input: string | URL, init?: RequestInit) => Promise<Response>) | undefined {
  if (allowedHosts.length === 0) return undefined;

  const checkHost = (hostname: string, input: string): void => {
    if (!allowedHosts.some((pattern) => matchGlob(pattern, hostname))) {
      throw new Error(
        `CapabilityDenied: fetch to "${hostname}" is not in allowedHosts [${allowedHosts.join(", ")}]`
      );
    }
  };

  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let url = new URL(typeof input === "string" ? input : input.href);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new Error(`CapabilityDenied: fetch only supports http/https, got "${url.protocol}"`);
    }
    checkHost(url.hostname, url.href);

    let hops = 0;
    while (true) {
      const response = await fetch(url.href, { ...init, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        if (hops >= MAX_REDIRECT_HOPS) {
          throw new Error(
            `CapabilityDenied: fetch exceeded ${MAX_REDIRECT_HOPS} redirects`
          );
        }
        const location = response.headers.get("location");
        if (!location) return response;
        const next = new URL(location, url.href);
        if (next.protocol !== url.protocol) {
          throw new Error(
            `CapabilityDenied: redirect protocol downgrade from "${url.protocol}" to "${next.protocol}"`
          );
        }
        checkHost(next.hostname, next.href);
        url = next;
        hops++;
        continue;
      }
      return response;
    }
  };
}

/**
 * Validates a file-system path against an allow-list of path prefixes (A2).
 * Throws CapabilityDenied if the path is not covered by any prefix.
 *
 * Uses path.resolve to canonicalize both the input and each prefix before
 * comparing, which prevents two attacks:
 *   1. Traversal — /allowed/../../etc/passwd resolves outside /allowed.
 *   2. Prefix confusion — /allowed-sibling/x would pass a startsWith("/allowed")
 *      check but is rejected because the resolved prefix is appended with sep.
 *
 * Note: path.resolve() is a lexical operation — it does NOT follow symlinks.
 * If the filesystem under an allowed prefix contains symlinks pointing outside
 * the prefix, they will pass this check and the underlying readFile/writeFile
 * will follow them. Ensure the allowed prefixes do not contain untrusted symlinks.
 */
export function assertPathAllowed(
  path: string,
  allowedPaths: string[],
  operation: "read" | "write"
): void {
  if (allowedPaths.length === 0) {
    throw new Error(
      `CapabilityDenied: ${operation} access to "${path}" is denied (no paths allowed)`
    );
  }
  const resolved = resolve(path);
  const isAllowed = allowedPaths.some((prefix) => {
    const resolvedPrefix = resolve(prefix);
    return resolved === resolvedPrefix || resolved.startsWith(resolvedPrefix + sep);
  });
  if (!isAllowed) {
    throw new Error(
      `CapabilityDenied: ${operation} access to "${path}" is not in allowed${operation === "read" ? "Read" : "Write"}Paths [${allowedPaths.join(", ")}]`
    );
  }
}

/**
 * Builds the sandbox context globals for capability enforcement (A2).
 *
 * - fetch: injected only when allowedHosts is non-empty, restricted to that list.
 * - __fs__: injected when read/write path capabilities are granted; operations are
 *   validated against the allow-list before delegating to node:fs/promises.
 * - All other dangerous globals (process, require, etc.) are absent by default.
 */
export function buildCapabilityGlobals(
  capabilities?: Partial<CapabilityManifest>
): Record<string, unknown> {
  const globals: Record<string, unknown> = {};

  const allowedHosts = capabilities?.allowedHosts ?? [];
  const sandboxFetch = buildSandboxFetch(allowedHosts);
  if (sandboxFetch) globals["fetch"] = sandboxFetch;

  const readPaths = capabilities?.allowedReadPaths ?? [];
  const writePaths = capabilities?.allowedWritePaths ?? [];

  if (readPaths.length > 0 || writePaths.length > 0) {
    globals["__fs__"] = {
      /**
       * Read a file at `path` (string). Returns a Promise<string> (UTF-8).
       * Throws CapabilityDenied if `path` is not within allowedReadPaths.
       */
      readFile: (path: string): Promise<string> => {
        assertPathAllowed(path, readPaths, "read");
        return readFile(path, "utf8");
      },
      /**
       * Write `data` to `path`. Returns a Promise<void>.
       * Throws CapabilityDenied if `path` is not within allowedWritePaths.
       */
      writeFile: (path: string, data: string): Promise<void> => {
        assertPathAllowed(path, writePaths, "write");
        return writeFile(path, data, "utf8");
      },
    };
  }

  return globals;
}

/**
 * Minimal glob matcher supporting '*' and '?' wildcards for hostnames.
 * '*' matches any single DNS label (no dots), consistent with shell-style host globs.
 * '?' matches any single character that is not a dot.
 *
 * Examples:
 *   matchGlob("*.example.com", "api.example.com")   → true
 *   matchGlob("*.example.com", "a.b.example.com")   → false  (* does not cross dots)
 *   matchGlob("api.example.com", "api.example.com") → true
 */
export function matchGlob(pattern: string, value: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials except * and ?
    .replace(/\*/g, "[^.]*")               // * matches one label (no dots)
    .replace(/\?/g, "[^.]");               // ? matches one non-dot char
  return new RegExp(`^${regexStr}$`).test(value);
}
