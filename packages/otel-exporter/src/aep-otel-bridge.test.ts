/**
 * Interop matrix for the AEP <-> OTel bridge reverse path (OTEL-IMPORT-01..08).
 *
 * OTEL-IMPORT-01  current execute_tool + gen_ai.tool.name -> import
 * OTEL-IMPORT-02  legacy tool.call + aep.tool_name -> import
 * OTEL-IMPORT-03  unrelated chat span -> unsupported
 * OTEL-IMPORT-04  missing state-changing -> unknown (absent), NOT false
 * OTEL-IMPORT-05  missing subject/resource -> no fabricated full decision
 * OTEL-IMPORT-06  current emit includes execute_tool + gen_ai.tool.name
 * OTEL-IMPORT-07  AEP extensions preserved where applicable
 * OTEL-IMPORT-08  imported telemetry is not marked DSSE-authenticated
 *
 * OTEL-IMPORT-01 uses ONLY standard gen_ai.* attributes (no aep.*) to pin the
 * contract that a plain third-party GenAI span imports basic tool identity.
 */
import { describe, expect, it } from "bun:test";
import { aepActionToOtelSpan, type OtelSpanLike, otelSpanToAepAction } from "./aep-otel-bridge.js";
import { GENAI_SEMCONV } from "./aep-span-names.js";

function makeSpan(overrides: Partial<OtelSpanLike> & { attributes?: Record<string, unknown> }) {
  const attributes = overrides.attributes ?? {};
  return {
    name: "execute_tool read_file",
    traceId: "a".repeat(32),
    spanId: "1234567890abcdef",
    startTimeUnixNano: 1_700_000_000_000_000_000,
    endTimeUnixNano: 1_700_000_000_050_000_000,
    status: { code: 1 },
    ...overrides,
    attributes,
  } as unknown as OtelSpanLike;
}

describe("OTEL-IMPORT interop matrix", () => {
  // OTEL-IMPORT-01 — pure standard GenAI span, zero aep.* attributes.
  it("01: imports a standard current execute_tool span with only gen_ai.* attrs", () => {
    const span = makeSpan({
      name: "execute_tool web_search",
      attributes: {
        [GENAI_SEMCONV.ATTR_OPERATION_NAME]: "execute_tool",
        [GENAI_SEMCONV.ATTR_TOOL_NAME]: "web_search",
        [GENAI_SEMCONV.ATTR_TOOL_CALL_ID]: "call_42",
      },
    });
    const action = otelSpanToAepAction(span);
    expect(action).not.toBeNull();
    expect(action!.tool_name).toBe("web_search");
    expect(action!.action_id).toBe("1234567890abcdef");
    expect(action!.timestamp_ms).toBe(1_700_000_000_000);
  });

  it("02: still imports the legacy tool.call + aep.tool_name shape", () => {
    const span = makeSpan({
      name: "tool.call",
      attributes: {
        "aep.tool_name": "write_file",
        "aep.state_changing": true,
      },
    });
    const action = otelSpanToAepAction(span);
    expect(action).not.toBeNull();
    expect(action!.tool_name).toBe("write_file");
    expect(action!.state_changing).toBe(true);
  });

  it("03: returns null for unrelated spans (chat, spans without tool identity)", () => {
    expect(
      otelSpanToAepAction(
        makeSpan({
          name: "chat gpt-4o",
          attributes: { [GENAI_SEMCONV.ATTR_OPERATION_NAME]: "chat" },
        })
      )
    ).toBeNull();
    expect(
      otelSpanToAepAction(
        makeSpan({
          name: "http GET /health",
          attributes: { "http.method": "GET" },
        })
      )
    ).toBeNull();
    // operation name matches but no tool name -> not recognizable
    expect(
      otelSpanToAepAction(
        makeSpan({
          name: "execute_tool",
          attributes: { [GENAI_SEMCONV.ATTR_OPERATION_NAME]: "execute_tool" },
        })
      )
    ).toBeNull();
  });

  it("04: missing state-changing imports as unknown (absent), NOT false", () => {
    const span = makeSpan({
      attributes: {
        [GENAI_SEMCONV.ATTR_OPERATION_NAME]: "execute_tool",
        [GENAI_SEMCONV.ATTR_TOOL_NAME]: "web_search",
      },
    });
    const action = otelSpanToAepAction(span)!;
    expect(action).not.toBeNull();
    expect("state_changing" in action).toBe(false);
    expect(action.state_changing).toBeUndefined();
  });

  it("05: does not fabricate a full capability_decision from partial policy attrs", () => {
    const action = otelSpanToAepAction(
      makeSpan({
        name: "tool.call",
        attributes: {
          "aep.tool_name": "deploy",
          "aep.policy_decision": "deny",
          // capability / subject / resource missing
        },
      })
    )!;
    expect(action.capability_decision).toBeUndefined();
  });

  it("06: emission uses current execute_tool span name + standard core attrs", () => {
    const span = aepActionToOtelSpan(
      {
        action_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        tool_name: "read_file",
        state_changing: false,
        timestamp_ms: 1_700_000_000_000,
      },
      "run-1"
    );
    expect(span.name).toBe("execute_tool read_file");
    expect(span.attributes[GENAI_SEMCONV.ATTR_OPERATION_NAME]).toBe("execute_tool");
    expect(span.attributes[GENAI_SEMCONV.ATTR_TOOL_NAME]).toBe("read_file");
    expect(span.attributes[GENAI_SEMCONV.ATTR_TOOL_CALL_ID]).toBe(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    );
  });

  it("07: AEP extension attributes survive a round-trip", () => {
    const span = aepActionToOtelSpan(
      {
        action_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        tool_name: "write_file",
        state_changing: true,
        timestamp_ms: 1_700_000_000_000,
        causal_chain_id: "chain-1",
        result_digest: "sha256-abc",
        input_taint_labels: ["untrusted"],
      },
      "run-1"
    );
    const back = otelSpanToAepAction(span)!;
    expect(back.tool_name).toBe("write_file");
    expect(back.state_changing).toBe(true);
    expect(back.causal_chain_id).toBe("chain-1");
    expect(back.result_digest).toBe("sha256-abc");
    expect(back.input_taint_labels).toEqual(["untrusted"]);
  });

  it("08: imported telemetry carries no authenticity markers", () => {
    const span = makeSpan({
      name: "tool.call",
      attributes: { "aep.tool_name": "read_file", "aep.state_changing": true },
    });
    const action = otelSpanToAepAction(span)!;
    const json = JSON.stringify(action);
    expect(json).not.toContain("dsse");
    expect(json).not.toContain("signature");
    expect(json).not.toContain("authenticity");
  });
});
