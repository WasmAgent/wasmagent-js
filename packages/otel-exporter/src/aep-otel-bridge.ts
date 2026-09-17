/**
 * AEP <-> OTel bidirectional mapping.
 *
 * Converts between AEP ActionEvidence records and OpenTelemetry GenAI spans
 * so that:
 *   - AEP evidence bundles can be exported to any OTel collector
 *   - OTel GenAI traces can be imported as AEP evidence for audit/training
 *
 * Strategy: read legacy, emit current.
 *   - Emission follows the current OTel GenAI semantic conventions: span name
 *     `execute_tool {gen_ai.tool.name}`, `gen_ai.operation.name = execute_tool`,
 *     `gen_ai.tool.name`, plus `gen_ai.tool.call.id` when a call identity exists.
 *   - Import recognizes both the current convention and the legacy WasmAgent
 *     shape (span name "tool.call" + `aep.tool_name`).
 *
 * Honesty rules (missing ≠ false):
 *   - A span that does not carry `aep.state_changing` imports with that field
 *     ABSENT, never `false`. Absence means "unknown", not "known non-mutating".
 *   - A `capability_decision` is only constructed when decision, capability,
 *     subject and resource are ALL present; partial policy information is
 *     dropped (recorded as a loss) rather than padded with empty strings.
 *
 * Trust boundary: an OTel span imported into an AEP-shaped object is NOT
 * authenticated AEP evidence. It does not inherit DSSE authenticity, is not
 * signed by the conversion, and does not establish AEP semantic completeness.
 * Create canonical AEP records through the normal emitter path instead, and
 * mark them as derived from OTel telemetry.
 *
 * Attribute convention: current `gen_ai.*` semconv core attrs; AEP-specific
 * extension data keeps the custom "aep.*" namespace.
 */
import { AEP_SPAN_NAMES, GENAI_SEMCONV } from "./aep-span-names.js";

// Minimal span attribute value type (mirrors OTel SDK)
type AttributeValue = string | number | boolean | string[] | number[] | boolean[];

export interface OtelSpanLike {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTimeUnixNano: number;
  endTimeUnixNano: number;
  attributes: Record<string, AttributeValue>;
  status: { code: number; message?: string };
}

export interface AepActionLike {
  action_id: string;
  tool_name: string;
  /**
   * Whether the tool mutated external state. Optional on import: third-party
   * OTel spans usually cannot assert it, and `missing` must never be
   * imported as `false`.
   */
  state_changing?: boolean;
  timestamp_ms: number;
  parent_action_id?: string;
  causal_chain_id?: string;
  scope_lease_id?: string;
  input_taint_labels?: string[];
  output_taint_labels?: string[];
  result_digest?: string;
  pre_state_digest?: string;
  post_state_digest?: string;
  capability_decision?: {
    decision: string;
    reason_code?: string;
    capability: string;
    subject: string;
    resource: string;
  };
}

/**
 * Convert an AEP ActionEvidence record to an OTel-compatible span object.
 *
 * Maps:
 *   action_id          -> spanId (first 16 chars, padded); gen_ai.tool.call.id
 *   parent_action_id   -> parentSpanId
 *   tool_name          -> name="execute_tool <tool>", attributes.gen_ai.tool.name
 *   timestamp_ms       -> startTimeUnixNano
 *   state_changing     -> attributes.aep.state_changing (AEP extension)
 *   capability_decision.decision -> attributes.aep.policy_decision
 *   input_taint_labels -> attributes.aep.input_taint_labels
 *   result_digest      -> attributes.aep.result_digest
 */
export function aepActionToOtelSpan(
  action: AepActionLike,
  runId: string,
  traceId?: string
): OtelSpanLike {
  const spanId = action.action_id.slice(0, 16).padEnd(16, "0");
  const parentSpanId = action.parent_action_id?.slice(0, 16).padEnd(16, "0");
  const resolvedTraceId = (traceId ?? runId).slice(0, 32).padEnd(32, "0");
  const startNano = action.timestamp_ms * 1_000_000;

  const attrs: Record<string, AttributeValue> = {
    [GENAI_SEMCONV.ATTR_OPERATION_NAME]: GENAI_SEMCONV.OP_EXECUTE_TOOL,
    [GENAI_SEMCONV.ATTR_TOOL_NAME]: action.tool_name,
    [GENAI_SEMCONV.ATTR_TOOL_CALL_ID]: action.action_id,
    "aep.tool_name": action.tool_name,
    "aep.run_id": runId,
  };
  if (action.state_changing !== undefined) {
    attrs["aep.state_changing"] = action.state_changing;
  }

  if (action.causal_chain_id) attrs["aep.causal_chain_id"] = action.causal_chain_id;
  if (action.scope_lease_id) attrs["aep.scope_lease_id"] = action.scope_lease_id;
  if (action.result_digest) attrs["aep.result_digest"] = action.result_digest;
  if (action.pre_state_digest) attrs["aep.pre_state_digest"] = action.pre_state_digest;
  if (action.post_state_digest) attrs["aep.post_state_digest"] = action.post_state_digest;
  if (action.input_taint_labels?.length) {
    attrs["aep.input_taint_labels"] = action.input_taint_labels;
  }
  if (action.output_taint_labels?.length) {
    attrs["aep.output_taint_labels"] = action.output_taint_labels;
  }
  if (action.capability_decision) {
    attrs["aep.policy_decision"] = action.capability_decision.decision;
    attrs["aep.policy_capability"] = action.capability_decision.capability;
    if (action.capability_decision.reason_code) {
      attrs["aep.policy_reason_code"] = action.capability_decision.reason_code;
    }
  }

  return {
    // Current GenAI semconv recommended shape: "execute_tool <tool name>".
    name: `${GENAI_SEMCONV.SPAN_EXECUTE_TOOL} ${action.tool_name}`,
    traceId: resolvedTraceId,
    spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    startTimeUnixNano: startNano,
    endTimeUnixNano: startNano + 1_000_000,
    attributes: attrs,
    status: { code: 1 },
  };
}

