/**
 * FileTreeManager — Lovable / bolt.diy workspace file state tracker.
 *
 * Maintains an in-memory cache of file contents with SHA-256 hashes.
 * Provides:
 * - Conflict detection: if a file changed since last read, reject the write
 * - Summary tree: compact metadata for LLM context injection
 * - Semantic relevance scoring: find files related to a task (reduces context tokens)
 *
 * This prevents hallucinated file edits (model says "line 40-50" for a file
 * it last read 5 steps ago that has since changed) and enables safe
 * concurrent human + agent editing.
 *
 * Based on: Lovable's workspace isolation, bolt.diy's FS abstraction,
 * GPT-Engineer's file hash tracking in improve_loop.
 */

import { createHash } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  content: string;
  /** SHA-256 first 16 hex chars — short enough for LLM context */
  hash: string;
  lines: number;
  byteSize: number;
  lastModifiedMs: number;
}

export interface FileTreeSummary {
  totalFiles: number;
  totalBytes: number;
  files: Array<{
    path: string;
    lines: number;
    hash: string;
    lastModifiedMs: number;
  }>;
}

export interface ScoredFile {
  path: string;
  content: string;
  score: number;
  hash: string;
}

// ── Version history ────────────────────────────────────────────────────────

export interface FileVersion {
  version: number;
  hash: string;
  content: string;
  savedAtMs: number;
  /** Brief description of what changed (first 80 chars of the new content diff) */
  label?: string;
}

// ── FileTreeManager ───────────────────────────────────────────────────────────

export class FileTreeManager {
  readonly #files = new Map<string, FileEntry>();
  /** v0.dev checkpoint system: stores last N versions per file */
  readonly #versions = new Map<string, FileVersion[]>();
  static readonly MAX_VERSIONS = 10; // keep last 10 versions per file

  /**
   * Update the in-memory state from a bulk file list.
   * Call this after fetching /files/bulk from the worker.
   */
  hydrate(files: Array<{ path: string; content: string }>): void {
    for (const { path, content } of files) {
      this.#files.set(path, this.#makeEntry(path, content));
    }
  }

  /**
   * Record a newly written file (called after write_file tool result).
   * Returns the new hash so callers can confirm consistency.
   * Also snapshots a version entry (v0.dev checkpoint pattern).
   */
  recordWrite(path: string, content: string): string {
    const entry = this.#makeEntry(path, content);
    this.#files.set(path, entry);

    // Push version snapshot
    const history = this.#versions.get(path) ?? [];
    const newVersion: FileVersion = {
      version: (history.at(-1)?.version ?? 0) + 1,
      hash: entry.hash,
      content,
      savedAtMs: entry.lastModifiedMs,
    };
    history.push(newVersion);
    // Cap history length
    if (history.length > FileTreeManager.MAX_VERSIONS) history.shift();
    this.#versions.set(path, history);

    return entry.hash;
  }

