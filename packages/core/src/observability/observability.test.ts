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

describe("OtelBridge (C2)", () => {
  let exporter: InMemorySpanExporter;
  let bridge: OtelBridge;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
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

  it("creates step child spans nested under run span (C2)", () => {
    const tid = traceId();
    for (const ev of makeRunEvents(tid)) bridge.record(ev);
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run");
    const stepSpan = exporter.spans.find((s) => s.name === "agent.step.1");
    expect(stepSpan?.parentSpanId).toBe(runSpan?.spanId);
  });

  it("creates tool grandchild spans nested under step span (C2)", () => {
    const tid = traceId();
    for (const ev of makeRunEvents(tid, ["search"])) bridge.record(ev);
    bridge.flush();
    const stepSpan = exporter.spans.find((s) => s.name === "agent.step.1");
    const toolSpan = exporter.spans.find((s) => s.name === "tool.search");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.parentSpanId).toBe(stepSpan?.spanId);
    expect(toolSpan?.attributes["tool.name"]).toBe("search");
  });

  it("accumulates usage tokens on run span (C2)", () => {
    const tid = traceId();
    bridge.record({ traceId: tid, parentTraceId: null, channel: "text", event: "run_start", data: { task: "t" }, timestampMs: 0 });
    // Simulate usage-like events by casting — the bridge handles these via its default case.
    bridge.record({ traceId: tid, parentTraceId: null, channel: "status", event: "status", data: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 } as unknown as { phase: "tool_executing"; step: number }, timestampMs: 1 });
    bridge.record({ traceId: tid, parentTraceId: null, channel: "status", event: "status", data: { inputTokens: 50, outputTokens: 20 } as unknown as { phase: "tool_executing"; step: number }, timestampMs: 2 });
    bridge.record({ traceId: tid, parentTraceId: null, channel: "text", event: "final_answer", data: { answer: "done" }, timestampMs: 3 });
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run");
    expect(runSpan?.attributes["usage.inputTokens"]).toBe(150);
    expect(runSpan?.attributes["usage.outputTokens"]).toBe(70);
    expect(runSpan?.attributes["usage.cacheReadTokens"]).toBe(30);
  });

  it("marks run span as error on error event (C2)", () => {
    const tid = traceId();
    bridge.record({ traceId: tid, parentTraceId: null, channel: "text", event: "run_start", data: { task: "t" }, timestampMs: 0 });
    bridge.record({ traceId: tid, parentTraceId: null, channel: "text", event: "error", data: { error: "boom" }, timestampMs: 1 });
    bridge.flush();
    const runSpan = exporter.spans.find((s) => s.name === "agent.run");
    expect(runSpan?.status).toBe("error");
    expect(runSpan?.attributes["error"]).toBe("boom");
  });

  it("withOtel pipes events and calls forceFlush on completion (C2)", async () => {
    const tid = traceId();
    const events = makeRunEvents(tid, ["calc"]);
    async function* gen() { for (const ev of events) yield ev; }
    const collected: AgentEvent[] = [];
    for await (const ev of withOtel(gen(), bridge)) collected.push(ev);
    // All events were yielded.
    expect(collected).toHaveLength(events.length);
    // Spans were exported.
    expect(exporter.spans.length).toBeGreaterThan(0);
  });
});
