/**
 * CloudflareWorkflowEngine — adapter that runs the same WorkflowDefinition
 * on Cloudflare Workflows (durable, hibernating, retry-aware).
 *
 * Same surface as LocalWorkflowEngine: callers get start / resume / sendEvent /
 * getRun, observe via run.events() and run.wait(), and never have to know which
 * runtime is underneath.
 *
 * Architectural shape
 * -------------------
 *   1. The user defines a WorkflowEntrypoint subclass on their side — there is
 *      no way to register a generic class at runtime (CF binds the class name
 *      to the [[workflows]] block in wrangler.toml). We give them
 *      `runWorkflowEntrypoint(this, event, step, def, opts)` so their
 *      Entrypoint.run() body collapses to one line:
 *
 *          export class MyWf extends WorkflowEntrypoint<Env, Params> {
 *            async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
 *              return runWorkflowEntrypoint(this.env, event, step, definition);
 *            }
 *          }
 *
 *   2. CloudflareWorkflowEngine wraps the binding so application code outside
 *      the entrypoint (HTTP handlers, queues) can start/resume/observe runs.
 *
 *   3. Observability is surfaced via the WorkflowStateStore mirror — the
 *      entrypoint persists step events into the same KV-backed store the local
 *      engine uses, so consumers of run.events() see the same event stream
 *      regardless of which engine produced it.
 *
 * Limits we surface up-front (CF as of 2026):
 *   - 25k step ceiling per instance (configurable up to that bound).
 *   - 10 MB per-instance state. Step return values must stay JSON-small.
 *   - 30 min per-step execution. Long work splits across step.do calls.
 */

import {
  KvWorkflowStateStore,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowRunHandle,
  type WorkflowRunRecord,
  type WorkflowStateStore,
  type WorkflowStep,
} from "@wasmagent/core";

// `resolveRefs` isn't currently exported from core's public surface.
// We re-implement the minimal subset we need (string `$<id>` substitution)
// to avoid coupling to the internal scheduler module path.
function resolveRefs(value: unknown, completed: Map<string, unknown>): unknown {
  if (typeof value === "string") {
    const m = /^\$(.+)$/.exec(value);
    if (m && completed.has(m[1] as string)) return completed.get(m[1] as string);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, completed));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveRefs(v, completed);
    }
    return out;
  }
  return value;
}

// ── Cloudflare Workflows minimal type surface ─────────────────────────────
// We declare the parts we touch rather than depending on
// @cloudflare/workers-types directly (so this file can be unit-tested).

// Cloudflare accepts string durations like "5 seconds" or millisecond numbers.
// We accept either; the actual API at runtime is provided by Cloudflare's
// @cloudflare/workers-types — keeping the alias here so consumers reading
// our types see what we expect to pass through.
export type CfWorkflowDuration = string | number;

export interface CfStepConfig {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
}

export interface CfWorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: CfStepConfig, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  sleepUntil(name: string, ts: Date | number): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: string | number }
  ): Promise<{ payload: T }>;
}

export interface CfWorkflowEvent<P = unknown> {
  payload: P;
  timestamp: Date;
  instanceId: string;
}

