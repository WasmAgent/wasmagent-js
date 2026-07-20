/**
 * File-backed implementation of StructuredKvBackend + KvBackend.
 *
 * Persists all entries to a JSON file on disk, suitable for local
 * development and CLI tools where data should survive process restarts
 * without requiring an external database.
 *
 * NOT recommended for production — no locking, no atomicity guarantees.
 * Use Cloudflare KV, Redis, or Durable Objects for production workloads.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { KvBackend } from "../checkpoint/index.js";
import type { StructuredKvBackend } from "./StructuredMemory.js";

export class FileStructuredKv implements StructuredKvBackend, Required<KvBackend> {
  readonly #path: string;
  #data: Map<string, string>;

  constructor(path: string) {
    this.#path = path;
    this.#data = new Map();
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        this.#data = new Map(Object.entries(raw));
      } catch {
        // corrupt file — start fresh
      }
    }
  }

  async get(key: string): Promise<string | null> {
    return this.#data.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.#data.set(key, value);
    this.#flush();
  }

  /** Canonical KvBackend write — alias of set(). */
  async put(key: string, value: string): Promise<void> {
    this.#data.set(key, value);
    this.#flush();
  }

  async delete(key: string): Promise<void> {
    this.#data.delete(key);
    this.#flush();
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.#data.keys()].filter((k) => k.startsWith(prefix));
  }

  #flush(): void {
    const obj = Object.fromEntries(this.#data);
    writeFileSync(this.#path, JSON.stringify(obj, null, 2));
  }
}
