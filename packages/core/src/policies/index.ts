// ─────────────────────────────────────────────────────────────────────────────
// @wasmagent/core — policies barrel
// ─────────────────────────────────────────────────────────────────────────────

export type {
  ApprovalPolicyOptions,
  ApprovalRule,
  WriteOpKind,
} from "./approvalPolicy.js";
export { ApprovalPolicy, applyApprovalPolicy, PolicyPresets } from "./approvalPolicy.js";

export type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStore,
} from "./approvalRequest.js";
export { CloudflareKvApprovalStore } from "./approvalStoreKv.js";
export { InMemoryApprovalStore } from "./approvalStoreMemory.js";
