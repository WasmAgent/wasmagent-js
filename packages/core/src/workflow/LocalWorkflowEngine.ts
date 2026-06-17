/**
 * LocalWorkflowEngine — the portable, durable workflow runtime.
 *
 * Design contract (every workflow run satisfies all four):
 *
 *   1. OBSERVABLE
 *      - Subscribe to a typed event stream via run.events() — for-await iter.
 *      - Persisted record (loadRun/listRuns) reflects current state at any time.
 *      - Granular events: run_start | step_start | step_complete | step_failed |
 *        step_resource_wait | step_sleeping | step_awaiting_event |
 *        step_resumed_from_checkpoint | run_complete | run_failed | run_cancelled.
 *
 *   2. TERMINABLE
 *      - run.cancel(reason) is honoured at every yield point: between waves,
 *        inside ResourcePool.acquire, inside ToolRegistry.call (signal forwarded),
 *        and during retry backoff sleeps. Run reaches "cancelled" status promptly.
 *
 *   3. RESUMABLE
 *      - Every step transition is persisted before the next step runs.
 *      - engine.resume(runId) reloads the run + def + completed step results,
 *        skips completed steps, retries any "running" steps left over from a
 *        crash, and continues. No replay-from-zero, no double execution.
 *
 *   4. CLEAR ERRORS
 *      - WorkflowError carries: code (machine-readable), runId, stepId, cause,
 *        attempts, retried. Toolkit-friendly: easy to .switch() in callers.
 *      - failed step records persist the full error description (message + code),
 *        so post-mortem from KV/D1 is always possible.
 *
 * Resource semantics:
 *   - Pools default to capacity = Infinity. Serial chains never block.
 *   - Configure pool capacity ONLY for resources that genuinely have a global
 *     ceiling (GPU slots, API quota). Parallel siblings are then gated; serial
 *     chains still take the fast path.
 */

import type { ToolRegistry } from "../tools/ToolRegistry.js";
import { resolveRefs } from "../scheduler/deriveDeps.js";
import { InMemoryResourcePool, type ResourcePool } from "./ResourcePool.js";
import {
  KvWorkflowStateStore,
  MemoryKvBackend,
  type WorkflowStateStore,
} from "./store.js";
import type {
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowRunRecord,
  WorkflowStep,
  WorkflowStepRecord,
} from "./types.js";

// ── Errors ───────────────────────────────────────────────────────────────────

export type WorkflowErrorCode =
  | "step_failed"
  | "step_timeout"
  | "step_unknown_tool"
  | "step_validation"
  | "definition_invalid"
  | "deadlock"
  | "cancelled"
  | "resume_terminal"
  | "resume_missing";

export class WorkflowError extends Error {
  readonly code: WorkflowErrorCode;
  readonly runId: string | undefined;
  readonly stepId: string | undefined;
  readonly attempts: number | undefined;
  override readonly cause: unknown;

  constructor(
    code: WorkflowErrorCode,
    message: string,
    opts: {
      runId?: string;
      stepId?: string;
      attempts?: number;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
    this.runId = opts.runId;
    this.stepId = opts.stepId;
    this.attempts = opts.attempts;
    this.cause = opts.cause;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      runId: this.runId,
      stepId: this.stepId,
      attempts: this.attempts,
      cause: describeError(this.cause),
    };
  }
}

