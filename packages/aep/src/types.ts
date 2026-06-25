import { z } from "zod";

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
});
export type BudgetLedger = z.infer<typeof BudgetLedgerSchema>;

// AEPRecord — the top-level Agent Evidence Protocol record
export const AEPRecordSchema = z.object({
  schema_version: z.literal("aep/v0.1"),
  run_id: z.string(),
  trace_id: z.string().optional(),
  parent_trace_id: z.string().nullish(),
  repo_commit: z.string().optional(),
  runtime_version: z.string().optional(),
  model_provider: z.string().optional(),
  model_id: z.string().optional(),
  policy_bundle_digest: z.string().optional(),
  tool_manifest_digest: z.string().optional(),
  input_refs: z.array(InputRefSchema).default([]),
  output_refs: z.array(OutputRefSchema).default([]),
  capability_decisions: z.array(CapabilityDecisionSchema).default([]),
  actions: z.array(ActionEvidenceSchema).default([]),
  verifier_results: z.array(VerifierResultSchema).default([]),
  budget_ledger: BudgetLedgerSchema.optional(),
  created_at_ms: z.number(),
});
export type AEPRecord = z.infer<typeof AEPRecordSchema>;
