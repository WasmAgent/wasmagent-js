/**
 * ApprovalRequest — cross-agent approval emission substrate.
 *
 * Defines the core types and store interface for persisting approval requests
 * that arise when an agent's write-class tool invocation triggers the approval
 * policy gate. Requests flow:
 *
 *   agent emits ApprovalRequest -> store.put() -> reviewer decides ->
 *   store.update() -> agent resumes or aborts.
 */

// ── Core types ──────────────────────────────────────────────────────────────

export interface ApprovalRequest {
  requestId: string;
  agentId: string;
  runId: string;
  toolName: string;
  op: string;
  path?: string;
  contextSummary?: string;
  /** ISO 8601 timestamp of when the request was created. */
  requestedAt: string;
  status: "pending" | "approved" | "rejected";
  decision?: ApprovalDecision;
}

export interface ApprovalDecision {
  decidedAt: string;
  reviewer: string;
  reason?: string;
}

// ── Store interface ─────────────────────────────────────────────────────────

export interface ApprovalStore {
  /** Persist a new approval request. */
  put(request: ApprovalRequest): Promise<void>;
  /** Record a reviewer decision on an existing request. */
  update(
    requestId: string,
    decision: ApprovalDecision & { status: "approved" | "rejected" }
  ): Promise<void>;
  /** Retrieve a request by id. Returns null if not found. */
  get(requestId: string): Promise<ApprovalRequest | null>;
}
