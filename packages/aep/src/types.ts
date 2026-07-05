import { z } from "zod";

// PermissionGate — signals that the platform's permission layer already handled authorization
export const PermissionGateSchema = z.object({
  decision: z.enum(["approved", "denied", "auto_approved"]),
  gate: z.string(),
  reason: z.string().optional(),
});
export type PermissionGate = z.infer<typeof PermissionGateSchema>;

// CapabilityDecision — one allow/deny decision for a tool invocation
export const CapabilityDecisionSchema = z.object({
  capability: z.string(),
  subject: z.string(),
  resource: z.string(),
  decision: z.enum(["allow", "deny", "ask_user", "dry_run"]),
  reason_code: z.string().optional(),
});
export type CapabilityDecision = z.infer<typeof CapabilityDecisionSchema>;

// ActionEvidence — evidence bundle for one state-changing action
export const ActionEvidenceSchema = z.object({
  action_id: z.string(),
  tool_name: z.string(),
  state_changing: z.boolean(),
  precondition_digest: z.string().optional(),
  result_digest: z.string().optional(),
  evidence_refs: z.array(z.string()).default([]),
  capability_decision: CapabilityDecisionSchema.optional(),
  timestamp_ms: z.number(),
  // v0.2 causal chain fields
  parent_action_id: z.string().optional(),
  causal_chain_id: z.string().optional(),
  // v0.2 tool/server provenance
  tool_descriptor_digest: z.string().optional(),
  server_card_digest: z.string().optional(),
  // v0.2 scope & approval
  scope_lease_id: z.string().optional(),
  approval_context_hash: z.string().optional(),
  // v0.2 taint tracking
  input_taint_labels: z.array(z.string()).optional(),
  output_taint_labels: z.array(z.string()).optional(),
  // v0.2 memory provenance
  memory_read_refs: z.array(z.string()).optional(),
  memory_write_refs: z.array(z.string()).optional(),
  // v0.2 state digests
  pre_state_digest: z.string().optional(),
  post_state_digest: z.string().optional(),
  // v0.2 permission gate — signals platform-level authorization
  permission_gate: PermissionGateSchema.optional(),
});
export type ActionEvidence = z.infer<typeof ActionEvidenceSchema>;

// InputRef / OutputRef — digested references to inputs and outputs
export const InputRefSchema = z.object({
  uri: z.string(),
  digest: z.string().optional(),
  taint_labels: z.array(z.string()).default([]),
});
export type InputRef = z.infer<typeof InputRefSchema>;

export const OutputRefSchema = z.object({
  uri: z.string(),
  digest: z.string().optional(),
  redaction_profile: z.string().optional(),
});
export type OutputRef = z.infer<typeof OutputRefSchema>;

// VerifierResult — one verifier's verdict
export const VerifierResultSchema = z.object({
  verifier_id: z.string(),
  passed: z.boolean(),
  score: z.number().optional(),
  claim_ids: z.array(z.string()).default([]),
});
export type VerifierResult = z.infer<typeof VerifierResultSchema>;

// BudgetEntry — one budget dimension
export const BudgetEntrySchema = z.object({
  limit: z.number().optional(),
  spent: z.number(),
});
export type BudgetEntry = z.infer<typeof BudgetEntrySchema>;

// BudgetLedger — per-run budget consumption
export const BudgetLedgerSchema = z.object({
  token_budget: BudgetEntrySchema.optional(),
  latency_budget: z.object({ limit_ms: z.number().optional(), actual_ms: z.number() }).optional(),
  tool_budget: BudgetEntrySchema.optional(),
  risk_budget: BudgetEntrySchema.optional(),
  retry_budget: BudgetEntrySchema.optional(),
  human_approval_budget: BudgetEntrySchema.optional(),
});
export type BudgetLedger = z.infer<typeof BudgetLedgerSchema>;

// RunContext — execution environment and delegation metadata (v0.2)
export const RunContextSchema = z.object({
  agent_id: z.string().optional(),
  agent_version: z.string().optional(),
  subagent_id: z.string().optional(),
  delegation_chain: z.array(z.string()).default([]),
  environment_digest: z.string().optional(),
  dependency_lock_digest: z.string().optional(),
  // v0.3 session / conversation fields (#22)
  session_id: z.string().optional(),
  turn_index: z.number().int().min(0).optional(),
});
export type RunContext = z.infer<typeof RunContextSchema>;

// AEPRecord — the top-level Agent Evidence Protocol record
export const AEPRecordSchema = z.object({
  schema_version: z.enum(["aep/v0.1", "aep/v0.2"]),
  run_id: z.string(),
  user_id: z.string().optional(),
  subject_id: z.string().optional(),
  trace_id: z.string().optional(),
  parent_trace_id: z.string().nullish(),
  repo_commit: z.string().optional(),
  runtime_version: z.string().optional(),
  model_provider: z.string().optional(),
  model_id: z.string().optional(),
  policy_bundle_digest: z.string().optional(),
  tool_manifest_digest: z.string().optional(),
  mcp_server_card_digest: z.string().nullish(),
  input_refs: z.array(InputRefSchema).default([]),
  output_refs: z.array(OutputRefSchema).default([]),
  capability_decisions: z.array(CapabilityDecisionSchema).default([]),
  actions: z.array(ActionEvidenceSchema).default([]),
  verifier_results: z.array(VerifierResultSchema).default([]),
  budget_ledger: BudgetLedgerSchema.optional(),
  created_at_ms: z.number(),
  run_context: RunContextSchema.optional(),
  signature: z.object({
    alg: z.literal("ed25519"),
    key_id: z.string(),
    sig: z.string(),
  }),
});
export type AEPRecord = z.infer<typeof AEPRecordSchema>;