  /** Get version history for a file (newest last). */
  getVersions(path: string): FileVersion[] {
    return [...(this.#versions.get(path) ?? [])];
  }

  /** Roll back a file to a specific version number. Returns rolled-back content. */
  rollback(path: string, versionNumber: number): string | null {
    const history = this.#versions.get(path);
    const target = history?.find((v) => v.version === versionNumber);
    if (!target) return null;
    this.recordWrite(path, target.content);
    return target.content;
  }

  /**
   * Record a deleted file.
   */
  recordDelete(path: string): void {
    this.#files.delete(path);
  }

  /**
   * Remove a file *and* drop its version history. Use this when the
   * caller wants the file to be entirely forgotten (e.g. workspace
   * delete) — `recordDelete` only removes the live entry but leaves
   * old versions queryable, which can leak content into rollbacks.
   */
  remove(path: string): void {
    this.#files.delete(path);
    this.#versions.delete(path);
  }

  /**
   * Get full content + hash for a single file.
   * Returns null if not tracked.
   */
  get(path: string): FileEntry | null {
    return this.#files.get(path) ?? null;
  }

  /**
   * Check for write conflicts (Lovable pattern).
   *
   * If expectedHash is provided and differs from stored hash, the file was
   * modified since the agent last read it — reject the write to prevent
   * overwriting concurrent changes.
   *
   * Returns true = safe to write, false = conflict detected.
   */
  checkWriteSafe(path: string, expectedHash?: string): boolean {
    if (!expectedHash) return true; // no hash provided — unconditional write
    const entry = this.#files.get(path);
    if (!entry) return true; // new file — no conflict possible
    return entry.hash === expectedHash;
  }

  /**
   * Compact file tree summary for LLM context injection.
   * Only includes metadata (no content) to keep token count low.
   */
  getSummary(): FileTreeSummary {
    const files = Array.from(this.#files.values()).map((e) => ({
      path: e.path,
      lines: e.lines,
      hash: e.hash,
      lastModifiedMs: e.lastModifiedMs,
    }));
    return {
      totalFiles: files.length,
      totalBytes: Array.from(this.#files.values()).reduce((s, e) => s + e.byteSize, 0),
      files,
    };
  }

  /**
   * Format the file tree as a compact string for inclusion in a system prompt.
   * Groups files by directory, shows line counts.
   */
  formatForPrompt(maxFiles = 50): string {
    const sorted = Array.from(this.#files.values())
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, maxFiles);

    if (sorted.length === 0) return "(empty workspace)";

    const lines: string[] = [`${sorted.length} file(s):`];
    let lastDir = "";
    for (const f of sorted) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ".";
      if (dir !== lastDir) {
        lines.push(`  ${dir}/`);
        lastDir = dir;
      }
      const name = f.path.includes("/") ? f.path.slice(f.path.lastIndexOf("/") + 1) : f.path;
      lines.push(`    ${name}  (${f.lines} lines)`);
    }
    return lines.join("\n");
  }

  /**
   * Find files most relevant to a task using keyword scoring.
   * Returns top-N files by relevance, with full content for context injection.
   *
   * Scoring:
   * - Path match: file name or directory contains task keywords (+3 per word)
   * - Content match: file content contains task keywords (+1 per word)
   * - Recency bonus: recently modified files score higher (+1)
   *
   * Based on bscode's getRelevantFileContents() — improved with path scoring.
   */
  getRelevantFiles(task: string, maxFiles = 5, maxContentBytes = 2000): ScoredFile[] {
    const keywords =
      task.toLowerCase().match(/\b[a-zA-Z一-龥]{2,}\b/g) ?? // ASCII words + CJK
      [];

    if (keywords.length === 0) {
      // No keywords — return most recently modified files
      return Array.from(this.#files.values())
        .sort((a, b) => b.lastModifiedMs - a.lastModifiedMs)
        .slice(0, maxFiles)
        .map((e) => ({
          path: e.path,
          content: e.content.slice(0, maxContentBytes),
          score: 0,
          hash: e.hash,
        }));
    }

    const now = Date.now();
    const scored: ScoredFile[] = [];

    for (const entry of this.#files.values()) {
      // Skip session-namespaced, meta, and binary-ish files
      if (entry.path.startsWith("session:") || entry.path.startsWith("meta:")) continue;
      if (entry.byteSize > 100_000) continue; // skip very large files

      let score = 0;
      const pathLower = entry.path.toLowerCase();
      const contentLower = entry.content.toLowerCase();

      for (const kw of keywords) {
        if (pathLower.includes(kw)) score += 3; // path match weighs more
        if (contentLower.includes(kw)) score += 1;
      }

      // Recency bonus: files modified in last 10 min get +1
      if (now - entry.lastModifiedMs < 10 * 60 * 1000) score += 1;

      if (score > 0) {
        scored.push({
          path: entry.path,
          content: entry.content.slice(0, maxContentBytes),
          score,
          hash: entry.hash,
        });
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, maxFiles);
  }

  /** Number of files currently tracked. */
  get size(): number {
    return this.#files.size;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #makeEntry(path: string, content: string): FileEntry {
    return {
      path,
      content,
      hash: createHash("sha256").update(content).digest("hex").slice(0, 16),
      lines: content.split("\n").length,
      byteSize: Buffer.byteLength(content, "utf8"),
      lastModifiedMs: Date.now(),
    };
  }
}

/**
 * Module-level singleton for bscode frontend use.
 * Tracks file state across conversation turns.
 */
export const globalFileTree = new FileTreeManager();
