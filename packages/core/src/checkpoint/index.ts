/**
 * Checkpointer — durable workflow support (B4).
 *
 * Enables saving agent state after each step and resuming from a checkpoint
 * after process restarts or human-in-the-loop pauses.
 *
 * Interface is storage-agnostic. Two built-in implementations:
 *  - InMemoryCheckpointer (tests, single-process)
 *  - (future) KV-backed checkpointer for Cloudflare Workers / Redis
 *
 * Human-in-the-loop flow:
 *   1. Agent emits "await_human_input" event with a promptId.
 *   2. Caller saves checkpoint, suspends, waits for human response.
 *   3. Caller calls checkpointer.resume(traceId, { promptId, response }).
 *   4. Agent loop detects pending response and continues.
 */

import type { Step } from "../types/events.js";

// ── Snapshot ──────────────────────────────────────────────────────────────────

export interface AgentSnapshot {
  /** Agent's traceId at the time of the checkpoint. */
  traceId: string;
  /** Original task string. */
  task: string;
  /** Step history serialised from MessageAssembler. */
  history: Step[];
  /** Current step index when checkpoint was taken. */
  stepIndex: number;
  /** Timestamp when snapshot was created. */
  savedAtMs: number;
  /** Pending human input prompt, if paused for human-in-the-loop. */
  pendingHumanInput?: { promptId: string; prompt: string };
  /** Human response, if provided. */
  humanResponse?: { promptId: string; response: string };
}

// ── Checkpointer interface ────────────────────────────────────────────────────

export interface Checkpointer {
  /**
   * Persist a snapshot.
   * @param traceId  Agent's traceId (used as the primary key).
   * @param snapshot Full snapshot to persist.
   */
  save(traceId: string, snapshot: AgentSnapshot): Promise<void>;

  /**
   * Load the latest snapshot for a traceId, or null if none exists.
   */
  load(traceId: string): Promise<AgentSnapshot | null>;

  /**
   * Delete a checkpoint (e.g. after successful completion).
   */
  delete(traceId: string): Promise<void>;

  /**
   * Provide a human response to a paused run.
   * The next call to load() will return the snapshot with humanResponse set.
   */
  respond(traceId: string, promptId: string, response: string): Promise<void>;
}

// ── InMemoryCheckpointer ──────────────────────────────────────────────────────

export class InMemoryCheckpointer implements Checkpointer {
  readonly #store = new Map<string, AgentSnapshot>();

  async save(traceId: string, snapshot: AgentSnapshot): Promise<void> {
    this.#store.set(traceId, { ...snapshot });
  }

  async load(traceId: string): Promise<AgentSnapshot | null> {
    return this.#store.get(traceId) ?? null;
  }

  async delete(traceId: string): Promise<void> {
    this.#store.delete(traceId);
  }

  async respond(traceId: string, promptId: string, response: string): Promise<void> {
    const snapshot = this.#store.get(traceId);
    if (!snapshot) throw new Error(`No checkpoint found for traceId: ${traceId}`);
    if (snapshot.pendingHumanInput?.promptId !== promptId) {
      throw new Error(`promptId mismatch: expected ${snapshot.pendingHumanInput?.promptId}, got ${promptId}`);
    }
    snapshot.humanResponse = { promptId, response };
  }

  get size(): number { return this.#store.size; }
}

// ── KvCheckpointer ────────────────────────────────────────────────────────────

/**
 * Generic KV-backed checkpointer compatible with any KV store that exposes
 * get/put/delete (Cloudflare KV, Upstash Redis, etc.).
 *
 * Usage with Cloudflare Workers KV:
 *   const checkpointer = new KvCheckpointer(env.MY_KV_NAMESPACE);
 *
 * Usage with a plain Map (testing):
 *   const kv = new Map<string, string>();
 *   const checkpointer = new KvCheckpointer({
 *     get: async (k) => kv.get(k) ?? null,
 *     put: async (k, v) => { kv.set(k, v); },
 *     delete: async (k) => { kv.delete(k); },
 *   });
 */
export interface KvBackend {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class KvCheckpointer implements Checkpointer {
  readonly #kv: KvBackend;

