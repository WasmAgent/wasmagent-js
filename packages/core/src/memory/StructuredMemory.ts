/**
 * StructuredMemory — namespaced, schema-aware, decay-capable memory
 * for long-running agents.
 *
 * Three namespaces with different retention semantics:
 * - **episodic**: short-term (default 7-day TTL); decay-eligible
 * - **semantic**: long-term facts (default no TTL); persistent unless
 *   explicitly deleted
 * - **procedural**: how-to / skill memory (default 30-day TTL)
 *
 * Backed by any KV-style store (in-memory, CF KV, Redis). Stores rich
 * metadata (createdAt, lastAccessedAt, accessCount, ttlMs, tags) so a
 * `decay()` pass can prune stale entries.
 */

import type { ZodSchema } from "zod";

/** Memory namespaces with distinct retention defaults. */
export type MemoryNamespace = "episodic" | "semantic" | "procedural";

/** Backing store interface — any KV impl works. */
export interface StructuredKvBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /** List keys with the given prefix. */
  list(prefix: string): Promise<string[]>;
}

/** Internal record shape. */
interface MemoryRecord<T = unknown> {
  value: T;
  metadata: {
    createdAt: number;
    lastAccessedAt: number;
    accessCount: number;
    ttlMs?: number;
    tags?: string[];
    namespace: MemoryNamespace;
  };
}

/** Public, read-only view of a memory entry. */
export interface MemoryEntry<T = unknown> {
  key: string;
  value: T;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  ttlMs?: number;
  tags?: string[];
  namespace: MemoryNamespace;
}

const DEFAULT_TTL: Record<MemoryNamespace, number | undefined> = {
  episodic: 7 * 24 * 60 * 60 * 1000, // 7 days
  semantic: undefined, // never auto-expires
  procedural: 30 * 24 * 60 * 60 * 1000, // 30 days
};

const KEY_DELIM = ":";

/** Build the full backend key, prefixed by namespace. */
function backendKey(ns: MemoryNamespace, key: string): string {
  return `mem${KEY_DELIM}${ns}${KEY_DELIM}${key}`;
}

/** Strip the namespace prefix from a backend key. */
function stripPrefix(fullKey: string): string {
  const parts = fullKey.split(KEY_DELIM);
  return parts.slice(2).join(KEY_DELIM);
}

export interface SetOptions<T = unknown> {
  schema?: ZodSchema<T>;
  ttlMs?: number;
  tags?: string[];
  namespace?: MemoryNamespace;
}

export interface QueryFilter {
  namespace?: MemoryNamespace;
  tags?: string[]; // ALL of these tags must be present
  after?: number; // createdAt > after
  before?: number; // createdAt < before
}

export interface DecayOptions {
  /** Don't actually delete anything — just report what would be purged. */
  dryRun?: boolean;
  /** Override the cutoff time (ms epoch). Default: now. */
  now?: number;
}

export interface DecayResult {
  scanned: number;
  purged: number;
  purgedKeys: string[];
}

/**
 * Structured key-value memory with namespaces, TTL, decay, and tag-
 * based queries.
 */
export class StructuredMemory {
  readonly #backend: StructuredKvBackend;
  readonly #onError: (msg: string, err: unknown) => void;

  constructor(
    backend: StructuredKvBackend,
    opts: { onError?: (msg: string, err: unknown) => void } = {}
  ) {
    this.#backend = backend;
    // Default: surface to console.warn so silent corruption is visible
    // in logs. Production callers should pass their structured logger.
    this.#onError = opts.onError ?? ((msg, err) => console.warn(`[StructuredMemory] ${msg}`, err));
  }

  async set<T>(key: string, value: T, opts: SetOptions<T> = {}): Promise<void> {
    if (opts.schema) {
      const parsed = opts.schema.safeParse(value);
      if (!parsed.success) {
        throw new Error(
          `StructuredMemory.set: schema validation failed for key "${key}": ${parsed.error.message}`
        );
      }
    }
    const ns = opts.namespace ?? "episodic";
    const now = Date.now();
    const ttl = opts.ttlMs ?? DEFAULT_TTL[ns];
    const record: MemoryRecord<T> = {
      value,
      metadata: {
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        namespace: ns,
        ...(ttl !== undefined && { ttlMs: ttl }),
        ...(opts.tags !== undefined && { tags: opts.tags }),
      },
    };
    await this.#backend.set(backendKey(ns, key), JSON.stringify(record));
  }

