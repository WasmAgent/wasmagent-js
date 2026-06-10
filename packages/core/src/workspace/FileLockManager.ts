/**
 * FileLockManager — bolt.new "protect file" pattern.
 *
 * Marks files the agent must not overwrite.
 * By default only auto-generated package-manager lock files are blocked;
 * callers may add extra locks (e.g. secrets) via the constructor.
 *
 * Levels:
 * - "hard": block with error
 * - "warn": allow but return a warning string to surface to the agent
 */

export type LockLevel = "hard" | "warn";

export interface LockedFile {
  pattern: string; // glob-style pattern or exact path
  level: LockLevel;
  reason: string;
}

// Default locked patterns — minimal set: only files that are never safe for an agent to touch.
// tsconfig.json, .env, package.json, etc. are intentionally NOT locked here because agents
// in framework mode need to write them to scaffold a complete project.
// Callers (e.g. bscode worker) may add extra locks via the constructor.
const DEFAULT_LOCKS: LockedFile[] = [
  // Auto-generated lock files — managed by package managers, not the agent
  { pattern: "package-lock.json", level: "hard", reason: "managed by npm — do not write directly" },
  { pattern: "yarn.lock", level: "hard", reason: "managed by yarn — do not write directly" },
  { pattern: "pnpm-lock.yaml", level: "hard", reason: "managed by pnpm — do not write directly" },
  { pattern: "bun.lock", level: "hard", reason: "managed by bun — do not write directly" },
];

export class FileLockManager {
  private readonly locks: LockedFile[];

  constructor(extraLocks: LockedFile[] = []) {
    this.locks = [...DEFAULT_LOCKS, ...extraLocks];
  }

  /**
   * Check if a file path is locked.
   * Returns the matching lock (or null if unlocked).
   */
  check(filePath: string): LockedFile | null {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const filename = normalized.includes("/")
      ? normalized.slice(normalized.lastIndexOf("/") + 1)
      : normalized;

    for (const lock of this.locks) {
      if (this.#matches(lock.pattern, normalized) || this.#matches(lock.pattern, filename)) {
        return lock;
      }
    }
    return null;
  }

  /**
   * Assert that a file can be written.
   * Throws for "hard" locks, returns warning string for "warn" locks.
   */
  assertWritable(filePath: string): string | null {
    const lock = this.check(filePath);
    if (!lock) return null;

    if (lock.level === "hard") {
      throw new Error(
        `🔒 File "${filePath}" is protected (${lock.reason}). ` +
          `The agent must not modify this file. Use a different approach.`
      );
    }

    // warn level — return warning to inject into agent context
    return (
      `⚠️  File "${filePath}" is a protected configuration file (${lock.reason}). ` +
      `Proceed only if the change is intentional.`
    );
  }

  /**
   * Add a custom lock at runtime (e.g. user clicks "protect this file" in UI).
   */
  lock(pattern: string, level: LockLevel = "hard", reason = "user-protected"): void {
    this.locks.push({ pattern, level, reason });
  }

  /**
   * Remove a lock (e.g. user clicks "unprotect").
   */
  unlock(pattern: string): void {
    const idx = this.locks.findIndex((l) => l.pattern === pattern);
    if (idx !== -1) this.locks.splice(idx, 1);
  }

  /** List all currently locked files/patterns. */
  listLocks(): LockedFile[] {
    return [...this.locks];
  }

  // ── Private ────────────────────────────────────────────────────────────────

  #matches(pattern: string, path: string): boolean {
    // Exact match
    if (pattern === path) return true;

    // Simple glob: *.ext → matches any file with that extension
    if (pattern.startsWith("*.")) {
      const ext = pattern.slice(1); // ".env.local" etc.
      return path.endsWith(ext);
    }

    // Glob with * in middle: .env.*.local
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      return regex.test(path);
    }

    return false;
  }
}

/** Singleton for bscode worker process. */
export const globalFileLock = new FileLockManager();
