/**
 * WasmAgent AEP (Agent Execution Protocol) span names for policy, MCP, sandbox,
 * verifier, redaction, and dataset lifecycle instrumentation.
 *
 * These supplement the GenAI semconv spans (invoke_agent, agent.step.<N>,
 * execute_tool) already emitted by OtelBridge with names for cross-cutting
 * infrastructure concerns.
 *
 * Usage:
 *   import { AEP_SPAN_NAMES, mcpRequestSpanAttrs } from "@wasmagent/otel-exporter";
 *
 *   const span = tracer.startSpan(AEP_SPAN_NAMES.MCP_REQUEST, {
 *     attributes: mcpRequestSpanAttrs({ server_id: "filesystem", tool_name: "read_file" }),
 *   });
 */

// ── AEP span name constants ───────────────────────────────────────────────────

/**
 * Canonical span names for WasmAgent infrastructure components.
 * Use these as the `name` argument when starting spans so all consumers
 * can filter/aggregate consistently.
 */
export const AEP_SPAN_NAMES = {
  /** An outbound request to an MCP (Model Context Protocol) tool server. */
  MCP_REQUEST: "mcp.request",
  /** A policy / OPA / rule-engine evaluation for an action or resource. */
  POLICY_CHECK: "policy.check",
  /** Code or command execution inside an isolated sandbox kernel. */
  SANDBOX_EXEC: "sandbox.exec",
  /** A verifier (DeterministicVerifier, LLMJudgeVerifier, IFEvalVerifier, …) run. */
  VERIFIER_CHECK: "verifier.check",
  /** PII / secret redaction applied to a trace attribute or output string. */
  REDACTION_APPLY: "redaction.apply",
  /** Export of a training/eval dataset record (ComplianceEvalRecord, rollout, …). */
  DATASET_EXPORT: "dataset.export",
} as const;

/** Union of all AEP span name string literals. */
export type AEPSpanName = (typeof AEP_SPAN_NAMES)[keyof typeof AEP_SPAN_NAMES];

// ── Per-span attribute helpers ────────────────────────────────────────────────

/**
 * Build standard span attributes for an `mcp.request` span.
 *
 * @param opts.server_id   - Stable identifier for the MCP server (e.g. "filesystem", "github").
 * @param opts.tool_name   - Name of the tool being invoked on that server.
 * @param opts.request_id  - Optional correlation ID for the MCP request.
 */
export function mcpRequestSpanAttrs(opts: {
  server_id: string;
  tool_name: string;
  request_id?: string;
}): Record<string, string> {
  const attrs: Record<string, string> = {
    "mcp.server_id": opts.server_id,
    "mcp.tool_name": opts.tool_name,
  };
  if (opts.request_id !== undefined) attrs["mcp.request_id"] = opts.request_id;
  return attrs;
}

/**
 * Build standard span attributes for a `policy.check` span.
 *
 * @param opts.policy_id - Identifier of the policy / ruleset being evaluated.
 * @param opts.subject   - Entity requesting the action (e.g. agent ID, user ID).
 * @param opts.resource  - Resource or action being evaluated.
 * @param opts.decision  - Outcome: "allow" | "deny" | "redact" | any policy-defined value.
 */
export function policyCheckSpanAttrs(opts: {
  policy_id: string;
  subject: string;
  resource: string;
  decision: string;
}): Record<string, string> {
  return {
    "policy.policy_id": opts.policy_id,
    "policy.subject": opts.subject,
    "policy.resource": opts.resource,
    "policy.decision": opts.decision,
  };
}

/**
 * Build standard span attributes for a `sandbox.exec` span.
 *
 * @param opts.kernel_type - Type of sandbox kernel (e.g. "quickjs", "remote", "wasm").
 * @param opts.session_id  - Optional session / kernel instance identifier.
 * @param opts.exit_code   - Optional numeric exit code of the executed command.
 */
export function sandboxExecSpanAttrs(opts: {
  kernel_type: string;
  session_id?: string;
  exit_code?: number;
}): Record<string, string> {
  const attrs: Record<string, string> = {
    "sandbox.kernel_type": opts.kernel_type,
  };
  if (opts.session_id !== undefined) attrs["sandbox.session_id"] = opts.session_id;
  if (opts.exit_code !== undefined) attrs["sandbox.exit_code"] = String(opts.exit_code);
  return attrs;
}

/**
 * Build standard span attributes for a `verifier.check` span.
 *
 * @param opts.verifier_id - Stable name of the verifier class (e.g. "DeterministicVerifier").
 * @param opts.passed      - Whether the verifier check passed.
 * @param opts.score       - Optional numeric score in [0, 1] (for scalar/LLM-judge verifiers).
 */
export function verifierCheckSpanAttrs(opts: {
  verifier_id: string;
  passed: boolean;
  score?: number;
}): Record<string, string> {
  const attrs: Record<string, string> = {
    "verifier.verifier_id": opts.verifier_id,
    "verifier.passed": String(opts.passed),
  };
  if (opts.score !== undefined) attrs["verifier.score"] = String(opts.score);
  return attrs;
}
