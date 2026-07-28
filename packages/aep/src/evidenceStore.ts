import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { AEPRecord, SideEffectClass } from "./types.js";

/**
 * Filter criteria for querying stored AEP records.
 * All non-undefined fields are AND-combined.
 * Within the `actions` array of a record, action-level filters
 * match if ANY action in the record satisfies the predicate.
 */
export interface EvidenceStoreQuery {
  /** Exact match on record.run_id */
  run_id?: string;
  /** Exact match on record.model_id */
  model_id?: string;
  /** Include only records created at or after this timestamp (ms). */
  created_after_ms?: number;
  /** Include only records created at or before this timestamp (ms). */
  created_before_ms?: number;
  /** Match records that contain at least one action with this side_effect_class. */
  action_type?: SideEffectClass;
  /** Match records that contain at least one action with this tool_name (exact). */
  tool_name?: string;
}

/**
 * EvidenceStore — pluggable backend for durable AEP record persistence.
 *
 * Concrete backends (in-memory, filesystem, etc.) must implement this interface.
 */
export interface EvidenceStore {
  /** Append a record to the store. */
  append(record: AEPRecord): void | Promise<void>;
  /**
   * Query stored records with optional filter criteria.
   * Returns records in insertion order (oldest first).
   */
  query(filter?: EvidenceStoreQuery): AEPRecord[] | Promise<AEPRecord[]>;
  /**
   * Retrieve all records for a specific run, ordered by insertion.
   */
  getByRunId(runId: string): AEPRecord[] | Promise<AEPRecord[]>;
  /**
   * Return the total number of stored records.
   */
  size(): number | Promise<number>;
}

/**
 * In-memory implementation of EvidenceStore.
 * Suitable for testing and single-process usage.
 */
export class InMemoryEvidenceStore implements EvidenceStore {
  #records: AEPRecord[] = [];

  append(record: AEPRecord): void {
    this.#records.push(record);
  }

  query(filter?: EvidenceStoreQuery): AEPRecord[] {
    if (!filter) return [...this.#records];
    return this.#records.filter((r) => matchesFilter(r, filter));
  }

  getByRunId(runId: string): AEPRecord[] {
    return this.#records.filter((r) => r.run_id === runId);
  }

  size(): number {
    return this.#records.length;
  }

  /**
   * Direct read-only access to all stored records.
   * Useful for testing and inspection.
   */
  get all(): ReadonlyArray<AEPRecord> {
    return this.#records;
  }
}

/**
 * Filesystem-backed EvidenceStore.
 *
 * Persists AEP records as an append-only NDJSON log (one JSON record per
 * line) on disk, so records survive across process sessions. The log is
 * rehydrated on construction: any records already present in the file are
 * loaded into memory before the first query.
 *
 * Each `append()` appends a single line to the log file and creates parent
 * directories as needed. Appends are serialized internally so concurrent
 * calls never interleave bytes in the file.
 *
 * @param filePath - Path to the NDJSON log file. Created on first append;
 *                   missing parent directories are created automatically.
 *
 * @example
 * ```ts
 * import { FilesystemEvidenceStore } from "@wasmagent/aep";
 *
 * const store = new FilesystemEvidenceStore("./.wasmagent/evidence.ndjson");
 * await store.append(record);
 * // ...new process session...
 * const restored = new FilesystemEvidenceStore("./.wasmagent/evidence.ndjson");
 * await restored.ready(); // wait for the log to be rehydrated
 * const all = await restored.query();
 * ```
 */
export class FilesystemEvidenceStore implements EvidenceStore {
  readonly #filePath: string;
  #records: AEPRecord[] = [];
  #appendQueue: Promise<void> = Promise.resolve();
  #ready: Promise<void>;

  constructor(filePath: string) {
    this.#filePath = filePath;
    this.#ready = this.#load();
  }

  /**
   * Resolves once the store has finished loading any pre-existing records
   * from disk. All query/size operations await this automatically, but
   * callers that need to observe load completion (or load errors) can
   * await it explicitly.
   */
  ready(): Promise<void> {
    return this.#ready;
  }

  async #load(): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(this.#filePath, "utf8");
    } catch (err: unknown) {
      // ENOENT is expected for a fresh store with no records yet.
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") return;
      throw err;
    }
    // NDJSON: one record per line. Split on newlines and skip blank lines
    // (including a trailing newline after the last record).
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.#records.push(JSON.parse(trimmed) as AEPRecord);
    }
  }

  append(record: AEPRecord): Promise<void> {
    // Serialize appends so concurrent writes never interleave in the file.
    // Prior failures are swallowed on the queue so a single failed append
    // does not poison every subsequent append; the caller still observes
    // its own rejection via the returned promise.
    const next = this.#appendQueue.catch(() => {}).then(() => this.#writeRecord(record));
    this.#appendQueue = next;
    return next;
  }

  async #writeRecord(record: AEPRecord): Promise<void> {
    await this.#ready;
    const line = `${JSON.stringify(record)}\n`;
    await fs.mkdir(path.dirname(this.#filePath), { recursive: true });
    await fs.appendFile(this.#filePath, line, "utf8");
    this.#records.push(record);
  }

  async query(filter?: EvidenceStoreQuery): Promise<AEPRecord[]> {
    await this.#ready;
    if (!filter) return [...this.#records];
    return this.#records.filter((r) => matchesFilter(r, filter));
  }

  async getByRunId(runId: string): Promise<AEPRecord[]> {
    await this.#ready;
    return this.#records.filter((r) => r.run_id === runId);
  }

  async size(): Promise<number> {
    await this.#ready;
    return this.#records.length;
  }
}

/**
 * Evaluate an {@link EvidenceStoreQuery} against a single record. All non-undefined
 * fields are AND-combined; action-level predicates (`action_type`, `tool_name`)
 * match when ANY action in the record satisfies them. Exported so other Milestone
 * 6 components (e.g. {@link EvidenceRouter}) can reuse the exact query semantics.
 */
export function matchesFilter(record: AEPRecord, filter: EvidenceStoreQuery): boolean {
  if (filter.run_id !== undefined && record.run_id !== filter.run_id) return false;
  if (filter.model_id !== undefined && record.model_id !== filter.model_id) return false;
  if (filter.created_after_ms !== undefined && record.created_at_ms < filter.created_after_ms)
    return false;
  if (filter.created_before_ms !== undefined && record.created_at_ms > filter.created_before_ms)
    return false;
  if (filter.action_type !== undefined) {
    if (!record.actions.some((a) => a.side_effect_class === filter.action_type)) return false;
  }
  if (filter.tool_name !== undefined) {
    if (!record.actions.some((a) => a.tool_name === filter.tool_name)) return false;
  }
  return true;
}
