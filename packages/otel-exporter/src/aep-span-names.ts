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
  /** A top-level agent execution run. */
  AGENT_RUN: "agent.run",
  /** An LLM generation call (single inference request). */
  LLM_GENERATE: "llm.generate",
  /** A single tool invocation within an agent step. */
  TOOL_CALL: "tool.call",
} as const;

/** Union of all AEP span name string literals. */
export type AEPSpanName = (typeof AEP_SPAN_NAMES)[keyof typeof AEP_SPAN_NAMES];

// ── OpenTelemetry GenAI semantic conventions ──────────────────────────────────

/**
 * The version of the OTel GenAI semantic conventions this package conforms to.
 * Tracks the semconv spec version (not the OTel SDK version).
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
export const GENAI_SEMCONV_VERSION = "1.28.0";

/**
 * OpenTelemetry GenAI semantic convention constants.
 *
 * Reference: https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * Usage:
 *   import { GENAI_SEMCONV } from "@wasmagent/otel-exporter";
 *
 *   span.setAttribute(GENAI_SEMCONV.ATTR_INPUT_TOKENS, 512);
 *   span.addEvent(GENAI_SEMCONV.EVENT_USER_MSG, { "gen_ai.prompt": "..." });
 */
export const GENAI_SEMCONV = {
  /** Span name for LLM chat completions per OTel GenAI semconv */
  SPAN_CHAT: "gen_ai.chat",
  /** Span name for embedding calls */
  SPAN_EMBEDDINGS: "gen_ai.embeddings",
  /** Attribute: gen_ai.operation.name must be "chat" for chat completions */
  ATTR_OPERATION_NAME: "gen_ai.operation.name",
  /** Attribute: actual model used in response */
  ATTR_RESPONSE_MODEL: "gen_ai.response.model",
  /** Attribute: input token count */
  ATTR_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  /** Attribute: output token count */
  ATTR_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  /** Attribute: total token count */
  ATTR_TOTAL_TOKENS: "gen_ai.usage.total_tokens",
  /** Event name: system message */
  EVENT_SYSTEM_MSG: "gen_ai.system.message",
  /** Event name: user message */
  EVENT_USER_MSG: "gen_ai.user.message",
  /** Event name: assistant response */
  EVENT_ASSISTANT_MSG: "gen_ai.assistant.message",
  /** Event name: tool result */
  EVENT_TOOL_MSG: "gen_ai.tool.message",
  /** Event name: model response choice */
  EVENT_CHOICE: "gen_ai.choice",
} as const;

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

/**
 * Build standard span attributes for an `agent.run` span.
 *
 * @param opts.agent_name - Stable name of the agent class or instance.
 * @param opts.run_id     - Optional unique run identifier.
 * @param opts.model_id   - Optional model used for this run.
 */
export function agentRunSpanAttrs(opts: {
  agent_name: string;
  run_id?: string;
  model_id?: string;
}): Record<string, string> {
  const attrs: Record<string, string> = { "agent.name": opts.agent_name };
  if (opts.run_id !== undefined) attrs["agent.run_id"] = opts.run_id;
  if (opts.model_id !== undefined) attrs["agent.model_id"] = opts.model_id;
  return attrs;
}

/**
 * Build standard span attributes for an `llm.generate` span.
 *
 * @param opts.model_id      - Model identifier used for the generation.
 * @param opts.provider      - Optional provider name (e.g. "anthropic", "openai").
 * @param opts.input_tokens  - Optional count of input tokens consumed.
 * @param opts.output_tokens - Optional count of output tokens produced.
 */
export function llmGenerateSpanAttrs(opts: {
  model_id: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
}): Record<string, string> {
  const attrs: Record<string, string> = { "llm.model_id": opts.model_id };
  if (opts.provider !== undefined) attrs["llm.provider"] = opts.provider;
  if (opts.input_tokens !== undefined) attrs["llm.input_tokens"] = String(opts.input_tokens);
  if (opts.output_tokens !== undefined) attrs["llm.output_tokens"] = String(opts.output_tokens);
  return attrs;
}

/**
 * Build standard span attributes for a `tool.call` span.
 *
 * @param opts.tool_name      - Name of the tool being invoked.
 * @param opts.tool_type      - Optional category of tool (e.g. "bash", "mcp", "builtin").
 * @param opts.state_changing - Whether the tool mutates external state.
 */
export function toolCallSpanAttrs(opts: {
  tool_name: string;
  tool_type?: string;
  state_changing?: boolean;
}): Record<string, string> {
  const attrs: Record<string, string> = { "tool.name": opts.tool_name };
  if (opts.tool_type !== undefined) attrs["tool.type"] = opts.tool_type;
  if (opts.state_changing !== undefined) attrs["tool.state_changing"] = String(opts.state_changing);
  return attrs;
}
