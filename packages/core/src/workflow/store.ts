/**
 * WorkflowStateStore — persistence layer for WorkflowEngine.
 *
 * The store records, per workflow run:
 *   - the WorkflowRunRecord (top-level status / params / output)
 *   - one WorkflowStepRecord per step, keyed by stepId
 *   - the WorkflowDefinition (so resume() can rebuild without the caller)
 *   - inbound events (for sendEvent/waitForEvent semantics)
 *
 * Key layout (under any KvBackend):
 *   wf:<runId>                — JSON WorkflowRunRecord
 *   wf:<runId>:def            — JSON WorkflowDefinition
 *   wf:<runId>:step:<stepId>  — JSON WorkflowStepRecord
 *   wf:<runId>:event:<seq>    — JSON WorkflowEventEnvelope
 *
 * Naming convention follows the agentkit-js codebase: KvBackend stays the one
 * canonical KV abstraction; WorkflowStateStore composes on top.
 */

import type { KvBackend } from "../checkpoint/index.js";
import type {
  WorkflowDefinition,
  WorkflowEventEnvelope,
  WorkflowRunRecord,
  WorkflowStepRecord,
} from "./types.js";

export interface WorkflowStateStore {
  // Run record
  saveRun(record: WorkflowRunRecord): Promise<void>;
  loadRun(runId: string): Promise<WorkflowRunRecord | null>;
  listRuns(filter?: { status?: WorkflowRunRecord["status"] }): Promise<WorkflowRunRecord[]>;
  deleteRun(runId: string): Promise<void>;

  // Definition (snapshot at start time, so resume is hermetic)
  saveDefinition(runId: string, def: WorkflowDefinition): Promise<void>;
  loadDefinition(runId: string): Promise<WorkflowDefinition | null>;

  // Per-step record
  saveStep(runId: string, record: WorkflowStepRecord): Promise<void>;
  loadStep(runId: string, stepId: string): Promise<WorkflowStepRecord | null>;
  listSteps(runId: string): Promise<WorkflowStepRecord[]>;

  // Inbound events
  appendEvent(envelope: WorkflowEventEnvelope): Promise<void>;
  takeEvent(runId: string, type: string): Promise<WorkflowEventEnvelope | null>;
}

/**
 * KV-backed WorkflowStateStore. Works with any KvBackend that implements list();
 * memory / fs / redis / Cloudflare KV / Durable Object backends all qualify.
 */
export class KvWorkflowStateStore implements WorkflowStateStore {
  readonly #kv: KvBackend;
  /**
   * Captured `list()` reference. The constructor verifies the backend
   * exposes one and throws if not, so storing a non-optional reference
   * here lets the rest of the class call it without `!` assertions
   * (every call site is guaranteed reachable).
   */
  readonly #list: (prefix: string) => Promise<string[]>;
  /** In-memory monotonic event counter per run, persisted lazily. */
  readonly #eventCounter = new Map<string, number>();

  constructor(kv: KvBackend) {
    if (!kv.list) {
      throw new Error(
        "KvWorkflowStateStore requires a KvBackend that supports list() (got a backend without list)."
      );
    }
    this.#kv = kv;
    this.#list = kv.list.bind(kv);
  }

  // ── Run record ────────────────────────────────────────────────────────────
  async saveRun(record: WorkflowRunRecord): Promise<void> {
    await this.#kv.put(this.#runKey(record.runId), JSON.stringify(record));
  }

  async loadRun(runId: string): Promise<WorkflowRunRecord | null> {
    const raw = await this.#kv.get(this.#runKey(runId));
    return raw ? (JSON.parse(raw) as WorkflowRunRecord) : null;
  }

