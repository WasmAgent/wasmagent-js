/**
 * F4 — AGENTS.md project-instruction loading.
 *
 * AGENTS.md is the 2025–2026 community-driven convention for "what an agent
 * needs to know about THIS repository" — build commands, test conventions,
 * code-style rules, "do not touch this directory", the lot. It's adopted by
 * Codex, Cursor, Copilot, Gemini CLI, Aider, and (via AAIF) by Anthropic and
 * OpenAI's agent stacks. As of 2026 ~60k+ public repos ship one.
 *
 * The format is intentionally schemaless — plain Markdown. The convention is
 * the file's NAME and LOCATION:
 *   - one in the repo root, scoped to the whole tree;
 *   - additional ones in subdirectories, scoped to that subtree;
 *   - "nearest wins" when several apply to the same file path (i.e. an
 *     `AGENTS.md` inside `packages/api/` overrides anything in the root).
 *
 * This module is the loader + nearest-match resolver. It is filesystem-
 * agnostic — pass a {@link AgentsMdLoader} and we'll walk it. Two ready
 * adapters cover the common cases:
 *   - {@link makeKvAgentsMdLoader} — backed by any {@link KvBackend}, used
 *     by bscode (which stores its workspace in Workers KV under `file:` keys);
 *   - {@link makeNodeAgentsMdLoader} — backed by `node:fs`, used by CLI tools
 *     and tests.
 *
 * The output is a stable, prompt-cache-friendly string that the host appends
 * verbatim to the system prompt prefix. Do NOT inject AGENTS.md into the
 * mutable mid-prompt section — that would invalidate the cache breakpoint and
 * tank the cache hit rate the v3 plan explicitly demands we preserve.
 */

import type { KvBackend } from "../checkpoint/index.js";

// ── Types ────────────────────────────────────────────────────────────────────

export const AGENTS_MD_FILENAME = "AGENTS.md";

/**
 * Filesystem-agnostic loader. Implementations need only support reading a
 * file by path and listing the children of a directory. The path shape is
 * caller's choice — POSIX relative paths are recommended.
 */
export interface AgentsMdLoader {
  /** Read a file; return null when it doesn't exist (do NOT throw). */
  read(path: string): Promise<string | null>;
  /**
   * List paths that exist anywhere under `dirPath` and end in `/AGENTS.md`,
   * including the file in `dirPath` itself if any. Returns POSIX-shape
   * paths relative to whatever root the loader is rooted at.
   *
   * The default implementations enumerate the underlying store and filter,
   * so cost is O(repo) — call once per run and cache (the ProjectInstructions
   * class below already does this for you).
   */
  listAgentsMd(dirPath: string): Promise<string[]>;
}

export interface ProjectInstructionsOptions {
  loader: AgentsMdLoader;
  /**
   * Maximum number of nested AGENTS.md files to merge. Defaults to 8 — a
   * cap that keeps system-prompt size bounded even on pathologically nested
   * monorepos. We pick the N nearest-to-`forPath` files when the cap bites,
   * so the dropped ones are the broadest / least specific.
   */
  maxFiles?: number;
  /**
   * Per-file size cap in characters. Files longer than this are truncated
   * with an explicit "[truncated]" marker so the agent isn't silently lied
   * to. Default 8000 chars (~2k tokens).
   */
  maxFileChars?: number;
}

export interface ResolvedInstructions {
  /**
   * The system-prompt fragment to inject. Empty string when no AGENTS.md
   * was found anywhere in the chain — callers should still inject it so
   * the prompt-cache key stays stable across "no AGENTS.md" runs.
   */
  text: string;
  /** Paths that contributed, nearest-first. Useful for telemetry. */
  sources: string[];
  /** True if any contributing file was truncated by `maxFileChars`. */
  truncated: boolean;
}

// ── Resolver ─────────────────────────────────────────────────────────────────

const HEADER = "# Project instructions (AGENTS.md)";
const FOOTER = "# End project instructions";
const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_FILE_CHARS = 8000;