export interface CfWorkflowInstance {
  id: string;
  status(): Promise<{ status: string; output?: unknown; error?: string }>;
  terminate(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  restart(): Promise<void>;
  sendEvent(event: { type: string; payload: unknown }): Promise<void>;
}

export interface CfWorkflowBinding<Params = unknown> {
  create(opts?: { id?: string; params?: Params }): Promise<CfWorkflowInstance>;
  get(id: string): Promise<CfWorkflowInstance>;
}

// ── Tool resolver — host injects this so steps know how to run -------------

export interface CfToolCallContext {
  step: WorkflowStep;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

/**
 * Resolves a tool call for a CF step. Hosts inject this so the entrypoint
 * doesn't need a ToolRegistry import (which would pull in unbundled deps).
 *
 * The default `runWorkflowEntrypoint` implementation looks up a function in a
 * static map on the entrypoint class — for full-fidelity tool dispatch hosts
 * should pass a ToolRegistry-backed resolver.
 */
export type CfToolResolver = (ctx: CfToolCallContext) => Promise<unknown>;

// ── Entrypoint runner ──────────────────────────────────────────────────────

export interface RunWorkflowEntrypointOptions {
  /** How to dispatch a tool name → result inside CF's step.do. */
  resolveTool: CfToolResolver;
  /** Optional WorkflowStateStore for cross-runtime observability mirroring. */
  store?: WorkflowStateStore;
  /** Override timeout per-step in ms. CF takes string durations; we convert. */
  defaultTimeoutMs?: number;
}

/**
 * Translate a WorkflowDefinition into CF step.do / step.sleep / step.waitForEvent
 * calls inside a WorkflowEntrypoint.run() body. Step results are wired into a
 * completedResults map exactly like LocalWorkflowEngine, including $<refId>
 * substitution into downstream args.
 *
 * NB: this function does NOT itself implement parallelism — CF Workflows have
 * no "wave" primitive. Independent steps still run sequentially in declaration
 * order. For maximum parallelism use the local engine; the CF adapter prioritises
 * durability over throughput. (Documented trade-off; an alternative scheme that
 * Promise.alls a wave of step.do() calls is possible in CF and could be added
 * if benchmarks justify it.)
 */
export async function runWorkflowEntrypoint(
  event: CfWorkflowEvent<unknown>,
  step: CfWorkflowStep,
  def: WorkflowDefinition,
  opts: RunWorkflowEntrypointOptions
): Promise<Record<string, unknown>> {
  const completed = new Map<string, unknown>();
  // We process steps in topological order: a step is "ready" when all its
  // dependencies are present in `completed`. The first time around, that's
  // exactly the steps with no dependencies; each iteration adds more.
  const steps = topoSort(def.steps);

  for (const s of steps) {
    if (s.toolName === "$sleep") {
      const ms = Number((s.args as { ms?: unknown }).ms ?? 0);
      await step.sleep(s.id, ms);
      completed.set(s.id, null);
      await opts.store
        ?.saveStep(event.instanceId, {
          stepId: s.id,
          status: "completed",
          attempts: 1,
          completedAt: Date.now(),
          result: null,
        })
        .catch(() => undefined);
      continue;
    }

    if (s.toolName === "$waitForEvent") {
      const eventType = String((s.args as { type?: unknown }).type ?? "");
      const env = await step.waitForEvent(s.id, {
        type: eventType,
        ...(s.timeoutMs ? { timeout: s.timeoutMs } : {}),
      });
      completed.set(s.id, env.payload);
      await opts.store
        ?.saveStep(event.instanceId, {
          stepId: s.id,
          status: "completed",
          attempts: 1,
          completedAt: Date.now(),
          result: env.payload,
        })
        .catch(() => undefined);
      continue;
    }

    const config: CfStepConfig | undefined = s.retries
      ? {
          retries: {
            limit: s.retries.limit,
            delay: s.retries.delayMs ?? 1000,
            backoff: s.retries.backoff ?? "exponential",
          },
          ...(s.timeoutMs ? { timeout: s.timeoutMs } : {}),
        }
      : s.timeoutMs
        ? { timeout: s.timeoutMs }
        : undefined;

    const result = await (config
      ? step.do(s.id, config, () =>
          opts.resolveTool({
            step: s,
            args: resolveRefs(s.args, completed) as Record<string, unknown>,
          })
        )
      : step.do(s.id, () =>
          opts.resolveTool({
            step: s,
            args: resolveRefs(s.args, completed) as Record<string, unknown>,
          })
        ));
    completed.set(s.id, result);
    await opts.store
      ?.saveStep(event.instanceId, {
        stepId: s.id,
        status: "completed",
        attempts: 1,
        completedAt: Date.now(),
        result,
      })
      .catch(() => undefined);
  }

  return collectOutput(def, completed);
}

function topoSort(steps: WorkflowStep[]): WorkflowStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set<string>();
  const out: WorkflowStep[] = [];
  const visit = (id: string, path: Set<string>): void => {
    if (visited.has(id)) return;
    if (path.has(id)) {
      throw new Error(`Cycle in workflow definition: ${[...path, id].join(" → ")}`);
    }
    path.add(id);
    const s = byId.get(id);
    if (!s) throw new Error(`Unknown step id: ${id}`);
    for (const d of s.dependsOn ?? []) visit(d, path);
    path.delete(id);
    visited.add(id);
    out.push(s);
  };
  for (const s of steps) visit(s.id, new Set());
  return out;
}

function collectOutput(
  def: WorkflowDefinition,
  completed: Map<string, unknown>
): Record<string, unknown> {
  const referenced = new Set<string>();
  for (const s of def.steps) for (const d of s.dependsOn ?? []) referenced.add(d);
  const out: Record<string, unknown> = {};
  for (const s of def.steps) {
    if (!referenced.has(s.id)) out[s.id] = completed.get(s.id);
  }
  return out;
}

// ── Engine façade ──────────────────────────────────────────────────────────

export interface CloudflareWorkflowEngineOptions<Params = unknown> {
  /** The CF Workflow binding from env (env.MY_WORKFLOW). */
  binding: CfWorkflowBinding<Params>;
  /** Optional state store for `run.events()` / `getRun` parity with the local engine. */
  store?: WorkflowStateStore;
}

export class CloudflareWorkflowEngine<Params = unknown> {
  readonly #binding: CfWorkflowBinding<Params>;
  readonly #store: WorkflowStateStore | undefined;

  constructor(opts: CloudflareWorkflowEngineOptions<Params>) {
    this.#binding = opts.binding;
    this.#store = opts.store;
  }

