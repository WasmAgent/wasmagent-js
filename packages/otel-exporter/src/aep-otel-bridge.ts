/**
 * AEP <-> OTel bidirectional mapping.
 *
 * Converts between AEP ActionEvidence records and OpenTelemetry GenAI spans
 * so that:
 *   - AEP evidence bundles can be exported to any OTel collector
 *   - OTel GenAI traces can be imported as AEP evidence for audit/training
 *
 * Span name convention: AEP_SPAN_NAMES.TOOL_CALL ("tool.call") per aep-span-names.ts
 * Attribute convention: GENAI_SEMCONV where applicable, custom "aep.*" namespace otherwise.
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
  state_changing: boolean;
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
 *   action_id          -> spanId (first 16 chars, padded)
 *   parent_action_id   -> parentSpanId
 *   tool_name          -> name="tool.call", attributes.aep.tool_name
 *   timestamp_ms       -> startTimeUnixNano
 *   state_changing     -> attributes.aep.state_changing
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
    [GENAI_SEMCONV.ATTR_OPERATION_NAME]: "tool_call",
    "aep.tool_name": action.tool_name,
    "aep.state_changing": action.state_changing,
    "aep.run_id": runId,
  };

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
    name: AEP_SPAN_NAMES.TOOL_CALL,
    traceId: resolvedTraceId,
    spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    startTimeUnixNano: startNano,
    endTimeUnixNano: startNano + 1_000_000,
    attributes: attrs,
    status: { code: 1 },
  };
}

/**
 * Convert an OTel span back to an AEP ActionEvidence-compatible object.
 *
 * Only spans with name "tool.call" are convertible; others return null.
 */
export function otelSpanToAepAction(span: OtelSpanLike): AepActionLike | null {
  if (span.name !== AEP_SPAN_NAMES.TOOL_CALL) return null;

  const toolName = String(span.attributes["aep.tool_name"] ?? "unknown");
  const actionId = span.spanId;
  const parentActionId = span.parentSpanId ? String(span.parentSpanId) : undefined;

  const action: AepActionLike = {
    action_id: actionId,
    tool_name: toolName,
    state_changing: Boolean(span.attributes["aep.state_changing"]),
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

  const decision = span.attributes["aep.policy_decision"];
  if (decision) {
    action.capability_decision = {
      decision: String(decision),
      capability: String(span.attributes["aep.policy_capability"] ?? ""),
      subject: "",
      resource: "",
      ...(span.attributes["aep.policy_reason_code"]
        ? { reason_code: String(span.attributes["aep.policy_reason_code"]) }
        : {}),
    };
  }

  return action;
}