/** Compact, JSON-safe error description used in persisted step records. */
export function describeError(err: unknown): string {
  if (err === null || err === undefined) return "";
  if (err instanceof WorkflowError) return JSON.stringify(err.toJSON());
  if (err instanceof Error) {
    const out: Record<string, unknown> = { name: err.name, message: err.message };
    const errAny = err as unknown as Record<string, unknown>;
    if (errAny.code !== undefined) out.code = errAny.code;
    if (errAny.cause !== undefined) out.cause = describeError(errAny.cause);
    return JSON.stringify(out);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// ── Engine ───────────────────────────────────────────────────────────────────

export interface LocalWorkflowEngineOptions {
  tools: ToolRegistry;
  /** Persistence layer. Defaults to in-memory (suitable for tests; use
   *  KvWorkflowStateStore + a persistent KvBackend for crash-resume). */
  store?: WorkflowStateStore;
  /** Resource pool. Defaults to a fresh InMemoryResourcePool. */
  pool?: ResourcePool;
  /** Polling interval for sleeping / event-awaiting steps (ms). Default: 100. */
  pollIntervalMs?: number;
  /** Hook called every time a run state record is persisted. */
  onPersist?: (runId: string, record: WorkflowRunRecord) => void;
}

export interface StartOptions {
  /** Optional explicit run id; auto-generated if omitted. */
  runId?: string;
  /** Free-form params handed to the run; persisted with the run record. */
  params?: unknown;
}

export interface WorkflowRunHandle {
  readonly runId: string;
  /** Cooperative abort. Steps that pass `signal` to ToolRegistry get cancelled. */
  cancel(reason?: string): void;
  /** Wait for terminal status. Resolves with the final run record. */
  wait(): Promise<WorkflowRunRecord>;
  /** Subscribe to engine event stream. Multi-subscriber. Closes when run is terminal. */
  events(): AsyncGenerator<WorkflowEvent>;
  /** Push an event into the run (unblocks step.waitForEvent semantics). */
  sendEvent(type: string, payload: unknown): Promise<void>;
}

interface Subscriber {
  push: (ev: WorkflowEvent) => void;
  close: () => void;
}

interface RunCtx {
  ac: AbortController;
  terminalResolve: (rec: WorkflowRunRecord) => void;
  subscribers: Set<Subscriber>;
}

export class LocalWorkflowEngine {
  readonly #tools: ToolRegistry;
  readonly #store: WorkflowStateStore;
  readonly #pool: ResourcePool;
  readonly #pollIntervalMs: number;
  readonly #onPersist: ((runId: string, record: WorkflowRunRecord) => void) | undefined;
  readonly #runs = new Map<string, RunCtx>();

  constructor(opts: LocalWorkflowEngineOptions) {
    this.#tools = opts.tools;
    this.#store = opts.store ?? new KvWorkflowStateStore(new MemoryKvBackend());
    this.#pool = opts.pool ?? new InMemoryResourcePool();
    this.#pollIntervalMs = opts.pollIntervalMs ?? 100;
    this.#onPersist = opts.onPersist;
  }

  /** Start a fresh workflow run. Returns immediately; the run executes in the background. */
  async start(def: WorkflowDefinition, opts: StartOptions = {}): Promise<WorkflowRunHandle> {
    validateDefinition(def);
    const runId = opts.runId ?? `wf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const record: WorkflowRunRecord = {
      runId,
      workflowId: def.id,
      status: "queued",
      params: opts.params,
      createdAt: Date.now(),
    };
    await this.#store.saveDefinition(runId, def);
    await this.#persistRun(record);
    return this.#launch(runId, def, record);
  }

  /**
   * Resume a previously-started run after a process restart. The run record,
   * definition, and any completed step results are reloaded; execution
   * continues from the first non-completed step.
   *
   * Steps left in "running" status (the process crashed mid-execution) are
   * treated as not-yet-attempted on resume — they re-run from attempt 1 if
   * idempotent, or fail with a WorkflowError if not idempotent.
   */
  async resume(runId: string): Promise<WorkflowRunHandle> {
    const record = await this.#store.loadRun(runId);
    if (!record) {
      throw new WorkflowError("resume_missing", `No workflow run found for runId: ${runId}`, {
        runId,
      });
    }
    if (record.status === "completed" || record.status === "failed") {
      throw new WorkflowError(
        "resume_terminal",
        `Run ${runId} is already terminal (${record.status})`,
        { runId }
      );
    }
    // "cancelled" runs are explicitly resumable — cancellation is treated as a
    // pause that the operator may later choose to continue from.
    const def = await this.#store.loadDefinition(runId);
    if (!def) {
      throw new WorkflowError(
        "resume_missing",
        `No workflow definition stored for runId: ${runId}`,
        { runId }
      );
    }
    return this.#launch(runId, def, record);
  }

  /** Synchronous accessor — returns the latest persisted run record. */
  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    return this.#store.loadRun(runId);
  }

  /** Push an external event to a running workflow. */
  async sendEvent(runId: string, type: string, payload: unknown): Promise<void> {
    await this.#store.appendEvent({ runId, type, payload, receivedAt: Date.now() });
  }

  // ── Run lifecycle ─────────────────────────────────────────────────────────

  #launch(
    runId: string,
    def: WorkflowDefinition,
    record: WorkflowRunRecord
  ): WorkflowRunHandle {
    const ac = new AbortController();
    let terminalResolve!: (rec: WorkflowRunRecord) => void;
    const terminalPromise = new Promise<WorkflowRunRecord>((resolve) => {
      terminalResolve = resolve;
    });
    const ctx: RunCtx = {
      ac,
      terminalResolve,
      subscribers: new Set(),
    };
    this.#runs.set(runId, ctx);

    // Fire-and-forget; errors are captured into the run record.
    void this.#executeRun(runId, def, record, ac.signal).catch(async (err) => {
      // Distinguish cancellation (operator-initiated, resumable) from genuine failures.
      const isCancelled =
        err instanceof WorkflowError && err.code === "cancelled";
      if (isCancelled) {
        // #executeRun already persisted the cancelled state via #markCancelled
        // when it noticed signal.aborted between waves. If the abort raced
        // an in-flight tool call instead, finalize as cancelled here.
        const current = await this.#store.loadRun(runId);
        if (current && current.status !== "cancelled") {
          const cancelled: WorkflowRunRecord = {
            ...record,
            status: "cancelled",
            error: describeError(err),
            completedAt: Date.now(),
          };
          await this.#persistRun(cancelled);
          this.#emit(runId, { type: "run_failed", runId, error: err });
          this.#finalize(runId, cancelled);
          return;
        }
        // Already finalized by #markCancelled — nothing to do.
        return;
      }
      const wrapped =
        err instanceof WorkflowError
          ? err
          : new WorkflowError("step_failed", `Workflow run failed: ${describeError(err)}`, {
              runId,
              cause: err,
            });
      const final: WorkflowRunRecord = {
        ...record,
        status: "failed",
        error: describeError(wrapped),
        completedAt: Date.now(),
      };
      await this.#persistRun(final);
      this.#emit(runId, { type: "run_failed", runId, error: wrapped });
      this.#finalize(runId, final);
    });

    const handle: WorkflowRunHandle = {
      runId,
      cancel: (reason?: string) => {
        const reasonObj = new WorkflowError(
          "cancelled",
          reason ?? "cancelled",
          { runId }
        );
        ac.abort(reasonObj);
      },
      wait: () => terminalPromise,
      events: () => this.#subscribe(runId),
      sendEvent: (type, payload) => this.sendEvent(runId, type, payload),
    };
    return handle;
  }

  async #executeRun(
    runId: string,
    def: WorkflowDefinition,
    initialRecord: WorkflowRunRecord,
    signal: AbortSignal
  ): Promise<void> {
    const startedRecord: WorkflowRunRecord = {
      ...initialRecord,
      status: "running",
      startedAt: initialRecord.startedAt ?? Date.now(),
    };
    await this.#persistRun(startedRecord);
    this.#emit(runId, { type: "run_start", runId });

    // Reload any persisted step records (resume path).
    const existing = await this.#store.listSteps(runId);
    const stepRecords = new Map<string, WorkflowStepRecord>();
    for (const r of existing) stepRecords.set(r.stepId, r);

    // Working result map fed to resolveRefs / downstream args.
    const completedResults = new Map<string, unknown>();
    for (const r of existing) {
      if (r.status === "completed") {
        completedResults.set(r.stepId, r.result);
        this.#emit(runId, { type: "step_resumed_from_checkpoint", runId, stepId: r.stepId });
      }
    }

    // Build remaining-deps map (after subtracting already-completed steps).
    const remaining = new Map<string, Set<string>>();
    for (const step of def.steps) {
      remaining.set(
        step.id,
        new Set((step.dependsOn ?? []).filter((d) => !completedResults.has(d)))
      );
    }

    while (completedResults.size < def.steps.length) {
      // Cancellation check between waves — most prompt termination point.
      if (signal.aborted) {
        await this.#markCancelled(runId, startedRecord, signal);
        return;
      }

      const ready = def.steps.filter((s) => {
        if (completedResults.has(s.id)) return false;
        if ((remaining.get(s.id)?.size ?? 0) !== 0) return false;
        // Exclude steps already deferred (sleeping or waiting_event); they're
        // resolved by the deferred-step poll branch below, not the wave dispatcher.
        const r = stepRecords.get(s.id);
        if (r && (r.status === "sleeping" || r.status === "waiting_event")) return false;
        return true;
      });

      if (ready.length === 0) {
        // Nothing is ready right now. Two valid reasons: (a) one or more steps
        // are deferred (sleeping or waiting on event) and the rest depend on
        // them; (b) genuine deadlock. To distinguish, check whether at least
        // one stuck step is deferred. If so, poll; otherwise it's a deadlock.
        const stuck = def.steps.filter((s) => !completedResults.has(s.id));
        const deferredSet = new Set<string>(
          stuck
            .map((s) => stepRecords.get(s.id))
            .filter((r): r is WorkflowStepRecord => !!r)
            .filter((r) => r.status === "sleeping" || r.status === "waiting_event")
            .map((r) => r.stepId)
        );
        if (deferredSet.size > 0) {
          await sleep(this.#pollIntervalMs, signal).catch(() => undefined);
          if (signal.aborted) {
            await this.#markCancelled(runId, startedRecord, signal);
            return;
          }
          for (const stepId of deferredSet) {
            const r = stepRecords.get(stepId);
            if (!r) continue;
            if (r.status === "sleeping" && r.wakeAt && Date.now() >= r.wakeAt) {
              const completed: WorkflowStepRecord = {
                ...r,
                status: "completed",
                completedAt: Date.now(),
                result: null,
              };
              stepRecords.set(stepId, completed);
              await this.#store.saveStep(runId, completed);
              completedResults.set(stepId, null);
              this.#unblock(stepId, remaining);
              this.#emit(runId, {
                type: "step_complete",
                runId,
                stepId,
                result: null,
              });
            } else if (r.status === "waiting_event" && r.awaitingEventType) {
              const env = await this.#store.takeEvent(runId, r.awaitingEventType);
              if (env) {
                const completed: WorkflowStepRecord = {
                  ...r,
                  status: "completed",
                  completedAt: Date.now(),
                  result: env.payload,
                };
                stepRecords.set(stepId, completed);
                await this.#store.saveStep(runId, completed);
                completedResults.set(stepId, env.payload);
                this.#unblock(stepId, remaining);
                this.#emit(runId, {
                  type: "step_complete",
                  runId,
                  stepId,
                  result: env.payload,
                });
              }
            }
          }
          continue;
        }
        if (stuck.length > 0) {
          throw new WorkflowError(
            "deadlock",
            `Scheduler deadlock: circular dependency among steps [${stuck
              .map((s) => s.id)
              .join(", ")}]`,
            { runId }
          );
        }
        break;
      }

      // Run all ready steps concurrently. The pool serializes any that
      // compete for the same key — purely serial chains never reach this path
      // with siblings, so they pay no contention cost.
      const settled = await Promise.allSettled(
        ready.map((step) =>
          this.#executeStep(runId, step, stepRecords, completedResults, signal)
        )
      );

      for (const [i, s] of settled.entries()) {
        const step = ready[i]!;
        if (s.status === "fulfilled") {
          const outcome = s.value;
          if (outcome.kind === "completed") {
            completedResults.set(step.id, outcome.result);
            this.#unblock(step.id, remaining);
          }
        } else {
          // Step exhausted retries or hit a non-retryable error.
          this.#cascadeFailure(step.id, def, completedResults, remaining);
          throw s.reason instanceof Error
            ? s.reason
            : new WorkflowError("step_failed", String(s.reason), {
                runId,
                stepId: step.id,
              });
        }
      }
    }

    if (signal.aborted) {
      await this.#markCancelled(runId, startedRecord, signal);
      return;
    }

    const final: WorkflowRunRecord = {
      ...startedRecord,
      status: "completed",
      completedAt: Date.now(),
      output: this.#collectOutput(def, completedResults),
    };
    await this.#persistRun(final);
    this.#emit(runId, { type: "run_complete", runId, output: final.output });
    this.#finalize(runId, final);
  }

  async #markCancelled(
    runId: string,
    startedRecord: WorkflowRunRecord,
    signal: AbortSignal
  ): Promise<void> {
    const reason = signal.reason;
    const cancelled: WorkflowRunRecord = {
      ...startedRecord,
      status: "cancelled",
      completedAt: Date.now(),
      error: describeError(reason),
    };
    await this.#persistRun(cancelled);
    this.#emit(runId, {
      type: "run_failed",
      runId,
      error:
        reason instanceof WorkflowError
          ? reason
          : new WorkflowError("cancelled", "run cancelled", { runId, cause: reason }),
    });
    this.#finalize(runId, cancelled);
  }

  // ── Single-step execution ────────────────────────────────────────────────

  async #executeStep(
    runId: string,
    step: WorkflowStep,
    stepRecords: Map<string, WorkflowStepRecord>,
    completedResults: Map<string, unknown>,
    signal: AbortSignal
  ): Promise<{ kind: "completed"; result: unknown } | { kind: "deferred" }> {
    if (signal.aborted) {
      throw new WorkflowError("cancelled", "step cancelled", {
        runId,
        stepId: step.id,
        cause: signal.reason,
      });
    }

    // Sleep-step semantics: persists wakeAt and returns deferred. The wave
    // loop wakes it when the time passes.
    if (step.toolName === "$sleep") {
      const ms = Number((step.args as { ms?: unknown }).ms ?? 0);
      const wakeAt = Date.now() + ms;
      const record: WorkflowStepRecord = {
        stepId: step.id,
        status: "sleeping",
        attempts: 1,
        startedAt: Date.now(),
        wakeAt,
      };
      stepRecords.set(step.id, record);
      await this.#store.saveStep(runId, record);
      this.#emit(runId, { type: "step_sleeping", runId, stepId: step.id, wakeAt });
      return { kind: "deferred" };
    }

    // Event-await semantics: $waitForEvent blocks until sendEvent matches.
    if (step.toolName === "$waitForEvent") {
      const eventType = String((step.args as { type?: unknown }).type ?? "");
      if (!eventType) {
        throw new WorkflowError(
          "step_validation",
          `step ${step.id}: $waitForEvent requires args.type (string)`,
          { runId, stepId: step.id }
        );
      }
      // Optimistic check — event may already be in the store.
      const existingEvent = await this.#store.takeEvent(runId, eventType);
      if (existingEvent) {
        const record: WorkflowStepRecord = {
          stepId: step.id,
          status: "completed",
          attempts: 1,
          startedAt: Date.now(),
          completedAt: Date.now(),
          result: existingEvent.payload,
        };
        stepRecords.set(step.id, record);
        await this.#store.saveStep(runId, record);
        this.#emit(runId, {
          type: "step_complete",
          runId,
          stepId: step.id,
          result: existingEvent.payload,
        });
        return { kind: "completed", result: existingEvent.payload };
      }
      const record: WorkflowStepRecord = {
        stepId: step.id,
        status: "waiting_event",
        attempts: 1,
        startedAt: Date.now(),
        awaitingEventType: eventType,
      };
      stepRecords.set(step.id, record);
      await this.#store.saveStep(runId, record);
      this.#emit(runId, { type: "step_awaiting_event", runId, stepId: step.id, eventType });
      return { kind: "deferred" };
    }

    // Normal tool step.
    const claims = step.resourceClaims ?? [];
    if (claims.length > 0) {
      this.#emit(runId, { type: "step_resource_wait", runId, stepId: step.id, claims });
    }

    // Acquire resource claims (fast path for sequential / unconstrained).
    const lease = await this.#pool.acquire(claims, { signal }).catch((err: unknown) => {
      throw err instanceof WorkflowError
        ? err
        : new WorkflowError("cancelled", "resource acquire aborted", {
            runId,
            stepId: step.id,
            cause: err,
          });
    });

    try {
      // Resolve $<refId> placeholders against completed step outputs.
      const resolvedArgs = resolveRefs(step.args, completedResults) as Record<string, unknown>;

      const limit = Math.max(1, step.retries?.limit ?? 1);
      const idempotent = step.idempotent ?? true;
      let lastError: unknown;
      for (let attempt = 1; attempt <= limit; attempt++) {
        if (signal.aborted) {
          throw new WorkflowError("cancelled", "step cancelled mid-retry", {
            runId,
            stepId: step.id,
            attempts: attempt - 1,
            cause: signal.reason,
          });
        }
        const record: WorkflowStepRecord = {
          stepId: step.id,
          status: "running",
          attempts: attempt,
          startedAt: Date.now(),
        };
        stepRecords.set(step.id, record);
        await this.#store.saveStep(runId, record);
        this.#emit(runId, { type: "step_start", runId, stepId: step.id, attempt });

        try {
          const result = await this.#callWithTimeout(step, {
            toolName: step.toolName,
            args: resolvedArgs,
            callId: step.id,
            signal,
          });
          if (result.error) {
            lastError = new WorkflowError(
              result.error.code === "validation_error" ? "step_validation" : "step_failed",
              `${step.id}: ${result.error.message}`,
              { runId, stepId: step.id, attempts: attempt }
            );
            if (!idempotent || attempt >= limit) {
              const failed: WorkflowStepRecord = {
                ...record,
                status: "failed",
                attempts: attempt,
                completedAt: Date.now(),
                error: describeError(lastError),
              };
              stepRecords.set(step.id, failed);
              await this.#store.saveStep(runId, failed);
              this.#emit(runId, {
                type: "step_failed",
                runId,
                stepId: step.id,
                error: lastError,
                willRetry: false,
              });
              throw lastError;
            }
            this.#emit(runId, {
              type: "step_failed",
              runId,
              stepId: step.id,
              error: lastError,
              willRetry: true,
            });
            await sleep(this.#backoffMs(step, attempt), signal).catch(() => undefined);
            continue;
          }
          const completed: WorkflowStepRecord = {
            ...record,
            status: "completed",
            attempts: attempt,
            completedAt: Date.now(),
            result: result.output,
          };
          stepRecords.set(step.id, completed);
          await this.#store.saveStep(runId, completed);
          this.#emit(runId, {
            type: "step_complete",
            runId,
            stepId: step.id,
            result: result.output,
          });
          return { kind: "completed", result: result.output };
        } catch (err) {
          // Propagate cancellation immediately.
          if (err instanceof WorkflowError && err.code === "cancelled") throw err;
          lastError = err;
          if (!idempotent || attempt >= limit) {
            const wrapped =
              err instanceof WorkflowError
                ? err
                : new WorkflowError("step_failed", `${step.id}: ${describeError(err)}`, {
                    runId,
                    stepId: step.id,
                    attempts: attempt,
                    cause: err,
                  });
            const failed: WorkflowStepRecord = {
              ...record,
              status: "failed",
              attempts: attempt,
              completedAt: Date.now(),
              error: describeError(wrapped),
            };
            stepRecords.set(step.id, failed);
            await this.#store.saveStep(runId, failed);
            this.#emit(runId, {
              type: "step_failed",
              runId,
              stepId: step.id,
              error: wrapped,
              willRetry: false,
            });
            throw wrapped;
          }
          this.#emit(runId, {
            type: "step_failed",
            runId,
            stepId: step.id,
            error: err,
            willRetry: true,
          });
          await sleep(this.#backoffMs(step, attempt), signal).catch(() => undefined);
        }
      }
      throw (
        lastError ??
        new WorkflowError("step_failed", `step ${step.id}: exhausted retries`, {
          runId,
          stepId: step.id,
          attempts: limit,
        })
      );
    } finally {
      lease.release();
    }
  }

  async #callWithTimeout(
    step: WorkflowStep,
    call: { toolName: string; args: Record<string, unknown>; callId: string; signal: AbortSignal }
  ): Promise<{ output: unknown; error?: { code: string; message: string } }> {
    if (!step.timeoutMs || step.timeoutMs <= 0) {
      return await this.#tools.call(call, step.extraCapabilities);
    }
    // Compose a child signal: aborts on either parent abort or timeout.
    const localAc = new AbortController();
    const onParentAbort = () => localAc.abort(call.signal.reason);
    if (call.signal.aborted) localAc.abort(call.signal.reason);
    else call.signal.addEventListener("abort", onParentAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutErr = new WorkflowError(
      "step_timeout",
      `step ${step.id} timed out after ${step.timeoutMs}ms`,
      { stepId: step.id }
    );
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        localAc.abort(timeoutErr);
        // Race the timeout with the call so a callback that ignores `signal`
        // still surfaces the timeout to the engine. The orphaned tool promise
        // continues running in the background — that's the cost of running
        // non-cancellable user code.
        reject(timeoutErr);
      }, step.timeoutMs);
    });
    try {
      return (await Promise.race([
        this.#tools.call({ ...call, signal: localAc.signal }, step.extraCapabilities),
        timeoutPromise,
      ])) as { output: unknown; error?: { code: string; message: string } };
    } finally {
      if (timer) clearTimeout(timer);
      call.signal.removeEventListener("abort", onParentAbort);
    }
  }

  #backoffMs(step: WorkflowStep, attempt: number): number {
    const base = step.retries?.delayMs ?? 1000;
    const strategy = step.retries?.backoff ?? "exponential";
    switch (strategy) {
      case "constant":
        return base;
      case "linear":
        return base * attempt;
      case "exponential":
      default:
        return base * 2 ** (attempt - 1);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  #unblock(completedId: string, remaining: Map<string, Set<string>>): void {
    for (const deps of remaining.values()) deps.delete(completedId);
  }

  #cascadeFailure(
    failedId: string,
    def: WorkflowDefinition,
    completedResults: Map<string, unknown>,
    remaining: Map<string, Set<string>>
  ): void {
    completedResults.set(failedId, undefined);
    for (const step of def.steps) {
      if (completedResults.has(step.id)) continue;
      if ((step.dependsOn ?? []).includes(failedId)) {
        this.#cascadeFailure(step.id, def, completedResults, remaining);
      }
    }
    this.#unblock(failedId, remaining);
  }

  /** Output of a workflow run = result of every leaf step (no descendants). */
  #collectOutput(
    def: WorkflowDefinition,
    completedResults: Map<string, unknown>
  ): Record<string, unknown> {
    const referenced = new Set<string>();
    for (const s of def.steps) for (const d of s.dependsOn ?? []) referenced.add(d);
    const out: Record<string, unknown> = {};
    for (const s of def.steps) {
      if (!referenced.has(s.id)) out[s.id] = completedResults.get(s.id);
    }
    return out;
  }

  async #persistRun(record: WorkflowRunRecord): Promise<void> {
    await this.#store.saveRun(record);
    this.#onPersist?.(record.runId, record);
  }

  #emit(runId: string, ev: WorkflowEvent): void {
    const ctx = this.#runs.get(runId);
    if (!ctx) return;
    for (const sub of ctx.subscribers) sub.push(ev);
  }

  #finalize(runId: string, rec: WorkflowRunRecord): void {
    const ctx = this.#runs.get(runId);
    if (!ctx) return;
    ctx.terminalResolve(rec);
    for (const sub of ctx.subscribers) sub.close();
    ctx.subscribers.clear();
    this.#runs.delete(runId);
  }

  async *#subscribe(runId: string): AsyncGenerator<WorkflowEvent> {
    // Snapshot the run record up-front so post-terminal subscribers don't hang.
    const ctx = this.#runs.get(runId);
    if (!ctx) {
      // Run already terminal — emit a single synthetic terminal event so the
      // consumer can observe completion without blocking forever.
      const final = await this.#store.loadRun(runId);
      if (final?.status === "completed") {
        yield { type: "run_complete", runId, output: final.output };
      } else if (final?.status === "failed" || final?.status === "cancelled") {
        yield {
          type: "run_failed",
          runId,
          error: new WorkflowError("step_failed", final.error ?? "run terminal", { runId }),
        };
      }
      return;
    }
    const queue: WorkflowEvent[] = [];
    let waiter: ((v: void) => void) | null = null;
    let closed = false;
    const sub: Subscriber = {
      push: (ev) => {
        queue.push(ev);
        if (waiter) {
          const w = waiter;
          waiter = null;
          w();
        }
      },
      close: () => {
        closed = true;
        if (waiter) {
          const w = waiter;
          waiter = null;
          w();
        }
      },
    };
    ctx.subscribers.add(sub);
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          waiter = resolve;
        });
      }
    } finally {
      ctx.subscribers.delete(sub);
    }
  }
}

// ── Standalone helpers ───────────────────────────────────────────────────────

function validateDefinition(def: WorkflowDefinition): void {
  const ids = new Set<string>();
  for (const s of def.steps) {
    if (ids.has(s.id))
      throw new WorkflowError("definition_invalid", `Duplicate step id: ${s.id}`);
    ids.add(s.id);
  }
  for (const s of def.steps) {
    for (const d of s.dependsOn ?? []) {
      if (!ids.has(d))
        throw new WorkflowError(
          "definition_invalid",
          `Step ${s.id} depends on unknown step ${d}`
        );
    }
  }
  // Cycle detection (DFS with three-colouring).
  const colour = new Map<string, 0 | 1 | 2>();
  const visit = (id: string, path: string[]): void => {
    const c = colour.get(id) ?? 0;
    if (c === 1) {
      throw new WorkflowError(
        "definition_invalid",
        `Cycle detected at step ${id} (path: ${[...path, id].join(" → ")})`
      );
    }
    if (c === 2) return;
    colour.set(id, 1);
    const step = def.steps.find((s) => s.id === id);
    for (const d of step?.dependsOn ?? []) visit(d, [...path, id]);
    colour.set(id, 2);
  };
  for (const s of def.steps) visit(s.id, []);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
