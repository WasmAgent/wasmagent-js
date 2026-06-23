import type { AgentEvent } from "@wasmagent/core";
import { fromRunAgentInput, toAgUiEvents, toSseString } from "./index.js";

function makeEvent<T extends Partial<AgentEvent>>(overrides: T): AgentEvent {
  return {
    traceId: "agent-test-123",
    parentTraceId: null,
    timestampMs: 1000,
    ...overrides,
  } as AgentEvent;
}

async function collect(
  events: AgentEvent[]
): Promise<ReturnType<typeof toAgUiEvents> extends AsyncGenerator<infer T> ? T[] : never> {
  const result = [];
  for await (const ev of toAgUiEvents(
    (async function* () {
      yield* events;
    })()
  )) {
    result.push(ev);
  }
  return result as any;
}

describe("toAgUiEvents — AG-UI mapping", () => {
  it("run_start → RUN_STARTED", async () => {
    const events = await collect([
      makeEvent({ channel: "text", event: "run_start", data: { task: "hello world" } }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("RUN_STARTED");
    expect((events[0] as { data: { task: string } }).data.task).toBe("hello world");
  });

  it("step_start → STEP_STARTED", async () => {
    const events = await collect([
      makeEvent({ channel: "thinking", event: "step_start", data: { step: 1 } }),
    ]);
    expect(events[0]?.type).toBe("STEP_STARTED");
    expect((events[0] as { data: { step: number } }).data.step).toBe(1);
  });

  it("thinking_delta → THINKING_START + TEXT_MESSAGE_CHUNK (channel: thinking)", async () => {
    const events = await collect([
      makeEvent({
        channel: "thinking",
        event: "thinking_delta",
        data: { delta: "I'm thinking...", step: 1 },
      }),
    ]);
    // First event: THINKING_START boundary marker
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("THINKING_START");
    // Second event: the actual chunk
    expect(events[1]?.type).toBe("TEXT_MESSAGE_CHUNK");
    const d = (events[1] as { data: { channel?: string; delta: string } }).data;
    expect(d.channel).toBe("thinking");
    expect(d.delta).toBe("I'm thinking...");
  });

  it("multiple thinking_deltas emit only one THINKING_START", async () => {
    const events = await collect([
      makeEvent({ channel: "thinking", event: "thinking_delta", data: { delta: "first", step: 1 } }),
      makeEvent({ channel: "thinking", event: "thinking_delta", data: { delta: "second", step: 1 } }),
      makeEvent({ channel: "thinking", event: "thinking_delta", data: { delta: "third", step: 1 } }),
    ]);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "THINKING_START")).toHaveLength(1);
    expect(types.filter((t) => t === "TEXT_MESSAGE_CHUNK")).toHaveLength(3);
    expect(types.indexOf("THINKING_START")).toBe(0);
  });

  it("THINKING_END emitted before tool_call after thinking_delta", async () => {
    const events = await collect([
      makeEvent({ channel: "thinking", event: "thinking_delta", data: { delta: "hmm", step: 1 } }),
      makeEvent({
        channel: "tool",
        event: "tool_call",
        data: { toolName: "search", args: {}, callId: "c1", batchId: "b1", batchSize: 1, stepIndex: 1 },
      }),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toContain("THINKING_START");
    expect(types).toContain("THINKING_END");
    // THINKING_END must come before TOOL_CALL_START
    expect(types.indexOf("THINKING_END")).toBeLessThan(types.indexOf("TOOL_CALL_START"));
  });

  it("THINKING_END emitted before final_answer after thinking_delta", async () => {
    const events = await collect([
      makeEvent({ channel: "thinking", event: "thinking_delta", data: { delta: "hmm", step: 1 } }),
      makeEvent({ channel: "text", event: "final_answer", data: { answer: "42" } }),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toContain("THINKING_START");
    expect(types).toContain("THINKING_END");
    expect(types.indexOf("THINKING_END")).toBeLessThan(types.indexOf("TEXT_MESSAGE_START"));
  });

  it("THINKING_END emitted before step_start when thinking is active", async () => {
    const events = await collect([
      makeEvent({ channel: "thinking", event: "thinking_delta", data: { delta: "hmm", step: 1 } }),
      makeEvent({ channel: "thinking", event: "step_start", data: { step: 2 } }),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toContain("THINKING_START");
    expect(types).toContain("THINKING_END");
    expect(types.indexOf("THINKING_END")).toBeLessThan(types.indexOf("STEP_STARTED"));
  });

  it("THINKING_END emitted before error when thinking is active", async () => {
    const events = await collect([
      makeEvent({ channel: "thinking", event: "thinking_delta", data: { delta: "hmm", step: 1 } }),
      makeEvent({ channel: "text", event: "error", data: { error: "boom", step: 1 } }),
    ]);
    const types = events.map((e) => e.type);
    expect(types).toContain("THINKING_START");
    expect(types).toContain("THINKING_END");
    expect(types.indexOf("THINKING_END")).toBeLessThan(types.indexOf("RUN_ERROR"));
  });

  it("no THINKING_START/END emitted when no thinking_delta events", async () => {
    const events = await collect([
      makeEvent({ channel: "text", event: "run_start", data: { task: "t" } }),
      makeEvent({ channel: "text", event: "final_answer", data: { answer: "done" } }),
    ]);
    const types = events.map((e) => e.type);
    expect(types).not.toContain("THINKING_START");
    expect(types).not.toContain("THINKING_END");
  });

  it("tool_call → TOOL_CALL_START + TOOL_CALL_ARGS (AG1)", async () => {
    const events = await collect([
      makeEvent({
        channel: "tool",
        event: "tool_call",
        data: {
          toolName: "search",
          args: { q: "foo" },
          callId: "c1",
          batchId: "b1",
          batchSize: 1,
          stepIndex: 1,
        },
      }),
    ]);
    // AG1: tool_call now emits TOOL_CALL_START + TOOL_CALL_ARGS
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("TOOL_CALL_START");
    expect(events[1]?.type).toBe("TOOL_CALL_ARGS");
    const d = (events[0] as { data: { toolCallId: string; toolName: string } }).data;
    expect(d.toolCallId).toBe("c1");
    expect(d.toolName).toBe("search");
  });

  it("tool_result → TOOL_CALL_RESULT + TOOL_CALL_END (success)", async () => {
    const events = await collect([
      makeEvent({
        channel: "tool",
        event: "tool_result",
        data: {
          callId: "c1",
          toolName: "search",
          output: { result: "found" },
          batchId: "b1",
          batchSize: 1,
          stepIndex: 1,
        },
      }),
    ]);
    // AG1: tool_result now emits TOOL_CALL_RESULT (official) + TOOL_CALL_END (backward-compat)
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("TOOL_CALL_RESULT");
    expect(events[1]?.type).toBe("TOOL_CALL_END");
    const d = (events[0] as { data: { isError: boolean; toolCallId: string } }).data;
    expect(d.isError).toBe(false);
    expect(d.toolCallId).toBe("c1");
  });

  it("tool_result with error → TOOL_CALL_END (isError: true)", async () => {
    const events = await collect([
      makeEvent({
        channel: "tool",
        event: "tool_result",
        data: {
          callId: "c2",
          toolName: "search",
          output: null as unknown,
          error: { code: "execution_error" as const, message: "failed" },
          batchId: "b1",
          batchSize: 1,
          stepIndex: 1,
        },
      }),
    ]);
    const ev = events[0] as { data: { isError: boolean } };
    expect(ev?.data.isError).toBe(true);
  });

  it("final_answer → TEXT_MESSAGE_START + CONTENT + END + RUN_FINISHED (4 events)", async () => {
    const events = await collect([
      makeEvent({ channel: "text", event: "final_answer", data: { answer: "42" } }),
    ]);
    expect(events).toHaveLength(4);
    expect(events[0]?.type).toBe("TEXT_MESSAGE_START");
    expect(events[1]?.type).toBe("TEXT_MESSAGE_CONTENT");
    expect(events[2]?.type).toBe("TEXT_MESSAGE_END");
    expect(events[3]?.type).toBe("RUN_FINISHED");
    expect((events[3] as { data: { answer: unknown } }).data.answer).toBe("42");
  });

  it("final_answer with object answer → JSON stringified delta", async () => {
    const events = await collect([
      makeEvent({ channel: "text", event: "final_answer", data: { answer: { value: 42 } } }),
    ]);
    const contentEv = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT") as
      | { data: { delta: string } }
      | undefined;
    expect(contentEv?.data.delta).toBe(JSON.stringify({ value: 42 }));
  });

  it("error → RUN_ERROR", async () => {
    const events = await collect([
      makeEvent({
        channel: "text",
        event: "error",
        data: { error: "something went wrong", step: 1 },
      }),
    ]);
    expect(events[0]?.type).toBe("RUN_ERROR");
    expect((events[0] as { data: { message: string } }).data.message).toBe("something went wrong");
  });

  it("await_human_input → INTERRUPT + STATE_DELTA + STEP_FINISHED (AG4)", async () => {
    const events = await collect([
      makeEvent({
        channel: "status",
        event: "await_human_input",
        data: { promptId: "p1", prompt: "Approve?", step: 2 },
      }),
    ]);
    // AG4: INTERRUPT is now emitted first, then STATE_DELTA (backward-compat) + STEP_FINISHED
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("INTERRUPT");
    expect(events[1]?.type).toBe("STATE_DELTA");
    expect(events[2]?.type).toBe("STEP_FINISHED");
    const interruptData = (
      events[0] as { data: { promptId: string; prompt: string; step: number } }
    ).data;
    expect(interruptData.promptId).toBe("p1");
    expect(interruptData.step).toBe(2);
    const delta = (events[1] as { data: { delta: { pendingApproval: { promptId: string } } } }).data
      .delta;
    expect(delta.pendingApproval.promptId).toBe("p1");
  });

  it("guardrail_tripwire → RUN_ERROR with layer and guardrailName", async () => {
    const events = await collect([
      makeEvent({
        channel: "status",
        event: "guardrail_tripwire",
        data: { guardrailName: "maxInputLength(5)", layer: "input" as const },
      }),
    ]);
    expect(events[0]?.type).toBe("RUN_ERROR");
    const d = (events[0] as { data: { layer?: string; guardrailName?: string } }).data;
    expect(d.layer).toBe("input");
    expect(d.guardrailName).toBe("maxInputLength(5)");
  });

  it("status events are suppressed", async () => {
    const events = await collect([
      makeEvent({ channel: "status", event: "status", data: { phase: "tool_executing", step: 1 } }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("model_start and model_done are suppressed", async () => {
    const events = await collect([
      makeEvent({
        channel: "model",
        event: "model_start",
        data: { modelId: "claude-sonnet-4-6", step: 1 },
      }),
      makeEvent({
        channel: "model",
        event: "model_done",
        data: { modelId: "claude-sonnet-4-6", step: 1, finishReason: "end_turn" },
      }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("all events carry correct runId (traceId)", async () => {
    const events = await collect([
      makeEvent({ channel: "text", event: "run_start", data: { task: "t" } }),
    ]);
    expect(events[0]?.runId).toBe("agent-test-123");
  });

  it("full pipeline snapshot: run_start → tool_call → tool_result → final_answer", async () => {
    const pipeline: AgentEvent[] = [
      makeEvent({ channel: "text", event: "run_start", data: { task: "task" } }),
      makeEvent({ channel: "thinking", event: "step_start", data: { step: 1 } }),
      makeEvent({
        channel: "tool",
        event: "tool_call",
        data: { toolName: "t", args: {}, callId: "c1", batchId: "b1", batchSize: 1, stepIndex: 1 },
      }),
      makeEvent({
        channel: "tool",
        event: "tool_result",
        data: {
          callId: "c1",
          toolName: "t",
          output: "out",
          batchId: "b1",
          batchSize: 1,
          stepIndex: 1,
        },
      }),
      makeEvent({ channel: "text", event: "final_answer", data: { answer: "done" } }),
    ];
    const events = await collect(pipeline);
    const types = events.map((e) => e.type);
    // Expected sequence (status suppressed):
    expect(types).toContain("RUN_STARTED");
    expect(types).toContain("STEP_STARTED");
    expect(types).toContain("TOOL_CALL_START");
    expect(types).toContain("TOOL_CALL_END");
    expect(types).toContain("RUN_FINISHED");
    // RUN_FINISHED appears after the answer events
    expect(types.indexOf("RUN_STARTED")).toBeLessThan(types.indexOf("RUN_FINISHED"));
  });
});

describe("toSseString", () => {
  it("produces valid SSE format", () => {
    const ev = {
      type: "RUN_STARTED" as const,
      runId: "r1",
      timestamp: 1000,
      data: { task: "test" },
    };
    const sse = toSseString(ev);
    expect(sse).toMatch(/^event: RUN_STARTED\n/);
    expect(sse).toMatch(/\ndata: /);
    expect(sse).toMatch(/\n\n$/);
    const dataLine = sse.split("\n").find((l) => l.startsWith("data:"));
    expect(dataLine).toBeDefined();
    const parsed = JSON.parse((dataLine ?? "").replace("data: ", ""));
    expect(parsed.type).toBe("RUN_STARTED");
  });
});

describe("fromRunAgentInput — context injection", () => {
  it("no context → task unchanged", () => {
    const result = fromRunAgentInput({ task: "hello" });
    expect(result.task).toBe("hello");
  });

  it("empty context array → task unchanged", () => {
    const result = fromRunAgentInput({ task: "hello", context: [] });
    expect(result.task).toBe("hello");
  });

  it("single context item → appended as <context> block", () => {
    const result = fromRunAgentInput({
      task: "summarise",
      context: [{ url: "https://example.com", title: "Example" }],
    });
    expect(result.task).toContain("summarise");
    expect(result.task).toContain("<context>");
    expect(result.task).toContain("</context>");
    expect(result.task).toContain('"url":"https://example.com"');
    expect(result.task).toContain('"title":"Example"');
  });

  it("multiple context items → each serialised on its own line inside <context>", () => {
    const result = fromRunAgentInput({
      task: "do something",
      context: [{ key: "a" }, { key: "b" }],
    });
    const contextBlock = result.task.slice(result.task.indexOf("<context>"));
    const lines = contextBlock
      .replace("<context>\n", "")
      .replace("\n</context>", "")
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ key: "a" });
    expect(JSON.parse(lines[1]!)).toEqual({ key: "b" });
  });

  it("task derived from last user message still gets context appended", () => {
    const result = fromRunAgentInput({
      messages: [{ role: "user", content: "what is 2+2?" }],
      context: [{ hint: "math" }],
    });
    expect(result.task).toMatch(/^what is 2\+2\?/);
    expect(result.task).toContain("<context>");
    expect(result.task).toContain('"hint":"math"');
  });

  it("resume field is passed through unchanged", () => {
    expect(fromRunAgentInput({ task: "t", resume: true }).resume).toBe(true);
    expect(fromRunAgentInput({ task: "t", resume: "sess-123" }).resume).toBe("sess-123");
    expect(fromRunAgentInput({ task: "t" }).resume).toBeUndefined();
  });
});