  async listRuns(filter?: { status?: WorkflowRunRecord["status"] }): Promise<WorkflowRunRecord[]> {
    const keys = await this.#list("wf:");
    const records: WorkflowRunRecord[] = [];
    for (const k of keys) {
      // Filter to top-level run records (no further ":" after the runId).
      // Format: wf:<runId>  — exactly two segments separated by ":".
      const parts = k.split(":");
      if (parts.length !== 2) continue;
      const raw = await this.#kv.get(k);
      if (!raw) continue;
      const r = JSON.parse(raw) as WorkflowRunRecord;
      if (filter?.status && r.status !== filter.status) continue;
      records.push(r);
    }
    return records;
  }

  async deleteRun(runId: string): Promise<void> {
    const prefix = `wf:${runId}`;
    const keys = await this.#list(prefix);
    // Delete the run record itself plus all dependents (def, steps, events).
    await Promise.all(keys.map((k) => this.#kv.delete(k)));
    this.#eventCounter.delete(runId);
  }

  // ── Definition ────────────────────────────────────────────────────────────
  async saveDefinition(runId: string, def: WorkflowDefinition): Promise<void> {
    await this.#kv.put(this.#defKey(runId), JSON.stringify(def));
  }

  async loadDefinition(runId: string): Promise<WorkflowDefinition | null> {
    const raw = await this.#kv.get(this.#defKey(runId));
    return raw ? (JSON.parse(raw) as WorkflowDefinition) : null;
  }

  // ── Steps ─────────────────────────────────────────────────────────────────
  async saveStep(runId: string, record: WorkflowStepRecord): Promise<void> {
    await this.#kv.put(this.#stepKey(runId, record.stepId), JSON.stringify(record));
  }

  async loadStep(runId: string, stepId: string): Promise<WorkflowStepRecord | null> {
    const raw = await this.#kv.get(this.#stepKey(runId, stepId));
    return raw ? (JSON.parse(raw) as WorkflowStepRecord) : null;
  }

  async listSteps(runId: string): Promise<WorkflowStepRecord[]> {
    const prefix = `wf:${runId}:step:`;
    const keys = await this.#list(prefix);
    const records: WorkflowStepRecord[] = [];
    for (const k of keys) {
      const raw = await this.#kv.get(k);
      if (raw) records.push(JSON.parse(raw) as WorkflowStepRecord);
    }
    return records;
  }

  // ── Events ────────────────────────────────────────────────────────────────
  async appendEvent(envelope: WorkflowEventEnvelope): Promise<void> {
    const seq = (this.#eventCounter.get(envelope.runId) ?? 0) + 1;
    this.#eventCounter.set(envelope.runId, seq);
    // 12-digit zero-padded — matches EventLog convention; keeps lex ordering.
    const padded = String(seq).padStart(12, "0");
    await this.#kv.put(`wf:${envelope.runId}:event:${padded}`, JSON.stringify(envelope));
  }

  async takeEvent(runId: string, type: string): Promise<WorkflowEventEnvelope | null> {
    const prefix = `wf:${runId}:event:`;
    const keys = (await this.#list(prefix)).sort();
    for (const k of keys) {
      const raw = await this.#kv.get(k);
      if (!raw) continue;
      const env = JSON.parse(raw) as WorkflowEventEnvelope;
      if (env.type === type) {
        // Consume: events are single-take to match step.waitForEvent semantics.
        await this.#kv.delete(k);
        return env;
      }
    }
    return null;
  }

  // ── Key helpers ───────────────────────────────────────────────────────────
  #runKey(runId: string): string {
    return `wf:${runId}`;
  }
  #defKey(runId: string): string {
    return `wf:${runId}:def`;
  }
  #stepKey(runId: string, stepId: string): string {
    return `wf:${runId}:step:${stepId}`;
  }
}

/**
 * Map-backed KvBackend with list() — convenient default for tests and
 * single-process Local engine usage when persistence isn't required.
 */
export class MemoryKvBackend implements KvBackend {
  readonly #store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.#store.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    this.#store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.#store.delete(key);
  }
  async list(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (const k of this.#store.keys()) {
      if (k.startsWith(prefix)) out.push(k);
    }
    return out;
  }
}
