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

function matchesFilter(record: AEPRecord, filter: EvidenceStoreQuery): boolean {
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
