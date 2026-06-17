/**
 * Workflow types — durable, resumable DAG execution.
 *
 * A WorkflowDefinition is a serializable description of work: nodes (steps)
 * + dependencies + per-step retry/timeout/resource policy. The same definition
 * runs identically on:
 *
 *   - LocalWorkflowEngine (Node/Bun/Edge, any KvBackend for persistence)
 *   - CloudflareWorkflowEngine (translates to native Cloudflare Workflows)
 *
 * Design goals:
 *   - Portability: zero Cloudflare-specific types in the public surface.
 *   - Resumability: every completed step is persisted by id; resume() picks
 *     up from the last completed step set, no replay-from-zero.
 *   - Resource awareness: steps declare resourceClaims; the engine gates
 *     concurrent execution via ResourcePool (separate concern, see ResourcePool.ts).
 *   - Composability: builds on the existing IRNode/Scheduler model rather than
 *     parallel structures.
 */

/** A step's lifecycle state, persisted in the WorkflowStateStore. */
export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "sleeping"
  | "waiting_event";

/**
 * A claim on a named resource pool. Engine acquires `weight` units from the
 * pool keyed by `key` before starting the step; releases when the step
 * completes or fails. weight defaults to 1.
 *
 * Examples:
 *   { key: "openai", weight: 1 }       // 1 slot of openai pool
 *   { key: "gpu", weight: 2 }          // 2 GPU slots (e.g. multi-GPU job)
 *   { key: "fs:./outputs", weight: 1 } // exclusive write to a file path
 */
export interface ResourceClaim {
  key: string;
  weight?: number;
}

/** Retry policy for an individual step (mirrors CF Workflows StepConfig.retries). */
export interface StepRetryPolicy {
  /** Total attempts (including the first). Default: 1 (no retry). */
  limit: number;
  /** Initial delay between attempts, in ms. Default: 1000. */
  delayMs?: number;
  /** Backoff strategy. Default: "exponential". */
  backoff?: "constant" | "linear" | "exponential";
}

/** A single workflow step (node) — extends scheduler IRNode semantics. */
export interface WorkflowStep {
  /** Unique-within-workflow id. Used as persistence key + reference target. */
  id: string;
  /** Tool to invoke via ToolRegistry (resolved by the host). */
  toolName: string;
  /** Tool args. May contain `$<stepId>` references resolved from prior outputs. */
  args: Record<string, unknown>;
  /** Step ids that must complete before this step can run. */
  dependsOn: string[];
  /**
   * Safe for speculative pre-execution.
   *  - true: pure read; engine may launch ahead of write nodes (C3 semantics).
   *  - false: side-effectful; serialized after speculative reads complete.
   * Default: false.
   */
  readOnly?: boolean;
  /**
   * Safe to retry on failure without external coordination. If false, the
   * engine will not retry even if `retries.limit > 1`. Default: true.
   */
  idempotent?: boolean;
  /** Capabilities granted for this step's tool call. */
  extraCapabilities?: string[];
  /** Resource claims acquired before execution, released after. */
  resourceClaims?: ResourceClaim[];
  /** Retry policy. */
  retries?: StepRetryPolicy;
  /** Per-attempt timeout in ms. 0 / undefined = no timeout. */
  timeoutMs?: number;
}

/** A workflow's complete declaration. Serializable to/from JSON. */
export interface WorkflowDefinition {
  /** Stable workflow type id, used to look up the definition on resume. */
  id: string;
  /** Human-readable label. */
  name?: string;
  /** Step DAG. */
  steps: WorkflowStep[];
  /** Optional version tag for migration. */
  version?: string;
}

/** Lifecycle states of a workflow run. */
export type WorkflowRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "paused";

/** Persisted record of a step's execution. */
export interface WorkflowStepRecord {
  stepId: string;
  status: WorkflowStepStatus;
  /** Tool result on success. JSON-serializable. */
  result?: unknown;
  /** Error message on failure. Engine stringifies non-Error rejections. */
  error?: string;
  /** Number of attempts made so far (1 = first try). */
  attempts: number;
  startedAt?: number;
  completedAt?: number;
  /** Wake time for sleeping steps (ms since epoch). */
  wakeAt?: number;
  /** Event type the step is awaiting. */
  awaitingEventType?: string;
}

/** Top-level state of a workflow run. */
export interface WorkflowRunRecord {
  /** Run id (per-instance, not the workflow definition id). */
  runId: string;
  /** WorkflowDefinition.id — used to re-fetch the definition on resume. */
  workflowId: string;
  status: WorkflowRunStatus;
  /** Params passed to engine.start(). */
  params: unknown;
  /** Final output if status="completed". */
  output?: unknown;
  /** Top-level error if status="failed". */
  error?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

/** External event delivered via engine.sendEvent(). */
export interface WorkflowEventEnvelope {
  runId: string;
  type: string;
  payload: unknown;
  receivedAt: number;
}

// ── Engine event stream ──────────────────────────────────────────────────────

export type WorkflowEvent =
  | { type: "run_start"; runId: string }
  | { type: "run_complete"; runId: string; output: unknown }
  | { type: "run_failed"; runId: string; error: unknown }
  | { type: "step_start"; runId: string; stepId: string; attempt: number }
  | { type: "step_complete"; runId: string; stepId: string; result: unknown }
  | { type: "step_failed"; runId: string; stepId: string; error: unknown; willRetry: boolean }
  | { type: "step_speculative"; runId: string; stepId: string }
  | {
      type: "step_resource_wait";
      runId: string;
      stepId: string;
      claims: ResourceClaim[];
    }
  | { type: "step_sleeping"; runId: string; stepId: string; wakeAt: number }
  | { type: "step_awaiting_event"; runId: string; stepId: string; eventType: string }
  | { type: "step_resumed_from_checkpoint"; runId: string; stepId: string };
