import { beforeEach, describe, expect, it } from "vitest";
import type { ReadableSpan } from "../observability/index.js";
import { InMemorySpanExporter, OtelBridge, withOtel } from "../observability/index.js";
import type { AgentEvent } from "../types/events.js";

function traceId() {
  return `trace-${Math.random().toString(36).slice(2)}`;
}

function makeRunEvents(tid: string, toolNames: string[] = []): AgentEvent[] {
  const events: AgentEvent[] = [];
  events.push({
    traceId: tid,
    parentTraceId: null,
    channel: "text",
    event: "run_start",
    data: { task: "test task" },
    timestampMs: 100,
  });
  events.push({
    traceId: tid,
    parentTraceId: null,
    channel: "thinking",
    event: "step_start",
    data: { step: 1 },
    timestampMs: 110,
  });
  for (let i = 0; i < toolNames.length; i++) {
    const callId = `call-${i}`;
    events.push({
      traceId: tid,
      parentTraceId: null,
      channel: "tool",
      event: "tool_call",
      data: {
        toolName: toolNames[i] as string,
        args: {},
        callId,
        batchId: "b",
        batchSize: 1,
        stepIndex: 1,
      },
      timestampMs: 120,
    });
    events.push({
      traceId: tid,
      parentTraceId: null,
      channel: "tool",
      event: "tool_result",
      data: {
        toolName: toolNames[i] as string,
        callId,
        output: "ok",
        batchId: "b",
        batchSize: 1,
        stepIndex: 1,
      },
      timestampMs: 130,
    });
  }
  events.push({
    traceId: tid,
    parentTraceId: null,
    channel: "text",
    event: "final_answer",
    data: { answer: "42" },
    timestampMs: 200,
  });
  return events;
}

// ── C2: invoke_agent root span in both/stable mode ────────────────────────────

describe("OtelBridge C2 — invoke_agent root span (both/stable mode)", () => {
  let exporter: InMemorySpanExporter;
  let bridge: OtelBridge;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    bridge = new OtelBridge({ exporter }); // default "both" mode
  });

  it("root span is named 'invoke_agent' in both mode (C2)", () => {
    const tid = traceId();
    for (const ev of makeRunEvents(tid)) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "invoke_agent");
    expect(runSpan).toBeDefined();
    expect(runSpan?.attributes.task).toBe("test task");
    expect(runSpan?.attributes["gen_ai.agent.task"]).toBe("test task");
    expect(runSpan?.status).toBe("ok");
    expect(runSpan?.endTimeMs).toBeDefined();
  });

  it("root span has gen_ai.operation.name=invoke_agent (C2)", () => {
    const tid = traceId();
    for (const ev of makeRunEvents(tid)) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "invoke_agent") as ReadableSpan;
    expect(runSpan.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
  });

  it("creates step child spans nested under invoke_agent span", () => {
    const tid = traceId();
    for (const ev of makeRunEvents(tid)) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "invoke_agent");
    const stepSpan = exporter.spans.find((s) => s.name === "agent.step.1");
    expect(stepSpan?.parentSpanId).toBe(runSpan?.spanId);
  });

  it("creates execute_tool spans nested under step span", () => {
    const tid = traceId();
    for (const ev of makeRunEvents(tid, ["search"])) bridge.record(ev);
    bridge.flush();
    const stepSpan = exporter.spans.find((s) => s.name === "agent.step.1");
    const toolSpan = exporter.spans.find((s) => s.name === "execute_tool");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.parentSpanId).toBe(stepSpan?.spanId);
    expect(toolSpan?.attributes["tool.name"]).toBe("search");
    expect(toolSpan?.attributes["gen_ai.tool.name"]).toBe("search");
  });

  it("accumulates usage tokens with both legacy and gen_ai.* names", () => {
    const tid = traceId();
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "run_start",
      data: { task: "t" },
      timestampMs: 0,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "status",
      event: "status",
      data: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 } as unknown as {
        phase: "tool_executing";
        step: number;
      },
      timestampMs: 1,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "status",
      event: "status",
      data: { inputTokens: 50, outputTokens: 20 } as unknown as {
        phase: "tool_executing";
        step: number;
      },
      timestampMs: 2,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "final_answer",
      data: { answer: "done" },
      timestampMs: 3,
    });
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "invoke_agent");
    expect(runSpan?.attributes["usage.inputTokens"]).toBe(150);
    expect(runSpan?.attributes["usage.outputTokens"]).toBe(70);
    expect(runSpan?.attributes["usage.cacheReadTokens"]).toBe(30);
    expect(runSpan?.attributes["gen_ai.usage.input_tokens"]).toBe(150);
    expect(runSpan?.attributes["gen_ai.usage.output_tokens"]).toBe(70);
    expect(runSpan?.attributes["gen_ai.usage.cache_read_input_tokens"]).toBe(30);
  });

  it("marks run span as error on error event", () => {
    const tid = traceId();
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "run_start",
      data: { task: "t" },
      timestampMs: 0,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "error",
      data: { error: "boom" },
      timestampMs: 1,
    });
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "invoke_agent");
    expect(runSpan?.status).toBe("error");
    expect(runSpan?.attributes.error).toBe("boom");
  });

  it("withOtel pipes events and calls forceFlush on completion", async () => {
    const tid = traceId();
    const events = makeRunEvents(tid, ["calc"]);
    async function* gen() {
      for (const ev of events) yield ev;
    }
    const collected: AgentEvent[] = [];
    for await (const ev of withOtel(gen(), bridge)) collected.push(ev);
    expect(collected).toHaveLength(events.length);
    expect(exporter.spans.length).toBeGreaterThan(0);
  });
});

