import { describe, it, expect, beforeEach } from "vitest";
import { OtelBridge, InMemorySpanExporter, withOtel } from "../observability/index.js";
import type { AgentEvent } from "../types/events.js";

function traceId() { return `trace-${Math.random().toString(36).slice(2)}`; }

function makeRunEvents(tid: string, toolNames: string[] = []): AgentEvent[] {
  const events: AgentEvent[] = [];
  events.push({ traceId: tid, parentTraceId: null, channel: "text", event: "run_start", data: { task: "test task" }, timestampMs: 100 });
  events.push({ traceId: tid, parentTraceId: null, channel: "thinking", event: "step_start", data: { step: 1 }, timestampMs: 110 });
  for (let i = 0; i < toolNames.length; i++) {
    const callId = `call-${i}`;
    events.push({ traceId: tid, parentTraceId: null, channel: "tool", event: "tool_call", data: { toolName: toolNames[i]!, args: {}, callId, batchId: "b", batchSize: 1, stepIndex: 1 }, timestampMs: 120 });
    events.push({ traceId: tid, parentTraceId: null, channel: "tool", event: "tool_result", data: { toolName: toolNames[i]!, callId, output: "ok", batchId: "b", batchSize: 1, stepIndex: 1 }, timestampMs: 130 });
  }
  events.push({ traceId: tid, parentTraceId: null, channel: "text", event: "final_answer", data: { answer: "42" }, timestampMs: 200 });
  return events;
}

describe("OtelBridge (C2) — backward compatibility (both mode)", () => {
  let exporter: InMemorySpanExporter;
  let bridge: OtelBridge;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    // Default "both" mode: emits both legacy and gen_ai.* attributes.
    bridge = new OtelBridge({ exporter });
  });

  it("creates a root run span with task attribute", () => {
    const tid = traceId();
    for (const ev of makeRunEvents(tid)) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run");
    expect(runSpan).toBeDefined();
    expect(runSpan?.attributes["task"]).toBe("test task");
    expect(runSpan?.status).toBe("ok");
    expect(runSpan?.endTimeMs).toBeDefined();
  });

  it("creates step child spans nested under run span", () => {
    const tid = traceId();
    for (const ev of makeRunEvents(tid)) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run");
    const stepSpan = exporter.spans.find((s) => s.name === "agent.step.1");
    expect(stepSpan?.parentSpanId).toBe(runSpan?.spanId);
  });

  it("creates execute_tool spans nested under step span (E1 default name)", () => {
    const tid = traceId();
    for (const ev of makeRunEvents(tid, ["search"])) bridge.record(ev);
    bridge.flush();
    const stepSpan = exporter.spans.find((s) => s.name === "agent.step.1");
    const toolSpan = exporter.spans.find((s) => s.name === "execute_tool");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.parentSpanId).toBe(stepSpan?.spanId);
    // Both legacy and gen_ai.* names present in "both" mode.
    expect(toolSpan?.attributes["tool.name"]).toBe("search");
    expect(toolSpan?.attributes["gen_ai.tool.name"]).toBe("search");
  });

  it("accumulates usage tokens on run span with both legacy and gen_ai.* names", () => {
    const tid = traceId();
    bridge.record({ traceId: tid, parentTraceId: null, channel: "text", event: "run_start", data: { task: "t" }, timestampMs: 0 });
    bridge.record({ traceId: tid, parentTraceId: null, channel: "status", event: "status", data: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 } as unknown as { phase: "tool_executing"; step: number }, timestampMs: 1 });
    bridge.record({ traceId: tid, parentTraceId: null, channel: "status", event: "status", data: { inputTokens: 50, outputTokens: 20 } as unknown as { phase: "tool_executing"; step: number }, timestampMs: 2 });
    bridge.record({ traceId: tid, parentTraceId: null, channel: "text", event: "final_answer", data: { answer: "done" }, timestampMs: 3 });
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run");
    // Legacy attributes still present.
    expect(runSpan?.attributes["usage.inputTokens"]).toBe(150);
    expect(runSpan?.attributes["usage.outputTokens"]).toBe(70);
    expect(runSpan?.attributes["usage.cacheReadTokens"]).toBe(30);
    // gen_ai.* also present.
    expect(runSpan?.attributes["gen_ai.usage.input_tokens"]).toBe(150);
    expect(runSpan?.attributes["gen_ai.usage.output_tokens"]).toBe(70);
    expect(runSpan?.attributes["gen_ai.usage.cache_read_input_tokens"]).toBe(30);
  });

  it("marks run span as error on error event", () => {
    const tid = traceId();
    bridge.record({ traceId: tid, parentTraceId: null, channel: "text", event: "run_start", data: { task: "t" }, timestampMs: 0 });
    bridge.record({ traceId: tid, parentTraceId: null, channel: "text", event: "error", data: { error: "boom" }, timestampMs: 1 });
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run");
    expect(runSpan?.status).toBe("error");
    expect(runSpan?.attributes["error"]).toBe("boom");
  });

  it("withOtel pipes events and calls forceFlush on completion", async () => {
    const tid = traceId();
    const events = makeRunEvents(tid, ["calc"]);
    async function* gen() { for (const ev of events) yield ev; }
    const collected: AgentEvent[] = [];
    for await (const ev of withOtel(gen(), bridge)) collected.push(ev);
    expect(collected).toHaveLength(events.length);
    expect(exporter.spans.length).toBeGreaterThan(0);
  });
});

