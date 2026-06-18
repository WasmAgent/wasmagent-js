import type { AgentEvent } from "@wasmagent/core";
import { toAgUiEvents, toSseString } from "./index.js";

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

  it("thinking_delta → TEXT_MESSAGE_CHUNK (channel: thinking)", async () => {
    const events = await collect([
      makeEvent({
        channel: "thinking",
        event: "thinking_delta",
        data: { delta: "I'm thinking...", step: 1 },
      }),
    ]);
    expect(events[0]?.type).toBe("TEXT_MESSAGE_CHUNK");
    const d = (events[0] as { data: { channel?: string; delta: string } }).data;
    expect(d.channel).toBe("thinking");
    expect(d.delta).toBe("I'm thinking...");
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
