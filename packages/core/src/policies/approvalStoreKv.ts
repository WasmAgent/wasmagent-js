/**
 * Cloudflare KV-backed ApprovalStore — durable cross-request persistence
 * for production deployments on Cloudflare Workers.
 */

import type { ApprovalDecision, ApprovalRequest, ApprovalStore } from "./approvalRequest.js";

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export class CloudflareKvApprovalStore implements ApprovalStore {
  readonly #kv: KVNamespace;
  readonly #prefix: string;

  constructor(kv: KVNamespace, prefix = "approval:") {
    this.#kv = kv;
    this.#prefix = prefix;
  }

  async put(request: ApprovalRequest): Promise<void> {
    await this.#kv.put(this.#key(request.requestId), JSON.stringify(request));
  }

  async update(
    requestId: string,
    decision: ApprovalDecision & { status: "approved" | "rejected" }
  ): Promise<void> {
    const raw = await this.#kv.get(this.#key(requestId));
    if (!raw) throw new Error(`ApprovalRequest ${requestId} not found`);
    const request: ApprovalRequest = JSON.parse(raw);
    request.status = decision.status;
    const d: { decidedAt: string; reviewer: string; reason?: string } = {
      decidedAt: decision.decidedAt,
      reviewer: decision.reviewer,
    };
    if (decision.reason !== undefined) d.reason = decision.reason;
    request.decision = d;
    await this.#kv.put(this.#key(requestId), JSON.stringify(request));
  }

  async get(requestId: string): Promise<ApprovalRequest | null> {
    const raw = await this.#kv.get(this.#key(requestId));
    return raw ? JSON.parse(raw) : null;
  }

  #key(requestId: string): string {
    return `${this.#prefix}${requestId}`;
  }
}