// ── C2: env-driven semconv opt-in ─────────────────────────────────────────────

describe("OtelBridge C2 — OTEL_SEMCONV_STABILITY_OPT_IN env detection", () => {
  it("auto-selects stable mode when env=gen_ai_latest_experimental", () => {
    const orig = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "gen_ai_latest_experimental";
    const exporter = new InMemorySpanExporter();
    // No explicit semconvMode — should detect from env.
    const bridge = new OtelBridge({ exporter });
    const tid = traceId();
    for (const ev of makeRunEvents(tid)) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "invoke_agent") as ReadableSpan;
    // In stable mode: gen_ai.* present, legacy absent.
    expect(runSpan.attributes["gen_ai.agent.task"]).toBe("test task");
    expect(runSpan.attributes.task).toBeUndefined();
    if (orig !== undefined) process.env.OTEL_SEMCONV_STABILITY_OPT_IN = orig;
    else delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
  });
});

// ── semconv mode tests ────────────────────────────────────────────────────────

describe("OtelBridge — semconv modes", () => {
  it("stable mode emits gen_ai.* attrs and suppresses legacy names", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "stable" });
    const tid = traceId();
    for (const ev of makeRunEvents(tid, ["search"])) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "invoke_agent") as ReadableSpan;
    expect(runSpan.attributes["gen_ai.agent.task"]).toBe("test task");
    expect(runSpan.attributes.task).toBeUndefined();
    const toolSpan = exporter.spans.find((s) => s.name === "execute_tool") as ReadableSpan;
    expect(toolSpan.attributes["gen_ai.tool.name"]).toBe("search");
    expect(toolSpan.attributes["tool.name"]).toBeUndefined();
  });

  it("legacy mode uses 'agent.run' root span and suppresses gen_ai.* names", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "legacy" });
    const tid = traceId();
    for (const ev of makeRunEvents(tid, ["calc"])) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run") as ReadableSpan;
    expect(runSpan).toBeDefined();
    expect(runSpan.attributes.task).toBe("test task");
    expect(runSpan.attributes["gen_ai.agent.task"]).toBeUndefined();
    const toolSpan = exporter.spans.find((s) => s.name === "tool.calc") as ReadableSpan;
    expect(toolSpan).toBeDefined();
    expect(toolSpan.attributes["tool.name"]).toBe("calc");
    expect(toolSpan.attributes["gen_ai.tool.name"]).toBeUndefined();
  });

  it("execute_tool span has gen_ai.operation.name=execute_tool in both/stable modes", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "both" });
    const tid = traceId();
    for (const ev of makeRunEvents(tid, ["my_tool"])) bridge.record(ev);
    bridge.flush();
    const toolSpan = exporter.spans.find((s) => s.name === "execute_tool") as ReadableSpan;
    expect(toolSpan.attributes["gen_ai.operation.name"]).toBe("execute_tool");
  });

  it("cacheReadTokens1h maps to gen_ai.usage.cache_read_input_tokens_1h", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "both" });
    const tid = traceId();
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "run_start",
      data: { task: "t" },
      timestampMs: 0,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "status",
      event: "status",
      data: { inputTokens: 0, cacheReadTokens1h: 75 } as unknown as {
        phase: "tool_executing";
        step: number;
      },
      timestampMs: 1,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "final_answer",
      data: { answer: "ok" },
      timestampMs: 2,
    });
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "invoke_agent") as ReadableSpan;
    expect(runSpan.attributes["gen_ai.usage.cache_read_input_tokens_1h"]).toBe(75);
    expect(runSpan.attributes["usage.cacheReadTokens1h"]).toBe(75);
  });
});

