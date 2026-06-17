/**
 * Workflow — durable, resumable, resource-aware DAG execution.
 *
 * Public surface:
 *   - WorkflowDefinition / WorkflowStep / ResourceClaim — declarative DAG.
 *   - LocalWorkflowEngine — runs anywhere JS runs; persists via any KvBackend.
 *   - InMemoryResourcePool — capacity-bounded gating for parallel steps.
 *   - KvWorkflowStateStore + MemoryKvBackend — built-in persistence options.
 *
 * The Cloudflare adapter (CloudflareWorkflowEngine) lives in
 * @agentkit-js/cloudflare-worker and implements the same WorkflowEngine
 * surface against Cloudflare's WorkflowEntrypoint primitives.
 */

export type {
  ResourceClaim,
  StepRetryPolicy,
  WorkflowDefinition,
  WorkflowEvent,
  WorkflowEventEnvelope,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepRecord,
  WorkflowStepStatus,
} from "./types.js";

export type { WorkflowStateStore } from "./store.js";
export { KvWorkflowStateStore, MemoryKvBackend } from "./store.js";

export type {
  AcquireOptions,
  PoolConfig,
  ResourceLease,
  ResourcePool,
} from "./ResourcePool.js";
export { InMemoryResourcePool } from "./ResourcePool.js";

export type {
  LocalWorkflowEngineOptions,
  StartOptions,
  WorkflowRunHandle,
} from "./LocalWorkflowEngine.js";
export { LocalWorkflowEngine } from "./LocalWorkflowEngine.js";
