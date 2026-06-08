import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../types/events.js";
import { asTool } from "./Subagent.js";

function makeMockAgent(events: AgentEvent[]) {
  return {
    async *run(_task: string, _parentTraceId?: string | null): AsyncGenerator<AgentEvent> {
      for (const ev of events) yield ev;
    },
  };
}

describe("asTool", () => {
  it("returns the final answer from the sub-agent", async () => {
    const agent = makeMockAgent([
      {
        traceId: "sub",
        parentTraceId: null,
        channel: "text",
        event: "run_start",
        data: { task: "do it" },
        timestampMs: 0,
      },
      {
        traceId: "sub",
        parentTraceId: null,
        channel: "text",
        event: "final_answer",
        data: { answer: "42" },
        timestampMs: 1,
      },
    ]);
    const tool = asTool(agent, { name: "sub_agent", description: "a sub" });
    const result = await tool.forward({ task: "do it" });
    expect(result.answer).toBe("42");
  });

  it("propagates error from the sub-agent as a thrown error", async () => {
    const agent = makeMockAgent([
      {
        traceId: "sub",
        parentTraceId: null,
        channel: "text",
        event: "run_start",
        data: { task: "fail" },
        timestampMs: 0,
      },
      {
        traceId: "sub",
        parentTraceId: null,
        channel: "text",
        event: "error",
        data: { error: "something broke" },
        timestampMs: 1,
      },
    ]);
    const tool = asTool(agent, { name: "bad_agent", description: "broken" });
    await expect(tool.forward({ task: "fail" })).rejects.toThrow(/bad_agent.*something broke/);
  });

  it("calls onEvent for each sub-agent event", async () => {
    const events: AgentEvent[] = [
      {
        traceId: "sub",
        parentTraceId: null,
        channel: "text",
        event: "run_start",
        data: { task: "x" },
        timestampMs: 0,
      },
      {
        traceId: "sub",
        parentTraceId: null,
        channel: "text",
        event: "final_answer",
        data: { answer: "ok" },
        timestampMs: 1,
      },
    ];
    const agent = makeMockAgent(events);
    const onEvent = vi.fn();
    const tool = asTool(agent, { name: "obs", description: "observing", onEvent });
    await tool.forward({ task: "x" });
    expect(onEvent).toHaveBeenCalledTimes(events.length);
    expect(onEvent).toHaveBeenNthCalledWith(1, events[0]);
  });

  it("produces a tool with correct name, description, and schema", () => {
    const agent = makeMockAgent([]);
    const tool = asTool(agent, { name: "my_agent", description: "desc" });
    expect(tool.name).toBe("my_agent");
    expect(tool.description).toBe("desc");
    expect(tool.readOnly).toBe(false);
    expect(tool.idempotent).toBe(false);
    // Input schema must accept { task: string }
    expect(() => tool.inputSchema.parse({ task: "hello" })).not.toThrow();
    expect(() => tool.inputSchema.parse({ task: 123 })).toThrow();
  });

  it("returns null answer when sub-agent exits without final_answer", async () => {
    const agent = makeMockAgent([
      {
        traceId: "sub",
        parentTraceId: null,
        channel: "text",
        event: "run_start",
        data: { task: "x" },
        timestampMs: 0,
      },
    ]);
    const tool = asTool(agent, { name: "silent", description: "" });
    const result = await tool.forward({ task: "x" });
    expect(result.answer).toBeNull();
  });
});