/**
 * One per agent run. Loads / merges AGENTS.md files lazily and caches the
 * directory listing so repeated `forPath()` calls inside the same run don't
 * re-enumerate the workspace.
 */
export class ProjectInstructions {
  readonly #loader: AgentsMdLoader;
  readonly #maxFiles: number;
  readonly #maxFileChars: number;
  /** Cache for `loader.listAgentsMd("")` — populated on first call. */
  #catalog: string[] | null = null;

  constructor(opts: ProjectInstructionsOptions) {
    this.#loader = opts.loader;
    this.#maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
    this.#maxFileChars = opts.maxFileChars ?? DEFAULT_MAX_FILE_CHARS;
  }

  /**
   * Resolve every AGENTS.md that applies to a given target path, walking
   * from broadest (repo root) to nearest. Output is concatenated in
   * "broadest → nearest" order so the nearest file's rules naturally
   * override (LLMs honour later instructions over earlier ones).
   *
   * `forPath` may be:
   *   - a file path → AGENTS.md is matched against its containing dirs;
   *   - a directory path → AGENTS.md is matched against that dir + ancestors;
   *   - "" or "/"      → only the repo-root AGENTS.md applies.
   */
  async forPath(forPath = ""): Promise<ResolvedInstructions> {
    const catalog = await this.#getCatalog();
    if (catalog.length === 0) return { text: "", sources: [], truncated: false };

    // Compute applicable directories: the target dir + all ancestors up to the root.
    const targetDir = directoryOf(forPath);
    const applicable = ancestorDirs(targetDir);

    // Filter the catalog to AGENTS.md files whose directory is in `applicable`.
    // Pair each match with depth (root = 0) so we can sort nearest-first.
    type Match = { path: string; depth: number };
    const matches: Match[] = [];
    for (const candidate of catalog) {
      const dir = directoryOf(candidate);
      const depth = applicable.indexOf(dir);
      if (depth === -1) continue;
      matches.push({ path: candidate, depth });
    }
    if (matches.length === 0) return { text: "", sources: [], truncated: false };

    // Cap to maxFiles, keeping the NEAREST (deepest) files when the cap bites.
    matches.sort((a, b) => b.depth - a.depth); // deepest first (nearest)
    const kept = matches.slice(0, this.#maxFiles);
    // Now reverse so we emit broadest → nearest in the prompt (so nearest
    // appears LAST and gets the LLM's latest-wins bias).
    kept.reverse();

    const sections: string[] = [];
    let truncated = false;
    const sources: string[] = [];
    for (const m of kept) {
      const raw = await this.#loader.read(m.path);
      if (raw == null) continue;
      sources.push(m.path);
      let body = raw.trim();
      if (body.length > this.#maxFileChars) {
        body = `${body.slice(0, this.#maxFileChars)}\n\n[truncated]`;
        truncated = true;
      }
      // Section header tells the agent which file these rules came from —
      // critical context when an instruction looks self-contradictory across
      // files. Keep the header on its own line so it survives word-wrap.
      sections.push(`## from ${m.path}\n\n${body}`);
    }
    if (sections.length === 0) return { text: "", sources: [], truncated: false };
    return {
      text: `${HEADER}\n\n${sections.join("\n\n")}\n\n${FOOTER}`,
      sources,
      truncated,
    };
  }

  /**
   * Convenience: resolve the repo-root AGENTS.md (and its descendants up to
   * `maxFiles`) without targeting a specific subdirectory. Useful for cases
   * where the host hasn't yet picked a target file (e.g. at run start).
   */
  async forRepo(): Promise<ResolvedInstructions> {
    return this.forPath("");
  }

  /** Drop the cached catalog — call after the workspace changes structurally. */
  invalidate(): void {
    this.#catalog = null;
  }

  async #getCatalog(): Promise<string[]> {
    if (this.#catalog) return this.#catalog;
    const found = await this.#loader.listAgentsMd("");
    // Normalise to POSIX, strip leading slashes, dedup. Sort for determinism
    // (so two runs with identical content produce byte-identical prompts —
    // prompt-cache requirement).
    const norm = new Set<string>();
    for (const p of found) {
      const n = p.replace(/\\/g, "/").replace(/^\/+/, "");
      if (basenameOf(n) !== AGENTS_MD_FILENAME) continue;
      norm.add(n);
    }
    this.#catalog = [...norm].sort();
    return this.#catalog;
  }
}

// ── Path utilities (kept minimal — POSIX-only, no node:path) ────────────────

function directoryOf(path: string): string {
  const norm = path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!norm) return "";
  const slash = norm.lastIndexOf("/");
  if (slash === -1) return ""; // top-level file
  return norm.slice(0, slash);
}

function basenameOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  return slash === -1 ? norm : norm.slice(slash + 1);
}

/** Return [root, ..., dir] in broadest-first order. */
function ancestorDirs(dir: string): string[] {
  const norm = dir.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!norm) return [""];
  const parts = norm.split("/");
  const out: string[] = [""];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

// ── Adapters ────────────────────────────────────────────────────────────────

/**
 * KvBackend-backed loader. The KV is expected to store files under a stable
 * prefix (defaults to `file:`) — exactly the layout bscode uses. Pass
 * `{ filePrefix: "" }` if your KV stores raw paths as keys.
 */
export function makeKvAgentsMdLoader(
  kv: KvBackend,
  opts: { filePrefix?: string } = {}
): AgentsMdLoader {
  if (!kv.list) {
    throw new Error(
      "makeKvAgentsMdLoader: KvBackend must implement list(prefix) — required to enumerate AGENTS.md"
    );
  }
  const list = kv.list.bind(kv);
  const prefix = opts.filePrefix ?? "file:";
  return {
    async read(path) {
      return kv.get(`${prefix}${path}`);
    },
    async listAgentsMd(_dirPath) {
      // We always list the entire workspace — the catalog is small and
      // ProjectInstructions caches it for the lifetime of the run.
      const keys = await list(prefix);
      const out: string[] = [];
      for (const k of keys) {
        const path = k.slice(prefix.length);
        if (basenameOf(path) === AGENTS_MD_FILENAME) out.push(path);
      }
      return out;
    },
  };
}

/**
 * node:fs-backed loader rooted at `rootDir`. Walks the tree once and caches
 * nothing of its own — pair with `ProjectInstructions` (which does cache) for
 * efficient repeated lookups.
 *
 * Skips common non-source directories (`node_modules`, `.git`, `dist`,
 * `.next`, `coverage`) so a typical monorepo doesn't pay for filesystem
 * traversal of dependency trees.
 */
export function makeNodeAgentsMdLoader(rootDir: string): AgentsMdLoader {
  // Lazy-import so this module stays usable in CF Workers (no node:fs).
  const fsP = import("node:fs/promises");
  const pathP = import("node:path");
  const SKIP = new Set(["node_modules", ".git", "dist", ".next", "coverage", ".turbo", ".cache"]);
  return {
    async read(path) {
      try {
        const fs = await fsP;
        const p = await pathP;
        return await fs.readFile(p.join(rootDir, path), "utf8");
      } catch {
        return null;
      }
    },
    async listAgentsMd(_dirPath) {
      const fs = await fsP;
      const p = await pathP;
      const out: string[] = [];
      async function walk(rel: string): Promise<void> {
        let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
        try {
          entries = (await fs.readdir(p.join(rootDir, rel), { withFileTypes: true })) as Array<{
            name: string;
            isDirectory(): boolean;
            isFile(): boolean;
          }>;
        } catch {
          return;
        }
        for (const ent of entries) {
          if (ent.isDirectory()) {
            if (SKIP.has(ent.name) || ent.name.startsWith(".")) continue;
            await walk(rel ? `${rel}/${ent.name}` : ent.name);
          } else if (ent.isFile() && ent.name === AGENTS_MD_FILENAME) {
            out.push(rel ? `${rel}/${ent.name}` : ent.name);
          }
        }
      }
      await walk("");
      return out;
    },
  };
}
