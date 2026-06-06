import { readFile, writeFile } from "node:fs/promises";
import type { CapabilityManifest } from "./types.js";

/**
 * Builds a sandboxed fetch function that enforces the allowedHosts list (A2).
 *
 * If allowedHosts is empty, fetch is not injected into the sandbox (default deny-all).
 * If allowedHosts is non-empty, only URLs whose hostname matches one of the glob
 * patterns in the list are permitted; all others throw CapabilityDenied.
 */
export function buildSandboxFetch(
  allowedHosts: string[]
): ((input: string | URL, init?: RequestInit) => Promise<Response>) | undefined {
  if (allowedHosts.length === 0) return undefined;

  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.href);
    const hostname = url.hostname;
    if (!allowedHosts.some((pattern) => matchGlob(pattern, hostname))) {
      throw new Error(
        `CapabilityDenied: fetch to "${hostname}" is not in allowedHosts [${allowedHosts.join(", ")}]`
      );
    }
    return fetch(input, init);
  };
}

/**
 * Validates a file-system path against an allow-list of path prefixes (A2).
 * Throws CapabilityDenied if the path is not covered by any prefix.
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
  if (!allowedPaths.some((prefix) => path.startsWith(prefix))) {
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
 * Minimal glob matcher supporting '*' and '?' wildcards.
 * Used for matching hostnames against allowedHosts patterns.
 */
export function matchGlob(pattern: string, value: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&") // escape regex specials except * and ?
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`).test(value);
}
