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

// IF-07c — structural policy port between the agent loop and an external
// policy engine (e.g. the MCP firewall's provenance gate). Core maintains no
// taint ledger; see policyGateway.ts for the design boundary.
export type {
  PolicyCallDecision,
  PolicyCallRequest,
  PolicyGatewayFactory,
  PolicyResultObservation,
  RunPolicyGateway,
} from "./policyGateway.js";
export { PolicyGatedRegistry, resolvePolicyGateway } from "./policyGateway.js";