  async get<T>(key: string, namespace: MemoryNamespace = "episodic"): Promise<T | null> {
    const raw = await this.#backend.get(backendKey(namespace, key));
    if (!raw) return null;
    let record: MemoryRecord<T>;
    try {
      record = JSON.parse(raw) as MemoryRecord<T>;
    } catch (e) {
      this.#onError(`get: corrupted record at "${namespace}/${key}", returning null`, e);
      return null;
    }
    // TTL check
    if (record.metadata.ttlMs && Date.now() - record.metadata.createdAt > record.metadata.ttlMs) {
      await this.#backend.delete(backendKey(namespace, key));
      return null;
    }
    // Update access metadata
    record.metadata.lastAccessedAt = Date.now();
    record.metadata.accessCount++;
    // Best-effort write-back; don't block reads on failure but DO log
    // — silent write-back failures hide cache-coherence bugs.
    void this.#backend.set(backendKey(namespace, key), JSON.stringify(record)).catch((e) => {
      this.#onError(`get: write-back of access metadata failed at "${namespace}/${key}"`, e);
    });
    return record.value;
  }

  async delete(key: string, namespace: MemoryNamespace = "episodic"): Promise<void> {
    await this.#backend.delete(backendKey(namespace, key));
  }

  /** Query by structured filter — namespace, tags, time range. */
  async query<T>(filter: QueryFilter = {}): Promise<MemoryEntry<T>[]> {
    const namespaces: MemoryNamespace[] = filter.namespace
      ? [filter.namespace]
      : ["episodic", "semantic", "procedural"];

    const all: MemoryEntry<T>[] = [];
    for (const ns of namespaces) {
      const keys = await this.#backend.list(`mem${KEY_DELIM}${ns}${KEY_DELIM}`);
      for (const fullKey of keys) {
        const raw = await this.#backend.get(fullKey);
        if (!raw) continue;
        let record: MemoryRecord<T>;
        try {
          record = JSON.parse(raw) as MemoryRecord<T>;
        } catch (e) {
          this.#onError(`query: corrupted record at "${fullKey}", skipping`, e);
          continue;
        }
        // TTL filter
        if (
          record.metadata.ttlMs &&
          Date.now() - record.metadata.createdAt > record.metadata.ttlMs
        ) {
          continue;
        }
        // Tag filter
        if (filter.tags && filter.tags.length > 0) {
          const tags = record.metadata.tags ?? [];
          if (!filter.tags.every((t) => tags.includes(t))) continue;
        }
        // Time range filter
        if (filter.after !== undefined && record.metadata.createdAt <= filter.after) continue;
        if (filter.before !== undefined && record.metadata.createdAt >= filter.before) continue;

        const entry: MemoryEntry<T> = {
          key: stripPrefix(fullKey),
          value: record.value,
          createdAt: record.metadata.createdAt,
          lastAccessedAt: record.metadata.lastAccessedAt,
          accessCount: record.metadata.accessCount,
          namespace: record.metadata.namespace,
          ...(record.metadata.ttlMs !== undefined && { ttlMs: record.metadata.ttlMs }),
          ...(record.metadata.tags !== undefined && { tags: record.metadata.tags }),
        };
        all.push(entry);
      }
    }
    return all;
  }

  /**
   * Prune expired and never-accessed entries.
   *
   * - Entries with ttlMs are dropped after `now - createdAt > ttlMs`
   * - Episodic entries with accessCount=0 and createdAt > 30 days ago
   *   are also dropped (cold cache eviction)
   */
  async decay(opts: DecayOptions = {}): Promise<DecayResult> {
    const now = opts.now ?? Date.now();
    const result: DecayResult = { scanned: 0, purged: 0, purgedKeys: [] };
    const dryRun = opts.dryRun ?? false;
    const COLD_EVICT_AFTER = 30 * 24 * 60 * 60 * 1000;

    for (const ns of ["episodic", "semantic", "procedural"] as const) {
      const keys = await this.#backend.list(`mem${KEY_DELIM}${ns}${KEY_DELIM}`);
      for (const fullKey of keys) {
        result.scanned++;
        const raw = await this.#backend.get(fullKey);
        if (!raw) continue;
        let record: MemoryRecord;
        try {
          record = JSON.parse(raw) as MemoryRecord;
        } catch (e) {
          // unparseable entry — log and purge it
          this.#onError(`decay: corrupted record at "${fullKey}", purging`, e);
          if (!dryRun) await this.#backend.delete(fullKey);
          result.purged++;
          result.purgedKeys.push(stripPrefix(fullKey));
          continue;
        }
        const expired =
          record.metadata.ttlMs !== undefined &&
          now - record.metadata.createdAt > record.metadata.ttlMs;
        const isColdEpisodic =
          ns === "episodic" &&
          record.metadata.accessCount === 0 &&
          now - record.metadata.createdAt > COLD_EVICT_AFTER;
        if (expired || isColdEpisodic) {
          if (!dryRun) await this.#backend.delete(fullKey);
          result.purged++;
          result.purgedKeys.push(stripPrefix(fullKey));
        }
      }
    }
    return result;
  }

  /** Total entry count across (or within) a namespace. */
  async count(namespace?: MemoryNamespace): Promise<number> {
    if (namespace) {
      return (await this.#backend.list(`mem${KEY_DELIM}${namespace}${KEY_DELIM}`)).length;
    }
    let total = 0;
    for (const ns of ["episodic", "semantic", "procedural"] as const) {
      total += (await this.#backend.list(`mem${KEY_DELIM}${ns}${KEY_DELIM}`)).length;
    }
    return total;
  }
}

/** Simple in-memory backend for tests and prototypes. */
export class InMemoryStructuredKv implements StructuredKvBackend {
  readonly #map = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.#map.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.#map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.#map.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.#map.keys()].filter((k) => k.startsWith(prefix));
  }
}
