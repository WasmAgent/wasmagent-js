/**
 * File-backed implementation of StructuredKvBackend + KvBackend.
 *
 * Persists all entries to a JSON file on disk, suitable for local
 * development and CLI tools where data should survive process restarts
 * without requiring an external database.
 *
 * Uses an in-process async mutex to serialize write operations, preventing
 * concurrent writes from corrupting the JSON file.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { KvBackend } from "../checkpoint/index.js";
import type { StructuredKvBackend } from "./StructuredMemory.js";

/**
 * Simple in-process async mutex. Serializes operations that acquire it
 * so only one runs at a time. Suitable for single-process scenarios
 * (no cross-process locking).
 */
class AsyncMutex {
  #queue: Array<() => void> = [];
  #locked = false;

  async acquire(): Promise<void> {
    if (!this.#locked) {
      this.#locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.#queue.push(resolve);
    });
  }

  release(): void {
    const next = this.#queue.shift();
    if (next) {
      next();
    } else {
      this.#locked = false;
    }
  }
}

export class FileStructuredKv implements StructuredKvBackend, Required<KvBackend> {
  readonly #path: string;
  #data: Map<string, string>;
  readonly #mutex = new AsyncMutex();

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
    await this.#mutex.acquire();
    try {
      this.#data.set(key, value);
      this.#flush();
    } finally {
      this.#mutex.release();
    }
  }

  /** Canonical KvBackend write — alias of set(). */
  async put(key: string, value: string): Promise<void> {
    await this.#mutex.acquire();
    try {
      this.#data.set(key, value);
      this.#flush();
    } finally {
      this.#mutex.release();
    }
  }

  async delete(key: string): Promise<void> {
    await this.#mutex.acquire();
    try {
      this.#data.delete(key);
      this.#flush();
    } finally {
      this.#mutex.release();
    }
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.#data.keys()].filter((k) => k.startsWith(prefix));
  }

  #flush(): void {
    const obj = Object.fromEntries(this.#data);
    writeFileSync(this.#path, JSON.stringify(obj, null, 2));
  }
}
