/**
 * Checkpointer — durable workflow support (B4).
 *
 * Enables saving agent state after each step and resuming from a checkpoint
 * after process restarts or human-in-the-loop pauses.
 *
 * Interface is storage-agnostic. Built-in implementations:
 *  - InMemoryCheckpointer (tests, single-process)
 *  - KvCheckpointer (any KvBackend — paired with adapters in core, the
 *    Cloudflare Workers package, and Redis transports below)
 *
 * Human-in-the-loop flow:
 *   1. Agent emits "await_human_input" event with a promptId.
 *   2. Caller saves checkpoint, suspends, waits for human response.
 *   3. Caller calls checkpointer.resume(traceId, { promptId, response }).
 *   4. Agent loop detects pending response and continues.
 */

import type { AgentRunConfig, Step } from "../types/events.js";

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
  /**
   * SI-8 — Agent configuration at checkpoint time.
   * Allows callers to reconstruct the same agent on resume without
   * re-specifying options from external storage.
   */
  agentConfig?: AgentRunConfig;
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
      throw new Error(
        `promptId mismatch: expected ${snapshot.pendingHumanInput?.promptId}, got ${promptId}`
      );
    }
    snapshot.humanResponse = { promptId, response };
  }

  get size(): number {
    return this.#store.size;
  }
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
/**
 * Single canonical KV contract used by checkpointing, StructuredMemory,
 * MemoryTool, and KvBackendVectorStore.
 *
 * Implementations: `MapKvBackend` (in-memory, includes list), `CloudflareKvBackend`,
 * `RedisKvBackend`, `DurableObjectKvBackend`. Adapters wrapping foreign stores
 * (e.g. Cloudflare Workers KV's `KVNamespace`) should implement this interface
 * directly — do NOT introduce a parallel KV abstraction.
 *
 * `list(prefix)` is OPTIONAL because some legacy backends (raw key/value caches)
 * cannot enumerate. Consumers that need enumeration must check for it
 * (e.g. `if (!backend.list) throw new Error("list required")`).
 */
export interface KvBackend {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Optional: list all keys with the given prefix. Required by
   * StructuredMemory.query/decay/count and KvBackendVectorStore index loads.
   */
  list?(prefix: string): Promise<string[]>;
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
      throw new Error(
        `promptId mismatch: expected ${snapshot.pendingHumanInput?.promptId}, got ${promptId}`
      );
    }
    snapshot.humanResponse = { promptId, response };
    await this.save(traceId, snapshot);
  }
}

// ── CheckpointableAgent wrapper ───────────────────────────────────────────────

import type { MessageAssembler } from "../memory/MessageAssembler.js";
import type { AgentEvent, UserMessageStep } from "../types/events.js";

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

      // A3 — human-in-the-loop suspend: persist a snapshot tagged with the
      // pending prompt and stop iterating. The parent process can now exit
      // (Cloudflare Worker recycle, container restart, audit-wait of hours/
      // days) and the run is fully resumable from the snapshot. The agent
      // generator is *abandoned*, not awaited — that is intentional, since
      // resume happens in a fresh process via `restoreFromSnapshot()`.
      if (ev.event === "await_human_input") {
        const stepIndex = (ev as { data: { step: number } }).data.step;
        const prompt = (ev as { data: { prompt: string; promptId: string } }).data;
        await this.#checkpointer.save(traceId, {
          traceId,
          task,
          history: this.#getHistory(),
          stepIndex,
          savedAtMs: ev.timestampMs,
          pendingHumanInput: { promptId: prompt.promptId, prompt: prompt.prompt },
        });
        return;
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
 *
 * Returns the stored `agentConfig` (if any) so callers can reconstruct
 * the agent with the same options without separate storage.
 */
export function restoreFromSnapshot(
  snapshot: AgentSnapshot,
  assembler: MessageAssembler
): AgentRunConfig | undefined {
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
  return snapshot.agentConfig;
}

/**
 * A3 — Stateless HITL resume. Submits a human response for a paused run.
 *
 * 1. The caller (typically an HTTP `POST /resume` handler) verifies that
 *    a snapshot exists for `traceId` and is in the awaiting state.
 * 2. The response is persisted via {@link Checkpointer.respond}.
 * 3. The function returns `true` if the snapshot was successfully marked
 *    ready for resume, or `false` if the trace doesn't exist / isn't paused.
 *
 * The actual agent re-spawn (load snapshot → restore assembler → continue)
 * is performed by the host application (worker route, queue worker, etc.)
 * — this helper does NOT itself spin up an agent, because doing so would
 * require knowledge of the model/tools/kernel that core cannot have.
 */
export async function resumeFromHuman(
  checkpointer: Checkpointer,
  traceId: string,
  promptId: string,
  response: string
): Promise<boolean> {
  const snap = await checkpointer.load(traceId);
  if (!snap) return false;
  if (!snap.pendingHumanInput) return false;
  if (snap.pendingHumanInput.promptId !== promptId) return false;
  await checkpointer.respond(traceId, promptId, response);
  return true;
}

/**
 * Inject a human response into a restored assembler as a user_message step,
 * so the next agent invocation sees the response in its message history.
 *
 * Call after {@link restoreFromSnapshot} when continuing a paused run.
 */
export function applyHumanResponse(snapshot: AgentSnapshot, assembler: MessageAssembler): void {
  const resp = snapshot.humanResponse;
  if (!resp) return;
  // Inject as a plain user_message — the assembler will render it as
  // `{ role: "user", content: response }` on the next build().
  assembler.addStep({ type: "user_message", content: resp.response });
}
