// Edge-portability note (2026-06-16): node:fs/promises and node:path are
// only used by the FS-allow-list helpers below (`assertPathAllowed`,
// `buildCapabilityGlobals`'s __fs__ branch). Those branches are
// Node-only by construction — Cloudflare Workers and Vercel Edge have
// no real filesystem and so callers there configure
// `allowedReadPaths` / `allowedWritePaths` empty (deny-all), which
// short-circuits the import below. We therefore lazy-import the Node
// modules instead of bare-importing them at module scope, so the
// module is parseable on edge bundlers; the import only runs when
// FS capabilities are actually requested.
import type { CapabilityManifest } from "./types.js";

let _nodeFs: typeof import("node:fs/promises") | undefined;
async function _loadNodeFsP(): Promise<typeof import("node:fs/promises")> {
  if (!_nodeFs) {
    _nodeFs = await import("node:fs/promises");
  }
  return _nodeFs;
}

/**
 * Sync portable path resolver — used by `assertPathAllowed` to keep
 * that function's sync signature stable across runtimes. Mimics
 * `node:path.resolve` + `path.sep` semantics for POSIX and Windows
 * paths, lexical only (no symlink following — same as `node:path`).
 *
 * Why we don't `await import("node:path")`: `assertPathAllowed` is
 * called inside Object literal property setters, where async isn't
 * an option without changing the public API shape. The lexical
 * resolution we need (joining segments, collapsing `..`/`.`,
 * detecting prefix containment) is a small subset of `node:path`
 * that's straightforward to inline.
 */
