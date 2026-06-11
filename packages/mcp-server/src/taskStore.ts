/**
 * F1 — In-memory task store. Suitable for tests, CLI tools, single-process
 * Node hosts. Production hosts on CF Workers should use the KV-backed
 * adapter from their host package.
 */

import type { McpTaskRecord, McpTaskStore } from "./types.js";

export class InMemoryTaskStore implements McpTaskStore {
  readonly #map = new Map<string, McpTaskRecord>();

  async get(id: string): Promise<McpTaskRecord | null> {
    return this.#map.get(id) ?? null;
  }

  async put(record: McpTaskRecord): Promise<void> {
    // Defensive copy so callers can mutate the local reference without
    // tearing a record that other readers may be inspecting.
    this.#map.set(record.id, structuredCloneSafe(record));
  }

  async delete(id: string): Promise<void> {
    this.#map.delete(id);
  }

  async list(): Promise<string[]> {
    return [...this.#map.keys()];
  }

  /** Visible to tests: how many records currently live. */
  get size(): number {
    return this.#map.size;
  }
}

function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}
