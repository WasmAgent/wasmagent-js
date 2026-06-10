/**
 * FileLockManager — bolt.new "protect file" pattern.
 *
 * Marks files the agent must not overwrite, preventing accidental corruption
 * of critical project files (lock files, .env, build configs, etc.).
 *
 * Integration:
 * - ToolCallingAgent: check before executing write_file / patch_file / delete_file
 * - CodeAgent: not applicable (operates on kernel, not FS)
 *
 * Levels:
 * - "hard": block with error (default for secrets, lock files)
 * - "warn": allow but emit guardrail_tripwire warning (for config files)
 */

export type LockLevel = "hard" | "warn";

export interface LockedFile {
  pattern: string;       // glob-style pattern or exact path
  level: LockLevel;
  reason: string;
}

// Default locked patterns — covers the most common accidentally-overwritten files
const DEFAULT_LOCKS: LockedFile[] = [
  // Secrets and environment — never touch
  { pattern: ".env",              level: "hard", reason: "environment secrets" },
  { pattern: ".env.local",        level: "hard", reason: "local environment secrets" },
  { pattern: ".env.production",   level: "hard", reason: "production secrets" },
  { pattern: ".env.*.local",      level: "hard", reason: "local environment secrets" },
  { pattern: ".dev.vars",         level: "hard", reason: "Wrangler dev secrets" },
  // Package lock files — let npm/bun manage these
  { pattern: "package-lock.json", level: "hard", reason: "managed by npm" },
  { pattern: "yarn.lock",         level: "hard", reason: "managed by yarn" },
  { pattern: "pnpm-lock.yaml",    level: "hard", reason: "managed by pnpm" },
  { pattern: "bun.lock",          level: "hard", reason: "managed by bun" },
  // Build configs — warn but allow override
  { pattern: "tsconfig.json",     level: "warn", reason: "TypeScript config" },
  { pattern: ".gitignore",        level: "warn", reason: "git ignore rules" },
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