// ── E1: GenAI semconv tests ───────────────────────────────────────────────────

describe("OtelBridge E1 — OTel GenAI semantic conventions", () => {
  it("stable mode emits gen_ai.* attrs and suppresses legacy names", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "stable" });
    const tid = traceId();
    for (const ev of makeRunEvents(tid, ["search"])) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run")!;
    expect(runSpan.attributes["gen_ai.agent.task"]).toBe("test task");
    expect(runSpan.attributes["task"]).toBeUndefined();
    const toolSpan = exporter.spans.find((s) => s.name === "execute_tool")!;
    expect(toolSpan.attributes["gen_ai.tool.name"]).toBe("search");
    expect(toolSpan.attributes["tool.name"]).toBeUndefined();
  });

  it("legacy mode emits only private attrs and suppresses gen_ai.* names", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "legacy" });
    const tid = traceId();
    for (const ev of makeRunEvents(tid, ["calc"])) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run")!;
    expect(runSpan.attributes["task"]).toBe("test task");
    expect(runSpan.attributes["gen_ai.agent.task"]).toBeUndefined();
    // In legacy mode the tool span is named "tool.<name>".
    const toolSpan = exporter.spans.find((s) => s.name === "tool.calc")!;
    expect(toolSpan).toBeDefined();
    expect(toolSpan.attributes["tool.name"]).toBe("calc");
    expect(toolSpan.attributes["gen_ai.tool.name"]).toBeUndefined();
  });

  it("execute_tool span has gen_ai.operation.name = execute_tool in both/stable modes", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "both" });
    const tid = traceId();
    for (const ev of makeRunEvents(tid, ["my_tool"])) bridge.record(ev);
    bridge.flush();
    const toolSpan = exporter.spans.find((s) => s.name === "execute_tool")!;
    expect(toolSpan.attributes["gen_ai.operation.name"]).toBe("execute_tool");
  });

  it("agent.run span has gen_ai.operation.name = agent", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "both" });
    const tid = traceId();
    for (const ev of makeRunEvents(tid)) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run")!;
    expect(runSpan.attributes["gen_ai.operation.name"]).toBe("agent");
  });

  it("cacheReadTokens1h maps to gen_ai.usage.cache_read_input_tokens_1h", () => {
    const exporter = new InMemorySpanExporter();
    const bridge = new OtelBridge({ exporter, semconvMode: "both" });
    const tid = traceId();
    bridge.record({ traceId: tid, parentTraceId: null, channel: "text", event: "run_start", data: { task: "t" }, timestampMs: 0 });
    bridge.record({ traceId: tid, parentTraceId: null, channel: "status", event: "status", data: { inputTokens: 0, cacheReadTokens1h: 75 } as unknown as { phase: "tool_executing"; step: number }, timestampMs: 1 });
    bridge.record({ traceId: tid, parentTraceId: null, channel: "text", event: "final_answer", data: { answer: "ok" }, timestampMs: 2 });
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run")!;
    expect(runSpan.attributes["gen_ai.usage.cache_read_input_tokens_1h"]).toBe(75);
    expect(runSpan.attributes["usage.cacheReadTokens1h"]).toBe(75);
  });
});
