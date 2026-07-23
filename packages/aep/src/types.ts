import { z } from "zod";

// RecordingMode — tri-state indicating how much content to capture in an AEP record
export type RecordingMode = "validation" | "delta" | "full";

// SideEffectClass — classifies the side-effect of an action (v0.3)
export type SideEffectClass =
  | "read"
  | "mutate-local"
  | "mutate-external"
  | "network-egress"
  | "unknown";

// ApprovalMode — how the capability decision was reached (v0.3)
export type ApprovalMode =
  | "one-shot-payload"
  | "bounded-lease"
  | "policy-allow-with-receipt"
  | "policy-deny-with-evidence"
  | "re-approval-on-drift"
  | "none";

// DenyReasonClass — reason category for a deny decision (v0.3)
export type DenyReasonClass =
  | "tool-identity"
  | "argument"
  | "tainted-input"
  | "resource-scope"
  | "missing-delegation"
  | "policy-rule"
  | "other";

// StateDigestKind — identifies the kind of state being digested (v0.3)
export type StateDigestKind =
  | "git-tree"
  | "sandbox-fs"
  | "db-rowset"
  | "browser-dom"
  | "kv-snapshot"
  | "memory-bag"
  | "other";

// PermissionGate — signals that the platform's permission layer already handled authorization
export const PermissionGateSchema = z.object({
  decision: z.enum(["approved", "denied", "auto_approved"]),
  gate: z.string(),
  reason: z.string().optional(),
});
export type PermissionGate = z.infer<typeof PermissionGateSchema>;

// ArgumentDrift — detected drift between approved and observed arguments (v0.3)
export const ArgumentDriftSchema = z.object({
  detected: z.boolean(),
  approved_args_digest: z.string(),
  observed_args_digest: z.string(),
  resolution: z.enum(["matched", "denied"]),
});
export type ArgumentDrift = z.infer<typeof ArgumentDriftSchema>;

// ApprovalExtension — namespace-scoped extension for approval decisions (v0.3)
export const ApprovalExtensionSchema = z.object({
  namespace: z.string(),
  mode: z.string(),
  evidence_digest: z.string(),
});
export type ApprovalExtension = z.infer<typeof ApprovalExtensionSchema>;

// CapabilityDecision — one allow/deny decision for a tool invocation
export const CapabilityDecisionSchema = z.object({
  capability: z.string(),
  subject: z.string(),
  resource: z.string(),
  decision: z.enum(["allow", "deny", "ask_user", "dry_run"]),
  reason_code: z.string().optional(),
  // v0.3 approval fields
  approval_mode: z
    .enum([
      "one-shot-payload",
      "bounded-lease",
      "policy-allow-with-receipt",
      "policy-deny-with-evidence",
      "re-approval-on-drift",
      "none",
    ])
    .default("none"),
  approval_extension: ApprovalExtensionSchema.optional(),
  deny_reason_class: z
    .enum([
      "tool-identity",
      "argument",
      "tainted-input",
      "resource-scope",
      "missing-delegation",
      "policy-rule",
      "other",
    ])
    .optional(),
});
export type CapabilityDecision = z.infer<typeof CapabilityDecisionSchema>;

// ActionEvidence — evidence bundle for one state-changing action
export const ActionEvidenceSchema = z.object({
  action_id: z.string(),
  tool_name: z.string(),
  state_changing: z.boolean(),
  precondition_digest: z.string().optional(),
  result_digest: z.string().optional(),
  // Tool call outcome capture (#163): outcome label, process exit code,
  // and SHA-256 digest of the tool call arguments.
  outcome: z.string().optional(),
  exit_code: z.number().int().optional(),
  arguments_digest: z.string().optional(),
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
  // v0.3 recording mode — controls evidence capture depth
  recording_mode: z.enum(["validation", "delta", "full"]).default("validation"),
  delta_ref: z.string().optional(),
  // v0.3 side effect classification
  side_effect_class: z
    .enum(["read", "mutate-local", "mutate-external", "network-egress", "unknown"])
    .default("unknown"),
  // v0.3 state digest metadata
  state_digest_kind: z
    .enum([
      "git-tree",
      "sandbox-fs",
      "db-rowset",
      "browser-dom",
      "kv-snapshot",
      "memory-bag",
      "other",
    ])
    .optional(),
  state_digest_coverage: z.record(z.unknown()).optional(),
  // v0.3 argument drift detection
  argument_drift: ArgumentDriftSchema.optional(),
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
  schema_version: z.enum(["aep/v0.1", "aep/v0.2", "aep/v0.3", "aep/v0.4"]),
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
  prev_record_hash: z.string().nullish(),
  run_context: RunContextSchema.optional(),
  // v0.3 run-level side effect maximum
  run_side_effect_class_max: z
    .enum(["read", "mutate-local", "mutate-external", "network-egress", "unknown"])
    .optional(),
  // v0.3 external timestamp proof (optional, attached by AEPTimestamper)
  timestamp_proof: z
    .object({
      timestamp: z.string(),
      authority: z.string(),
      proof: z.string(),
      logIndex: z.number().optional(),
    })
    .optional(),
  // v0.4: DSSE envelope (when present, `signature` is derived from envelope for backward compat)
  dsse_envelope: z
    .object({
      payloadType: z.string(),
      payload: z.string(),
      signatures: z.array(
        z.object({
          keyid: z.string(),
          sig: z.string(),
        })
      ),
    })
    .optional(),
  signature: z.object({
    alg: z.literal("ed25519"),
    key_id: z.string(),
    sig: z.string(),
  }),
});
export type AEPRecord = z.infer<typeof AEPRecordSchema>;
