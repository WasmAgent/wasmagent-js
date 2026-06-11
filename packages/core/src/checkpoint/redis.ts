/**
 * Redis-flavoured `KvBackend` adapter (A1).
 *
 * Two transports are supported:
 *  - **REST** (Upstash, KeyDB Cloud REST): pass `{ url, token }` — no extra
 *    deps; works in edge runtimes (Cloudflare Workers, Vercel Edge).
 *  - **Client object** (ioredis, node-redis, Upstash SDK): pass any object
 *    that exposes `get`/`set`/`del`/`scan` (or `keys` as a fallback). Use
 *    on Node.js / Bun where you can hold a TCP connection.
 *
 * Either transport satisfies the canonical {@link KvBackend} contract so the
 * resulting adapter can back `KvCheckpointer`, `StructuredMemory`,
 * `MemoryTool`, or `KvBackendVectorStore` interchangeably (cf. A4 gate:
 * single KV abstraction).
 */

import type { KvBackend } from "./index.js";

// ── REST transport (Upstash-compatible) ───────────────────────────────────────

export interface RedisRestOptions {
  /** Upstash REST endpoint, e.g. `https://gusc1-honest-kit-12345.upstash.io`. */
  url: string;
  /** Bearer token for the REST endpoint. */
  token: string;
  /**
   * Optional fetch implementation. Defaults to global `fetch`. Override
   * for testing or to add timeouts/retries via a wrapper.
   */
  fetch?: typeof fetch;
  /**
   * Optional default TTL (seconds). When set, every `put` becomes
   * `SET key value EX <ttl>`. Useful for ephemeral checkpoints.
   */
  defaultTtlSeconds?: number;
}

/**
 * Adapter: Upstash-style Redis REST API → `KvBackend`.
 *
 * The REST API is HTTP/2 and stateless — works in edge runtimes where
 * holding a long-lived TCP connection is impossible.
 */
export class RedisRestKvBackend implements Required<KvBackend> {
  readonly #url: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  readonly #ttl: number | undefined;

  constructor(opts: RedisRestOptions) {
    this.#url = opts.url.replace(/\/$/, "");
    this.#headers = {
      Authorization: `Bearer ${opts.token}`,
      "Content-Type": "application/json",
    };
    this.#fetch = opts.fetch ?? fetch;
    this.#ttl = opts.defaultTtlSeconds;
  }

  async #cmd<T>(args: unknown[]): Promise<T> {
    const res = await this.#fetch(this.#url, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify(args),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`RedisRestKvBackend: ${res.status} ${res.statusText} — ${body}`);
    }
    const data = (await res.json()) as { result?: T; error?: string };
    if (data.error) throw new Error(`RedisRestKvBackend: ${data.error}`);
    return data.result as T;
  }

  async get(key: string): Promise<string | null> {
    const result = await this.#cmd<string | null>(["GET", key]);
    return result ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    if (this.#ttl !== undefined) {
      await this.#cmd<string>(["SET", key, value, "EX", String(this.#ttl)]);
    } else {
      await this.#cmd<string>(["SET", key, value]);
    }
  }

  async delete(key: string): Promise<void> {
    await this.#cmd<number>(["DEL", key]);
  }

  /**
   * Uses SCAN to enumerate keys matching `prefix*` — preferred over KEYS
   * because it is non-blocking on large keyspaces.
   */
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor = "0";
    const HARD_CAP = 10_000;
    do {
      // SCAN <cursor> MATCH <prefix*> COUNT 1000
      const result = await this.#cmd<[string, string[]]>([
        "SCAN",
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        "1000",
      ]);
      cursor = result[0];
      for (const k of result[1]) out.push(k);
      if (out.length >= HARD_CAP) break;
    } while (cursor !== "0");
    return out;
  }
}

// ── Client transport (ioredis / node-redis / Upstash SDK) ────────────────────

/**
 * Minimal structural type satisfied by ioredis, node-redis (v4 promise API),
 * and the Upstash SDK. Adapter calls only this surface — no library imports.
 */
export interface RedisClientLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  set(key: string, value: string, mode: "EX", seconds: number): Promise<unknown>;
  del(key: string): Promise<number>;
  scan(
    cursor: string | number,
    matchKeyword?: "MATCH",
    pattern?: string,
    countKeyword?: "COUNT",
    count?: number
  ): Promise<[string, string[]]>;
}

export interface RedisClientOptions {
  /**
   * Optional default TTL (seconds). When set, every `put` becomes
   * `SET key value EX <ttl>`.
   */
  defaultTtlSeconds?: number;
}

/**
 * Adapter: ioredis / node-redis-style client → `KvBackend`.
 *
 * Use this on Node.js / Bun where you can hold a long-lived connection.
 * For edge runtimes, use {@link RedisRestKvBackend} instead.
 */
export class RedisKvBackend implements Required<KvBackend> {
  readonly #client: RedisClientLike;
  readonly #ttl: number | undefined;

  constructor(client: RedisClientLike, opts: RedisClientOptions = {}) {
    this.#client = client;
    this.#ttl = opts.defaultTtlSeconds;
  }

  async get(key: string): Promise<string | null> {
    return this.#client.get(key);
  }

  async put(key: string, value: string): Promise<void> {
    if (this.#ttl !== undefined) {
      await this.#client.set(key, value, "EX", this.#ttl);
    } else {
      await this.#client.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.#client.del(key);
  }

  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | number = "0";
    const HARD_CAP = 10_000;
    do {
      const [next, keys] = await this.#client.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        1000
      );
      cursor = next;
      for (const k of keys) out.push(k);
      if (out.length >= HARD_CAP) break;
    } while (String(cursor) !== "0");
    return out;
  }
}