  async start(
    def: WorkflowDefinition,
    opts: { runId?: string; params?: Params } = {}
  ): Promise<WorkflowRunHandle> {
    enforceCfLimits(def);
    const instance = await this.#binding.create({
      ...(opts.runId ? { id: opts.runId } : {}),
      ...(opts.params !== undefined ? { params: opts.params } : {}),
    });
    if (this.#store) {
      await this.#store.saveDefinition(instance.id, def);
      await this.#store.saveRun({
        runId: instance.id,
        workflowId: def.id,
        status: "running",
        params: opts.params,
        createdAt: Date.now(),
      });
    }
    return this.#wrap(instance);
  }

  async resume(runId: string): Promise<WorkflowRunHandle> {
    const instance = await this.#binding.get(runId);
    return this.#wrap(instance);
  }

  async getRun(runId: string): Promise<WorkflowRunRecord | null> {
    if (this.#store) {
      const fromStore = await this.#store.loadRun(runId);
      if (fromStore) return fromStore;
    }
    const instance = await this.#binding.get(runId);
    const status = await instance.status();
    const rec: WorkflowRunRecord = {
      runId,
      workflowId: "",
      status: mapCfStatus(status.status),
      params: undefined,
      createdAt: 0,
    };
    if (status.output !== undefined) rec.output = status.output;
    if (status.error !== undefined) rec.error = status.error;
    return rec;
  }

  async sendEvent(runId: string, type: string, payload: unknown): Promise<void> {
    const instance = await this.#binding.get(runId);
    await instance.sendEvent({ type, payload });
  }

  #wrap(instance: CfWorkflowInstance): WorkflowRunHandle {
    return {
      runId: instance.id,
      cancel: (_reason?: string) => {
        // Fire-and-forget: terminate is async but the WorkflowRunHandle.cancel
        // signature is sync to match the local engine's contract.
        void instance.terminate();
      },
      wait: async () => {
        // Poll status. The store-mirrored record is preferred when present.
        for (;;) {
          const s = await instance.status();
          const mapped = mapCfStatus(s.status);
          if (mapped === "completed" || mapped === "failed" || mapped === "cancelled") {
            const rec: WorkflowRunRecord = {
              runId: instance.id,
              workflowId: "",
              status: mapped,
              params: undefined,
              createdAt: 0,
            };
            if (s.output !== undefined) rec.output = s.output;
            if (s.error !== undefined) rec.error = s.error;
            return rec;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      },
      events: () => this.#events(instance.id),
      sendEvent: async (type, payload) => {
        await instance.sendEvent({ type, payload });
      },
    };
  }

  /**
   * Subscribe to events. Without a store, we fall back to polling `status()`
   * and emit a single terminal event once observed. With a store, we tail the
   * step records (writes from runWorkflowEntrypoint) and emit step_complete.
   */
  async *#events(runId: string): AsyncGenerator<WorkflowEvent> {
    if (!this.#store) {
      // Poll every second.
      const seenStatus = new Set<string>();
      for (;;) {
        const instance = await this.#binding.get(runId);
        const s = await instance.status();
        if (!seenStatus.has(s.status)) {
          seenStatus.add(s.status);
          const mapped = mapCfStatus(s.status);
          if (mapped === "running") yield { type: "run_start", runId };
          if (mapped === "completed") {
            yield { type: "run_complete", runId, output: s.output };
            return;
          }
          if (mapped === "failed" || mapped === "cancelled") {
            yield { type: "run_failed", runId, error: s.error };
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    // Store-backed path.
    const seenSteps = new Set<string>();
    yield { type: "run_start", runId };
    for (;;) {
      const records = await this.#store.listSteps(runId);
      for (const r of records) {
        if (seenSteps.has(r.stepId)) continue;
        if (r.status === "completed") {
          seenSteps.add(r.stepId);
          yield { type: "step_complete", runId, stepId: r.stepId, result: r.result };
        } else if (r.status === "failed") {
          seenSteps.add(r.stepId);
          yield {
            type: "step_failed",
            runId,
            stepId: r.stepId,
            error: r.error,
            willRetry: false,
          };
        }
      }
      const top = await this.#store.loadRun(runId);
      if (
        top &&
        (top.status === "completed" || top.status === "failed" || top.status === "cancelled")
      ) {
        if (top.status === "completed") yield { type: "run_complete", runId, output: top.output };
        else yield { type: "run_failed", runId, error: top.error };
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

function mapCfStatus(s: string): WorkflowRunRecord["status"] {
  switch (s) {
    case "queued":
    case "starting":
      return "queued";
    case "running":
      return "running";
    case "complete":
    case "completed":
      return "completed";
    case "errored":
    case "failed":
      return "failed";
    case "terminated":
    case "cancelled":
      return "cancelled";
    case "paused":
      return "paused";
    default:
      return "running";
  }
}

function enforceCfLimits(def: WorkflowDefinition): void {
  // Cloudflare allows up to 25k steps per instance. We give ourselves headroom
  // to use 1 step.do per WorkflowStep + a small buffer for sleeps/events.
  if (def.steps.length > 24_000) {
    throw new Error(
      `Workflow ${def.id} declares ${def.steps.length} steps, which exceeds the Cloudflare Workflow per-instance limit of 25,000. ` +
        `Split into multiple workflows or run on LocalWorkflowEngine which has no step ceiling.`
    );
  }
}

// Re-export the store for convenience so users can wire it on the CF side too.
export { KvWorkflowStateStore };