function _resolveSync(path: string): string {
  // Detect drive-letter style ("C:\foo") or UNC ("\\server\share").
  const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  const isPosixAbs = path.startsWith("/");

  if (!isWindowsAbs && !isPosixAbs) {
    // Best-effort cwd resolution. On edge runtimes we use "/" so the
    // result is purely lexical; on Node we use process.cwd() to match
    // node:path.resolve.
    const cwd =
      typeof globalThis !== "undefined" &&
      // biome-ignore lint/suspicious/noExplicitAny: feature-detect optional Node global
      typeof (globalThis as any).process?.cwd === "function"
        ? // biome-ignore lint/suspicious/noExplicitAny: same
          ((globalThis as any).process.cwd() as string)
        : "/";
    path = `${cwd}/${path}`;
  }

  // Normalise separators to forward slash for the collapse pass.
  const sep = isWindowsAbs ? "\\" : "/";
  const parts = path.split(/[/\\]+/).filter((p) => p !== "" && p !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  if (isWindowsAbs) {
    // Preserve drive prefix. parts[0] for "C:\foo" is "C:" — re-join.
    return stack.join(sep);
  }
  return `/${stack.join(sep)}`;
}

function _sepFor(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") ? "\\" : "/";
}

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

  const checkHost = (hostname: string, _input: string): void => {
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
          throw new Error(`CapabilityDenied: fetch exceeded ${MAX_REDIRECT_HOPS} redirects`);
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
 * Note: this is the lexical first gate only. It does NOT follow symlinks.
 * Callers that touch the real filesystem must additionally call
 * `assertRealpathContained` so a symlink under an allowed prefix pointing
 * outside the prefix is rejected before fs.readFile / fs.writeFile follows
 * it. `buildCapabilityGlobals.__fs__` does both gates.
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
  const resolved = _resolveSync(path);
  const sep = _sepFor(path);
  const isAllowed = allowedPaths.some((prefix) => {
    const resolvedPrefix = _resolveSync(prefix);
    return resolved === resolvedPrefix || resolved.startsWith(resolvedPrefix + sep);
  });
  if (!isAllowed) {
    throw new Error(
      `CapabilityDenied: ${operation} access to "${path}" is not in allowed${operation === "read" ? "Read" : "Write"}Paths [${allowedPaths.join(", ")}]`
    );
  }
}

/**
 * Realpath-aware containment check (A2, second gate).
 *
 * For reads: resolves both `path` and each prefix with `fs.realpath`, then
 *   requires the real path to equal or be a prefix-with-separator of an
 *   allowed real prefix. This rejects symlinks that lexically live under
 *   an allowed prefix but point outside it.
 *
 * For writes: the target file may not yet exist, so the walk starts at
 *   the nearest existing ancestor (parent dir, grandparent, ...) and
 *   realpaths that. The portion of `path` that does not yet exist is
 *   then re-joined lexically onto the resolved ancestor before the
 *   containment check, so a write into `allowed/link/new.txt` where
 *   `link` is a symlink to outside is rejected.
 *
 * If `path` exists but cannot be realpathed (e.g. permission error),
 * the check fails closed — the function throws CapabilityDenied.
 *
 * The lexical `assertPathAllowed` should still run first so callers
 * can fail fast on absolute prefix mismatches without touching the fs.
 */
export async function assertRealpathContained(
  path: string,
  allowedPaths: string[],
  operation: "read" | "write"
): Promise<void> {
  if (allowedPaths.length === 0) {
    // assertPathAllowed already enforces this, but defence-in-depth.
    throw new Error(
      `CapabilityDenied: ${operation} access to "${path}" is denied (no paths allowed)`
    );
  }
  const fs = await _loadNodeFsP();

  // 1) Resolve the request path. For reads it must exist; for writes we
  //    walk up to the nearest existing ancestor and re-join the tail.
  const sep = _sepFor(path);
  const resolvedRequest = _resolveSync(path);
  let realRequest: string;
  if (operation === "read") {
    try {
      realRequest = await fs.realpath(resolvedRequest);
    } catch (e) {
      throw new Error(
        `CapabilityDenied: read access to "${path}" rejected (cannot resolve real path: ${(e as Error).message})`
      );
    }
  } else {
    const { ancestor, tail } = await _splitAtExistingAncestor(resolvedRequest, sep, fs);
    let realAncestor: string;
    try {
      realAncestor = await fs.realpath(ancestor);
    } catch (e) {
      throw new Error(
        `CapabilityDenied: write access to "${path}" rejected (cannot resolve real path of ancestor "${ancestor}": ${(e as Error).message})`
      );
    }
    realRequest = tail === "" ? realAncestor : `${realAncestor}${sep}${tail}`;
  }

  // 2) Resolve each allowed prefix to its real path. Skip prefixes that
  //    don't exist on disk — they couldn't match anyway, and treating
  //    them as misses avoids a fail-closed where a stale config entry
  //    blocks all access.
  let isAllowed = false;
  for (const prefix of allowedPaths) {
    const resolvedPrefix = _resolveSync(prefix);
    let realPrefix: string;
    try {
      realPrefix = await fs.realpath(resolvedPrefix);
    } catch {
      continue;
    }
    const prefixSep = _sepFor(realPrefix);
    if (realRequest === realPrefix || realRequest.startsWith(realPrefix + prefixSep)) {
      isAllowed = true;
      break;
    }
  }
  if (!isAllowed) {
    throw new Error(
      `CapabilityDenied: ${operation} access to "${path}" escapes allowed${operation === "read" ? "Read" : "Write"}Paths via symlink or real-path mismatch`
    );
  }
}

/**
 * Walks up `path` until an existing ancestor directory is found, then
 * returns that ancestor and the (possibly empty) trailing portion that
 * did not exist. Used by `assertRealpathContained` for writes whose
 * target file may not be created yet.
 */
async function _splitAtExistingAncestor(
  path: string,
  sep: string,
  fs: typeof import("node:fs/promises")
): Promise<{ ancestor: string; tail: string }> {
  const exists = async (p: string): Promise<boolean> => {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  };

  if (await exists(path)) return { ancestor: path, tail: "" };
  const parts = path.split(/[/\\]+/);
  // Preserve the leading "" for POSIX absolute paths.
  const isPosixAbs = path.startsWith("/");
  const tailParts: string[] = [];
  while (parts.length > 0) {
    tailParts.unshift(parts.pop() as string);
    const candidate = isPosixAbs && parts.length === 0 ? "/" : parts.join(sep);
    if (candidate !== "" && (await exists(candidate))) {
      return { ancestor: candidate, tail: tailParts.join(sep) };
    }
  }
  // Nothing in the chain exists — fall back to the original path so the
  // caller's realpath() raises a clean ENOENT instead of us silently
  // letting it through.
  return { ancestor: path, tail: "" };
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
  if (sandboxFetch) globals.fetch = sandboxFetch;

  const readPaths = capabilities?.allowedReadPaths ?? [];
  const writePaths = capabilities?.allowedWritePaths ?? [];

  if (readPaths.length > 0 || writePaths.length > 0) {
    globals.__fs__ = {
      /**
       * Read a file at `path` (string). Returns a Promise<string> (UTF-8).
       * Throws CapabilityDenied if `path` is not within allowedReadPaths
       * lexically, OR if the resolved real path (after following symlinks)
       * escapes the allowed prefix.
       */
      readFile: async (path: string): Promise<string> => {
        assertPathAllowed(path, readPaths, "read");
        await assertRealpathContained(path, readPaths, "read");
        const fs = await _loadNodeFsP();
        return fs.readFile(path, "utf8");
      },
      /**
       * Write `data` to `path`. Returns a Promise<void>.
       * Throws CapabilityDenied if `path` is not within allowedWritePaths
       * lexically, OR if the nearest existing ancestor's real path escapes
       * the allowed write prefix (catches symlink-to-outside parents).
       */
      writeFile: async (path: string, data: string): Promise<void> => {
        assertPathAllowed(path, writePaths, "write");
        await assertRealpathContained(path, writePaths, "write");
        const fs = await _loadNodeFsP();
        return fs.writeFile(path, data, "utf8");
      },
    };
  }

  // env: explicit allow-list of values (not a pass-through of process.env).
  // Frozen so sandbox code cannot mutate the map and see its mutation
  // reflected in a sibling kernel run.
  if (capabilities?.env && Object.keys(capabilities.env).length > 0) {
    globals.__env__ = Object.freeze({ ...capabilities.env });
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
    .replace(/\*/g, "[^.]*") // * matches one label (no dots)
    .replace(/\?/g, "[^.]"); // ? matches one non-dot char
  return new RegExp(`^${regexStr}$`).test(value);
}