/** Legacy WasmAgent span shape: name "tool.call" with `aep.tool_name`. */
function isLegacyToolCallSpan(span: OtelSpanLike): boolean {
  return span.name === AEP_SPAN_NAMES.TOOL_CALL && span.attributes["aep.tool_name"] !== undefined;
}

/** Current GenAI shape: gen_ai.operation.name=execute_tool + gen_ai.tool.name. */
function isCurrentExecuteToolSpan(span: OtelSpanLike): boolean {
  return (
    span.attributes[GENAI_SEMCONV.ATTR_OPERATION_NAME] === GENAI_SEMCONV.OP_EXECUTE_TOOL &&
    span.attributes[GENAI_SEMCONV.ATTR_TOOL_NAME] !== undefined
  );
}

/**
 * Convert an OTel span back to an AEP ActionEvidence-compatible object.
 *
 * Recognized inputs:
 *   - Current GenAI: `gen_ai.operation.name = "execute_tool"` + `gen_ai.tool.name`
 *     (matches both `execute_tool` and `execute_tool <tool>` span names, with or
 *     without any `aep.*` extension attributes).
 *   - Legacy WasmAgent: span name "tool.call" + `aep.tool_name`.
 * Anything else (e.g. chat completions) returns null — this bridge imports
 * tool-execution evidence only.
 *
 * Lossy by design: fields the span cannot assert are left ABSENT, never
 * invented. The result is imported telemetry, not authenticated AEP evidence
 * (see the trust boundary in the module docstring).
 */
export function otelSpanToAepAction(span: OtelSpanLike): AepActionLike | null {
  const current = isCurrentExecuteToolSpan(span);
  const legacy = isLegacyToolCallSpan(span);
  if (!current && !legacy) return null;

  const toolName = String(
    span.attributes[GENAI_SEMCONV.ATTR_TOOL_NAME] ?? span.attributes["aep.tool_name"]
  );
  const actionId = span.spanId;
  const parentActionId = span.parentSpanId ? String(span.parentSpanId) : undefined;

  const action: AepActionLike = {
    action_id: actionId,
    tool_name: toolName,
    // Honest absence: when the span carries no state-changing assertion
    // (typical for third-party spans), the field stays undefined — "unknown".
    ...(span.attributes["aep.state_changing"] !== undefined
      ? { state_changing: Boolean(span.attributes["aep.state_changing"]) }
      : {}),
    timestamp_ms: Math.floor(span.startTimeUnixNano / 1_000_000),
    ...(parentActionId !== undefined ? { parent_action_id: parentActionId } : {}),
  };

  const causalId = span.attributes["aep.causal_chain_id"];
  if (causalId) action.causal_chain_id = String(causalId);
  const leaseId = span.attributes["aep.scope_lease_id"];
  if (leaseId) action.scope_lease_id = String(leaseId);
  const resultDigest = span.attributes["aep.result_digest"];
  if (resultDigest) action.result_digest = String(resultDigest);
  const preDigest = span.attributes["aep.pre_state_digest"];
  if (preDigest) action.pre_state_digest = String(preDigest);
  const postDigest = span.attributes["aep.post_state_digest"];
  if (postDigest) action.post_state_digest = String(postDigest);

  const taintIn = span.attributes["aep.input_taint_labels"];
  if (Array.isArray(taintIn)) action.input_taint_labels = taintIn as string[];
  const taintOut = span.attributes["aep.output_taint_labels"];
  if (Array.isArray(taintOut)) action.output_taint_labels = taintOut as string[];

  // A full capability_decision requires decision + capability + subject +
  // resource. Third-party spans have no policy vocabulary, so a partial
  // `aep.policy_*` set is dropped rather than padded into a plausible-looking
  // decision with empty strings.
  const decision = span.attributes["aep.policy_decision"];
  const capability = span.attributes["aep.policy_capability"];
  const subject = span.attributes["aep.policy_subject"];
  const resource = span.attributes["aep.policy_resource"];
  if (
    decision !== undefined &&
    capability !== undefined &&
    subject !== undefined &&
    resource !== undefined
  ) {
    action.capability_decision = {
      decision: String(decision),
      capability: String(capability),
      subject: String(subject),
      resource: String(resource),
      ...(span.attributes["aep.policy_reason_code"]
        ? { reason_code: String(span.attributes["aep.policy_reason_code"]) }
        : {}),
    };
  }

  return action;
}
