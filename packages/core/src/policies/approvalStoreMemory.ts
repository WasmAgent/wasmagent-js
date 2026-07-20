/**
 * In-memory ApprovalStore — suitable for tests and single-process dev servers.
 */

import type { ApprovalDecision, ApprovalRequest, ApprovalStore } from "./approvalRequest.js";

export class InMemoryApprovalStore implements ApprovalStore {
  readonly #store = new Map<string, ApprovalRequest>();

  async put(request: ApprovalRequest): Promise<void> {
    if (typeof request !== "object" || request === null || !request.requestId) {
      throw new TypeError(
        "InMemoryApprovalStore.put() expects a single ApprovalRequest object with a requestId field"
      );
    }
    this.#store.set(request.requestId, { ...request });
  }

  async update(
    requestId: string,
    decision: ApprovalDecision & { status: "approved" | "rejected" }
  ): Promise<void> {
    const existing = this.#store.get(requestId);
    if (!existing) throw new Error(`ApprovalRequest ${requestId} not found`);
    existing.status = decision.status;
    const d: { decidedAt: string; reviewer: string; reason?: string } = {
      decidedAt: decision.decidedAt,
      reviewer: decision.reviewer,
    };
    if (decision.reason !== undefined) d.reason = decision.reason;
    existing.decision = d;
  }

  async get(requestId: string): Promise<ApprovalRequest | null> {
    return this.#store.get(requestId) ?? null;
  }

  /** Test helper — get all stored requests. */
  getAll(): ApprovalRequest[] {
    return [...this.#store.values()];
  }
}
