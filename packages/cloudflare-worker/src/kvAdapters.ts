/**
 * Cloudflare-flavoured `KvBackend` adapters (A1).
 *
 * Bridges Cloudflare Workers KV (`KVNamespace`) and Durable Object storage
 * (`DurableObjectStorage`) to the canonical `KvBackend` contract from
 * `@wasmagent/core`. Use these adapters to back `KvCheckpointer`,
 * `StructuredMemory`, `MemoryTool`, or `KvBackendVectorStore` so the same
 * infrastructure persists checkpoints, memory, and vector indexes.
 *
 * Usage with Workers KV (eventually consistent, multi-region):
 *   const checkpointer = new KvCheckpointer(new CloudflareKvBackend(env.MY_KV));
 *
 * Usage with a Durable Object's storage (strongly consistent, single instance):
 *   class MyDO {
 *     constructor(state, env) {
 *       const checkpointer = new KvCheckpointer(new DurableObjectKvBackend(state.storage));
 *     }
 *   }
 *
 * Both adapters implement the FULL `KvBackend` contract (`get`/`put`/`delete`/`list`)
 * — no parallel infrastructure (cf. A4 cross-cutting gate).
 */

import type { KvBackend } from "@wasmagent/core";

// ── Cloudflare Workers KV ─────────────────────────────────────────────────────

/**
 * Minimal structural type of a Cloudflare Workers KV namespace —
 * matches the shape from `@cloudflare/workers-types` without taking a
 * type-only dependency on it. Real `KVNamespace` satisfies this shape.
 */
export interface CloudflareKVNamespace {
  get(key: string, options?: { type: "text" }): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string; expiration?: number }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface CloudflareKvBackendOptions {
  /**
   * Optional TTL applied to every put. Workers KV minimum is 60s.
   * Useful for ephemeral checkpoints; omit for durable storage.
   */
  expirationTtlSeconds?: number;
}

/**
 * Adapter: Cloudflare Workers `KVNamespace` → `KvBackend`.
 *
 * Note: Workers KV is eventually consistent (~60s globally). Use
 * `DurableObjectKvBackend` instead when you need read-your-writes
 * semantics (e.g. for active checkpoint loops).
 */
export class CloudflareKvBackend implements Required<KvBackend> {
  readonly #kv: CloudflareKVNamespace;
  readonly #ttl: number | undefined;

  constructor(kv: CloudflareKVNamespace, opts: CloudflareKvBackendOptions = {}) {
    this.#kv = kv;
    this.#ttl = opts.expirationTtlSeconds;
  }

  async get(key: string): Promise<string | null> {
    return this.#kv.get(key, { type: "text" });
  }

  async put(key: string, value: string): Promise<void> {
    if (this.#ttl !== undefined) {
      await this.#kv.put(key, value, { expirationTtl: this.#ttl });
    } else {
      await this.#kv.put(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.#kv.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    // Page through up to a hard cap to avoid runaway lists.
    const HARD_CAP = 10_000;
    do {
      const args: { prefix: string; cursor?: string; limit: number } = {
        prefix,
        limit: 1000,
      };
      if (cursor !== undefined) args.cursor = cursor;
      const result = await this.#kv.list(args);
      for (const k of result.keys) out.push(k.name);
      cursor = result.list_complete ? undefined : result.cursor;
      if (out.length >= HARD_CAP) break;
    } while (cursor);
    return out;
  }
}

// ── Durable Object Storage ────────────────────────────────────────────────────

/**
 * Minimal structural type of `DurableObjectStorage` — matches
 * `@cloudflare/workers-types` without a type-only dependency.
 */
export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  get<T = unknown>(keys: string[]): Promise<Map<string, T>>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options?: {
    prefix?: string;
    limit?: number;
    start?: string;
    end?: string;
    reverse?: boolean;
  }): Promise<Map<string, T>>;
}

/**
 * Adapter: Durable Object `state.storage` → `KvBackend`.
 *
 * DO storage is strongly consistent and transactional within one DO
 * instance — the right backend for active agent runs that read-modify-
 * write checkpoints.
 *
 * Stores values as strings (matches the `KvBackend` contract). DO storage
 * is JSON-serialised under the hood, so storing strings has no overhead.
 */
export class DurableObjectKvBackend implements Required<KvBackend> {
  readonly #storage: DurableObjectStorageLike;

  constructor(storage: DurableObjectStorageLike) {
    this.#storage = storage;
  }

  async get(key: string): Promise<string | null> {
    const v = await this.#storage.get<string>(key);
    return v ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    await this.#storage.put<string>(key, value);
  }

  async delete(key: string): Promise<void> {
    await this.#storage.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    const map = await this.#storage.list<string>({ prefix, limit: 10_000 });
    return [...map.keys()];
  }
}