  constructor(kv: KvBackend) {
    this.#kv = kv;
  }

  async save(traceId: string, snapshot: AgentSnapshot): Promise<void> {
    await this.#kv.put(traceId, JSON.stringify(snapshot));
  }

  async load(traceId: string): Promise<AgentSnapshot | null> {
    const raw = await this.#kv.get(traceId);
    if (!raw) return null;
    return JSON.parse(raw) as AgentSnapshot;
  }

  async delete(traceId: string): Promise<void> {
    await this.#kv.delete(traceId);
  }

  async respond(traceId: string, promptId: string, response: string): Promise<void> {
    const snapshot = await this.load(traceId);
    if (!snapshot) throw new Error(`No checkpoint found for traceId: ${traceId}`);
    if (snapshot.pendingHumanInput?.promptId !== promptId) {
      throw new Error(`promptId mismatch: expected ${snapshot.pendingHumanInput?.promptId}, got ${promptId}`);
    }
    snapshot.humanResponse = { promptId, response };
    await this.save(traceId, snapshot);
  }
}

// ── CheckpointableAgent wrapper ───────────────────────────────────────────────

import type { AgentEvent, UserMessageStep } from "../types/events.js";
import type { MessageAssembler } from "../memory/MessageAssembler.js";

export interface CheckpointableAgentOptions {
  checkpointer: Checkpointer;
  /** How many steps to run between checkpoints. Default: 1 (checkpoint every step). */
  checkpointInterval?: number;
}

/**
 * Wraps an agent generator with checkpoint-after-step and resume support.
 *
 * Usage:
 *   const checkpointer = new InMemoryCheckpointer();
 *   const wrapper = new CheckpointableRun({ checkpointer }, agent.assembler);
 *   for await (const ev of wrapper.run(agent.run(task), task, traceId)) { ... }
 *
 * To resume after restart:
 *   const snapshot = await checkpointer.load(traceId);
 *   // Restore agent assembler from snapshot.history, then:
 *   for await (const ev of wrapper.run(agent.run(task, traceId), task, traceId)) { ... }
 */
export class CheckpointableRun {
  readonly #checkpointer: Checkpointer;
  readonly #interval: number;
  readonly #assembler: MessageAssembler;

  constructor(opts: CheckpointableAgentOptions, assembler: MessageAssembler) {
    this.#checkpointer = opts.checkpointer;
    this.#interval = opts.checkpointInterval ?? 1;
    this.#assembler = assembler;
  }

  async *run(
    source: AsyncGenerator<AgentEvent>,
    task: string,
    traceId: string
  ): AsyncGenerator<AgentEvent> {
    let lastCheckpointStep = 0;

    for await (const ev of source) {
      yield ev;

      // Checkpoint after each step boundary.
      if (ev.event === "step_start") {
        const stepIndex = (ev as { data: { step: number } }).data.step;
        if (stepIndex - lastCheckpointStep >= this.#interval) {
          lastCheckpointStep = stepIndex;
          await this.#checkpointer.save(traceId, {
            traceId,
            task,
            history: this.#getHistory(),
            stepIndex,
            savedAtMs: ev.timestampMs,
          });
        }
      }

      // Delete checkpoint on successful completion.
      if (ev.event === "final_answer") {
        await this.#checkpointer.delete(traceId);
      }
    }
  }

  #getHistory(): Step[] {
    return this.#assembler.steps;
  }
}

/**
 * Restore a MessageAssembler from a snapshot's history.
 * Call this before passing the agent to CheckpointableRun.resume().
 */
export function restoreFromSnapshot(
  snapshot: AgentSnapshot,
  assembler: MessageAssembler
): void {
  assembler.reset();
  // Re-add seed user message first, then all subsequent history steps (including
  // any follow-up user_message steps from multi-turn human-in-the-loop runs).
  const seedStep: UserMessageStep = { type: "user_message", content: snapshot.task };
  assembler.addStep(seedStep);
  for (const step of snapshot.history) {
    // Skip the initial user_message (already re-added as seedStep above).
    if (step.type === "user_message" && step.content === snapshot.task) continue;
    assembler.addStep(step);
  }
}
