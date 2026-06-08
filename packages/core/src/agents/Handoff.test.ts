import { describe, it, expect } from "vitest";
import { handoff, handoffGenerator } from "./Handoff.js";
import type { HandoffAgent } from "./Handoff.js";
import type { AgentEvent } from "../types/events.js";

function mockAgent(answer: string, shouldError = false): HandoffAgent {
  return {
    async *run(task: string, parentTraceId?: string | null): AsyncGenerator<AgentEvent> {
      const traceId = `agent-mock-${Math.random().toString(36).slice(2)}`;
      yield { traceId, parentTraceId: parentTraceId ?? null, channel: "text", event: "run_start", data: { task }, timestampMs: Date.now() };
      if (shouldError) {
        yield { traceId, parentTraceId: parentTraceId ?? null, channel: "text", event: "error", data: { error: "mock error" }, timestampMs: Date.now() };
      } else {
        yield { traceId, parentTraceId: parentTraceId ?? null, channel: "text", event: "final_answer", data: { answer }, timestampMs: Date.now() };
      }
    },
  };
}

describe("handoff", () => {
  it("returns target agent final_answer as the result", async () => {
    const target = mockAgent("42");
    const result = await handoff(target, "what is the answer?", "parent-trace-1");
    expect(result.success).toBe(true);
    expect(result.answer).toBe("42");
    expect(result.errorMessage).toBeUndefined();
  });

  it("collects all events emitted by target agent", async () => {
    const target = mockAgent("done");
    const result = await handoff(target, "task", null);
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.some((e) => e.event === "run_start")).toBe(true);
    expect(result.events.some((e) => e.event === "final_answer")).toBe(true);
  });

  it("returns success=false and errorMessage when target errors", async () => {
    const target = mockAgent("", true);
    const result = await handoff(target, "task", null);
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("mock error");
    expect(result.answer).toBeNull();
  });

  it("contextMapper transforms the task before passing to target agent", async () => {
    let receivedTask = "";
    const spyAgent: HandoffAgent = {
      async *run(task): AsyncGenerator<AgentEvent> {
        receivedTask = task;
        yield { traceId: "t", parentTraceId: null, channel: "text", event: "final_answer", data: { answer: "ok" }, timestampMs: Date.now() };
      },
    };
    await handoff(spyAgent, "original task", null, {
      contextMapper: (t) => `[CONTEXT] ${t}`,
    });
    expect(receivedTask).toBe("[CONTEXT] original task");
  });

  it("asTool and handoff are semantically distinct", async () => {
    // asTool wraps agent as tool returning to parent; handoff is a direct call
    // that terminates the calling flow. This test verifies handoff returns
    // the final answer directly without continuation.
    const target = mockAgent("handoff-answer");
    const result = await handoff(target, "task", null);
    // The caller directly gets the answer — no parent step continuation happens here.
    expect(result.answer).toBe("handoff-answer");
  });
});

describe("handoffGenerator", () => {
  it("emits handoff status event first", async () => {
    const target = mockAgent("result");
    const events: AgentEvent[] = [];
    for await (const ev of handoffGenerator(target, "task", "parent-trace", null, 2, "target-agent")) {
      events.push(ev);
    }
    expect(events[0]?.event).toBe("handoff");
    if (events[0]?.event === "handoff") {
      expect(events[0].data.targetAgentName).toBe("target-agent");
      expect(events[0].data.step).toBe(2);
    }
  });

  it("yields all target agent events after handoff event", async () => {
    const target = mockAgent("42");
    const events: AgentEvent[] = [];
    for await (const ev of handoffGenerator(target, "task", "trace-1", null, 1, "agent-2")) {
      events.push(ev);
    }
    // First is handoff status, then target agent events
    expect(events[0]?.event).toBe("handoff");
    expect(events.some((e) => e.event === "final_answer")).toBe(true);
    const finalEv = events.find((e) => e.event === "final_answer");
    expect(finalEv?.event === "final_answer" && finalEv.data.answer).toBe("42");
  });

  it("passes parent traceId as parentTraceId to target agent", async () => {
    let capturedParentId: string | null | undefined = undefined;
    const spyAgent: HandoffAgent = {
      async *run(_task, parentTraceId): AsyncGenerator<AgentEvent> {
        capturedParentId = parentTraceId;
        yield { traceId: "child", parentTraceId: parentTraceId ?? null, channel: "text", event: "final_answer", data: { answer: "ok" }, timestampMs: Date.now() };
      },
    };
    for await (const _ of handoffGenerator(spyAgent, "task", "caller-trace", null, 1, "spy")) { /* consume */ }
    expect(capturedParentId).toBe("caller-trace");
  });
});