// ── E1: GenAI inference/chat span ─────────────────────────────────────────────

describe("OtelBridge E1 — GenAI inference/chat span", () => {
  it("opens a 'chat' span on model_start and closes it on model_done", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "both" });
    const tid = traceId();

    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "run_start",
      data: { task: "t" },
      timestampMs: 0,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "thinking",
      event: "step_start",
      data: { step: 1 },
      timestampMs: 10,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "model",
      event: "model_start",
      data: { modelId: "claude-sonnet-4-6", step: 1 },
      timestampMs: 20,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "model",
      event: "model_done",
      data: {
        modelId: "claude-sonnet-4-6",
        step: 1,
        finishReason: "end_turn",
        inputTokens: 100,
        outputTokens: 50,
      },
      timestampMs: 80,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "final_answer",
      data: { answer: "x" },
      timestampMs: 100,
    });
    bridge.flush();

    const chatSpan = exporter.spans.find((s) => s.name === "chat");
    expect(chatSpan).toBeDefined();
    expect(chatSpan?.status).toBe("ok");
    expect(chatSpan?.endTimeMs).toBeDefined();
  });

  it("chat span has gen_ai.request.model, gen_ai.response.model, gen_ai.system", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "stable" });
    const tid = traceId();

    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "run_start",
      data: { task: "t" },
      timestampMs: 0,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "thinking",
      event: "step_start",
      data: { step: 1 },
      timestampMs: 5,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "model",
      event: "model_start",
      data: { modelId: "claude-sonnet-4-6", step: 1 },
      timestampMs: 10,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "model",
      event: "model_done",
      data: {
        modelId: "claude-sonnet-4-6",
        step: 1,
        finishReason: "tool_use",
        inputTokens: 200,
        outputTokens: 30,
      },
      timestampMs: 50,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "final_answer",
      data: { answer: "x" },
      timestampMs: 60,
    });
    bridge.flush();

    const chatSpan = exporter.spans.find((s) => s.name === "chat") as ReadableSpan;
    expect(chatSpan.attributes["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
    expect(chatSpan.attributes["gen_ai.response.model"]).toBe("claude-sonnet-4-6");
    expect(chatSpan.attributes["gen_ai.system"]).toBe("anthropic");
    expect(chatSpan.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(chatSpan.attributes["gen_ai.response.finish_reasons"]).toBe("tool_use");
    expect(chatSpan.attributes["gen_ai.usage.input_tokens"]).toBe(200);
    expect(chatSpan.attributes["gen_ai.usage.output_tokens"]).toBe(30);
  });

  it("chat span is nested under step span", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "both" });
    const tid = traceId();

    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "run_start",
      data: { task: "t" },
      timestampMs: 0,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "thinking",
      event: "step_start",
      data: { step: 1 },
      timestampMs: 5,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "model",
      event: "model_start",
      data: { modelId: "claude-sonnet-4-6", step: 1 },
      timestampMs: 10,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "model",
      event: "model_done",
      data: { modelId: "claude-sonnet-4-6", step: 1, finishReason: "end_turn" },
      timestampMs: 40,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "final_answer",
      data: { answer: "x" },
      timestampMs: 50,
    });
    bridge.flush();

    const stepSpan = exporter.spans.find((s) => s.name === "agent.step.1") as ReadableSpan;
    const chatSpan = exporter.spans.find((s) => s.name === "chat") as ReadableSpan;
    expect(chatSpan.parentSpanId).toBe(stepSpan.spanId);
  });

  it("legacy mode names chat span 'model.chat'", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "legacy" });
    const tid = traceId();

    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "run_start",
      data: { task: "t" },
      timestampMs: 0,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "thinking",
      event: "step_start",
      data: { step: 1 },
      timestampMs: 5,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "model",
      event: "model_start",
      data: { modelId: "claude-sonnet-4-6", step: 1 },
      timestampMs: 10,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "model",
      event: "model_done",
      data: { modelId: "claude-sonnet-4-6", step: 1, finishReason: "end_turn" },
      timestampMs: 30,
    });
    bridge.record({
      traceId: tid,
      parentTraceId: null,
      channel: "text",
      event: "final_answer",
      data: { answer: "x" },
      timestampMs: 40,
    });
    bridge.flush();

    const chatSpan = exporter.spans.find((s) => s.name === "model.chat");
    expect(chatSpan).toBeDefined();
  });
});
