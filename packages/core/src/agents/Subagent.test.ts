import { describe, expect, it, mock } from "bun:test";
import type { AgentEvent } from "../types/events.js";
import {
  POSTURE_DELEGATION_TYPE,
  type PostureDelegationRecord,
  type PosturePolicy,
} from "./PosturePolicy.js";
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
    const onEvent = mock();
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

describe("asTool — posture cascade (#264)", () => {
  function finalAnswerAgent(answer: string) {
    return makeMockAgent([
      {
        traceId: "sub",
        parentTraceId: null,
        channel: "text",
        event: "run_start",
        data: { task: "do" },
        timestampMs: 0,
      },
      {
        traceId: "sub",
        parentTraceId: null,
        channel: "text",
        event: "final_answer",
        data: { answer },
        timestampMs: 1,
      },
    ]);
  }

  const parentPosture: PosturePolicy = {
    allowedHosts: ["api.example.com", "cdn.example.com"],
    allowedReadPaths: [],
    allowedWritePaths: [],
    extraCapabilities: [],
    deniedTools: [],
    recordingMode: "validation",
  };

  it("appends a posture delegation record narrowing the parent posture", async () => {
    const appended: unknown[] = [];
    const tool = asTool(finalAnswerAgent("42"), {
      name: "sub_agent",
      description: "d",
      parentTraceIdRef: { current: "parent-trace" },
      parentPosture,
      // escalate: request a host the parent never granted
      postureOverride: { allowedHosts: ["api.example.com", "evil.example.com"] },
      evidenceSink: { append: (r) => void appended.push(r) },
    });
    const result = await tool.forward({ task: "do" });

    expect(result.answer).toBe("42");
    expect(appended).toHaveLength(1);
    const rec = appended[0] as PostureDelegationRecord;
    expect(rec.type).toBe(POSTURE_DELEGATION_TYPE);
    expect(rec.parentAgentId).toBe("parent-trace");
    expect(rec.childAgentId).toBe("sub_agent");
    expect(rec.delegationChain).toEqual(["parent-trace"]);
    // effective posture is narrowed — the un-granted host was dropped
    expect(rec.effectivePosture.allowedHosts).toEqual(["api.example.com"]);
    expect(rec.attenuations.some((a) => a.field === "allowedHosts")).toBe(true);
  });

  it("still records the delegation when the sub-agent errors (spawn-time act)", async () => {
    const appended: unknown[] = [];
    const agent = makeMockAgent([
      {
        traceId: "sub",
        parentTraceId: null,
        channel: "text",
        event: "error",
        data: { error: "boom" },
        timestampMs: 0,
      },
    ]);
    const tool = asTool(agent, {
      name: "bad",
      description: "d",
      parentPosture,
      evidenceSink: { append: (r) => void appended.push(r) },
    });
    await expect(tool.forward({ task: "do" })).rejects.toThrow(/bad.*boom/);
    expect(appended).toHaveLength(1);
  });

  it("no parentPosture ⇒ no delegation recorded (backward-compatible)", async () => {
    const appended: unknown[] = [];
    const tool = asTool(finalAnswerAgent("42"), {
      name: "sub_agent",
      description: "d",
      evidenceSink: { append: (r) => void appended.push(r) },
    });
    await tool.forward({ task: "do" });
    expect(appended).toHaveLength(0);
  });
});
