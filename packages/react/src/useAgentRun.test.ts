/**
 * Unit tests for useAgentRun event merge logic (B2).
 *
 * We test the pure event-processing logic in isolation using the evals
 * trace collector rather than full React rendering (which would require
 * jsdom / @testing-library).
 */

// Test the SSE line-parsing and event-extraction logic independently.

function parseSSELine(line: string): unknown | null {
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6).trim();
  if (payload === "[DONE]") return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

describe("useAgentRun SSE parsing logic (B2)", () => {
  it("parses data: lines correctly", () => {
    const line =
      'data: {"traceId":"t","event":"final_answer","channel":"text","data":{"answer":"42"},"parentTraceId":null,"timestampMs":0}';
    const ev = parseSSELine(line);
    expect(ev).not.toBeNull();
    expect((ev as { event: string }).event).toBe("final_answer");
  });

  it("ignores data: [DONE] sentinel", () => {
    expect(parseSSELine("data: [DONE]")).toBeNull();
  });

  it("ignores non-data lines", () => {
    expect(parseSSELine(": keep-alive")).toBeNull();
    expect(parseSSELine("event: message")).toBeNull();
  });

  it("handles malformed JSON gracefully", () => {
    expect(parseSSELine("data: {broken")).toBeNull();
  });
});

// Test the event accumulation state machine.

interface MsgState {
  messages: Array<{ role: string; content: string; toolName?: string; isError?: boolean }>;
  finalAnswer: string | null;
  status: "idle" | "running" | "complete" | "error";
}

function processEvent(state: MsgState, ev: Record<string, unknown>): MsgState {
  const s = { ...state, messages: [...state.messages] };
  if (ev.event === "tool_call" && ev.channel === "tool") {
    const d = ev.data as { toolName: string };
    s.messages.push({ role: "tool", content: `Calling ${d.toolName}…`, toolName: d.toolName });
  } else if (ev.event === "tool_result" && ev.channel === "tool") {
    const d = ev.data as { toolName: string; error?: unknown };
    const isError = !!d.error;
    s.messages = s.messages.map((m) =>
      m.toolName === d.toolName && m.content.startsWith("Calling")
        ? { ...m, content: isError ? `${d.toolName} failed` : `${d.toolName} done`, isError }
        : m
    );
  } else if (ev.event === "final_answer" && ev.channel === "text") {
    const answer = String((ev.data as { answer: unknown }).answer ?? "");
    s.finalAnswer = answer;
    s.messages.push({ role: "assistant", content: answer });
    s.status = "complete";
  } else if (ev.event === "error" && ev.channel === "text") {
    const msg = (ev.data as { error: string }).error ?? "error";
    s.messages.push({ role: "error", content: msg });
    s.status = "error";
  }
  return s;
}

describe("useAgentRun event accumulation state machine (B2)", () => {
  it("accumulates tool_call then tool_result correctly", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEvent(state, {
      event: "tool_call",
      channel: "tool",
      data: { toolName: "search", callId: "c1" },
    });
    expect(state.messages[0]?.content).toBe("Calling search…");
    expect(state.messages[0]?.toolName).toBe("search");

    state = processEvent(state, {
      event: "tool_result",
      channel: "tool",
      data: { toolName: "search", callId: "c1", output: "results" },
    });
    expect(state.messages[0]?.content).toBe("search done");
    expect(state.messages[0]?.isError).toBeFalsy();
  });

  it("marks tool result as error when error field present", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEvent(state, {
      event: "tool_call",
      channel: "tool",
      data: { toolName: "write", callId: "c2" },
    });
    state = processEvent(state, {
      event: "tool_result",
      channel: "tool",
      data: {
        toolName: "write",
        callId: "c2",
        error: { code: "execution_error", message: "boom" },
      },
    });
    expect(state.messages[0]?.content).toBe("write failed");
    expect(state.messages[0]?.isError).toBe(true);
  });

  it("sets finalAnswer and status=complete on final_answer event", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEvent(state, { event: "final_answer", channel: "text", data: { answer: "42" } });
    expect(state.finalAnswer).toBe("42");
    expect(state.status).toBe("complete");
    expect(state.messages.some((m) => m.content === "42")).toBe(true);
  });

  it("sets status=error and adds error message on error event", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEvent(state, {
      event: "error",
      channel: "text",
      data: { error: "max steps exceeded" },
    });
    expect(state.status).toBe("error");
    expect(state.messages[0]?.role).toBe("error");
    expect(state.messages[0]?.content).toBe("max steps exceeded");
  });
});

// ── C1 — Last-Event-ID resume request shaping ────────────────────────────────
//
// The hook tracks `traceId` and `lastEventId` across attempts inside its
// closure. We mirror that behavior here against the same shaping rule the
// hook uses: on retries, the request body must carry `resumeTraceId` and
// the request headers must carry `Last-Event-ID`. Pure function so we can
// test it without React.

interface AttemptInputs {
  payload: Record<string, unknown>;
  traceId: string | null;
  lastEventId: string | null;
  baseHeaders?: Record<string, string>;
}
function shapeRequest({ payload, traceId, lastEventId, baseHeaders = {} }: AttemptInputs) {
  const reqHeaders: Record<string, string> = { "Content-Type": "application/json", ...baseHeaders };
  if (lastEventId) reqHeaders["Last-Event-ID"] = lastEventId;
  const reqBody = traceId ? { ...payload, resumeTraceId: traceId } : payload;
  return { reqHeaders, reqBody };
}

describe("useAgentRun resume request shaping (C1)", () => {
  it("first attempt: no Last-Event-ID header, body matches payload exactly", () => {
    const { reqHeaders, reqBody } = shapeRequest({
      payload: { task: "hello" },
      traceId: null,
      lastEventId: null,
    });
    expect(reqHeaders["Last-Event-ID"]).toBeUndefined();
    expect(reqBody).toEqual({ task: "hello" });
    // The hook must not invent a resumeTraceId before the server has issued one.
    expect("resumeTraceId" in reqBody).toBe(false);
  });

  it("retry after seeing trace id but no events yet: body carries resumeTraceId, header omits Last-Event-ID", () => {
    const { reqHeaders, reqBody } = shapeRequest({
      payload: { task: "hello" },
      traceId: "run-abc-1",
      lastEventId: null,
    });
    expect(reqHeaders["Last-Event-ID"]).toBeUndefined();
    expect(reqBody).toEqual({ task: "hello", resumeTraceId: "run-abc-1" });
  });

  it("retry after seeing some events: both Last-Event-ID and resumeTraceId are sent", () => {
    const { reqHeaders, reqBody } = shapeRequest({
      payload: { task: "hello", agentMode: "tool" },
      traceId: "run-abc-1",
      lastEventId: "000000000007",
    });
    expect(reqHeaders["Last-Event-ID"]).toBe("000000000007");
    expect(reqBody).toEqual({ task: "hello", agentMode: "tool", resumeTraceId: "run-abc-1" });
  });

  it("preserves caller-supplied headers verbatim and does not overwrite Content-Type", () => {
    const { reqHeaders } = shapeRequest({
      payload: { task: "hello" },
      traceId: "run-abc-1",
      lastEventId: "000000000003",
      baseHeaders: { Authorization: "Bearer xyz", "X-Session-Id": "s1" },
    });
    expect(reqHeaders["Content-Type"]).toBe("application/json");
    expect(reqHeaders.Authorization).toBe("Bearer xyz");
    expect(reqHeaders["X-Session-Id"]).toBe("s1");
    expect(reqHeaders["Last-Event-ID"]).toBe("000000000003");
  });
});

// ── D1 — eventField/channelField option ──────────────────────────────────────
//
// When eventField is set to "type", the hook must match events by their `type`
// field instead of `event`. When channelField is set to null, channel filtering
// is skipped entirely.

function processEventWithFields(
  state: MsgState,
  ev: Record<string, unknown>,
  evField: string,
  chField: string | null,
): MsgState {
  const s = { ...state, messages: [...state.messages] };
  const evType = ev[evField] as string | undefined;
  const chanMatches = (expected: string) => chField === null || (ev[chField] as string | undefined) === expected;

  if (evType === "tool_call" && chanMatches("tool")) {
    const d = ev.data as { toolName: string };
    s.messages.push({ role: "tool", content: `Calling ${d.toolName}…`, toolName: d.toolName });
  } else if (evType === "tool_result" && chanMatches("tool")) {
    const d = ev.data as { toolName: string; error?: unknown };
    const isError = !!d.error;
    s.messages = s.messages.map((m) =>
      m.toolName === d.toolName && m.content.startsWith("Calling")
        ? { ...m, content: isError ? `${d.toolName} failed` : `${d.toolName} done`, isError }
        : m
    );
  } else if (evType === "final_answer" && chanMatches("text")) {
    const answer = String((ev.data as { answer: unknown }).answer ?? "");
    s.finalAnswer = answer;
    s.messages.push({ role: "assistant", content: answer });
    s.status = "complete";
  } else if (evType === "error" && chanMatches("text")) {
    const msg = (ev.data as { error: string }).error ?? "error";
    s.messages.push({ role: "error", content: msg });
    s.status = "error";
  }
  return s;
}

describe("useAgentRun eventField/channelField option (D1)", () => {
  it("handles events with default eventField=event correctly", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEventWithFields(
      state,
      { event: "final_answer", channel: "text", data: { answer: "hello" } },
      "event",
      "channel",
    );
    expect(state.finalAnswer).toBe("hello");
    expect(state.status).toBe("complete");
  });

  it("handles events with eventField=type for Express/Node backends", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEventWithFields(
      state,
      { type: "tool_call", channel: "tool", data: { toolName: "search", callId: "c1" } },
      "type",
      "channel",
    );
    expect(state.messages[0]?.content).toBe("Calling search…");

    state = processEventWithFields(
      state,
      { type: "final_answer", channel: "text", data: { answer: "result" } },
      "type",
      "channel",
    );
    expect(state.finalAnswer).toBe("result");
  });

  it("skips channel filtering when channelField=null", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    // Event has no channel field — but chanMatches always true when chField=null
    state = processEventWithFields(
      state,
      { event: "final_answer", data: { answer: "no-channel" } },
      "event",
      null,
    );
    expect(state.finalAnswer).toBe("no-channel");
  });

  it("does NOT handle event when channel does not match (default behavior)", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    // Send final_answer on wrong channel — should be ignored
    state = processEventWithFields(
      state,
      { event: "final_answer", channel: "wrong", data: { answer: "ignored" } },
      "event",
      "channel",
    );
    expect(state.finalAnswer).toBeNull();
    expect(state.status).toBe("running");
  });

  it("handles type-discriminated tool_call and tool_result pair", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEventWithFields(
      state,
      { type: "tool_call", channel: "tool", data: { toolName: "write", callId: "c2" } },
      "type",
      "channel",
    );
    state = processEventWithFields(
      state,
      { type: "tool_result", channel: "tool", data: { toolName: "write", callId: "c2", error: { message: "boom" } } },
      "type",
      "channel",
    );
    expect(state.messages[0]?.content).toBe("write failed");
    expect(state.messages[0]?.isError).toBe(true);
  });
});

// ── E1 — eventMap option ─────────────────────────────────────────────────────
//
// eventMap lets callers remap incoming event names (from alternative backends)
// to the hook's built-in handler names. We test the mapping + payload
// normalization logic in isolation.

type BuiltinEventName = 'text_delta' | 'tool_call' | 'tool_result' | 'final_answer' | 'thinking_delta' | 'error';

function processEventWithMap(
  state: MsgState,
  ev: Record<string, unknown>,
  evField: string,
  chField: string | null,
  evMap: Partial<Record<string, BuiltinEventName>>,
): MsgState {
  const s = { ...state, messages: [...state.messages] };
  const rawEvType = ev[evField] as string | undefined;
  const evType = (rawEvType !== undefined && evMap[rawEvType] !== undefined)
    ? evMap[rawEvType]
    : rawEvType;
  const chanMatches = (expected: string) => chField === null || (ev[chField] as string | undefined) === expected;

  // Payload normalization — read both nested data.* and top-level ev.* paths.
  const evData = (ev.data as Record<string, unknown> | undefined) ?? {};
  const textDelta = (evData.delta ?? ev.delta ?? "") as string;
  const toolCallName = (evData.toolName ?? ev.name ?? ev.toolName ?? "") as string;
  const toolCallId = (evData.callId ?? ev.call_id ?? ev.callId ?? "") as string;
  const toolResultName = (evData.toolName ?? ev.name ?? ev.toolName ?? "") as string;
  const toolResultCallId = (evData.callId ?? ev.call_id ?? ev.callId ?? "") as string;
  const toolResultOutput = evData.output ?? ev.output;
  const toolResultError = evData.error ?? ev.error;

  if (evType === "text_delta") {
    const text = (s as unknown as Record<string, unknown>)._buf
      ? (((s as unknown as Record<string, unknown>)._buf as string) + textDelta).trim()
      : textDelta.trim();
    if (text) s.messages.push({ role: "assistant", content: text });
  } else if (evType === "tool_call" && chanMatches("tool")) {
    const d = { toolName: toolCallName, callId: toolCallId };
    s.messages.push({ role: "tool", content: `Calling ${d.toolName}…`, toolName: d.toolName });
  } else if (evType === "tool_result" && chanMatches("tool")) {
    const d = { toolName: toolResultName, callId: toolResultCallId, output: toolResultOutput, error: toolResultError };
    const isError = !!d.error;
    s.messages = s.messages.map((m) =>
      m.toolName === d.toolName && m.content.startsWith("Calling")
        ? { ...m, content: isError ? `${d.toolName} failed` : `${d.toolName} done`, isError }
        : m
    );
  } else if (evType === "final_answer" && chanMatches("text")) {
    const answer = String((ev.data as { answer: unknown } | undefined)?.answer ?? "");
    s.finalAnswer = answer;
    s.messages.push({ role: "assistant", content: answer });
    s.status = "complete";
  } else if (evType === "error") {
    const msg = ((ev.data as { error: string } | undefined)?.error ?? ev.error ?? "error") as string;
    s.messages.push({ role: "error", content: msg });
    s.status = "error";
  }
  return s;
}

describe("useAgentRun eventMap option (E1)", () => {
  it("remaps 'text' to 'text_delta' and reads top-level delta field", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEventWithMap(
      state,
      { type: "text", delta: "Hello " },
      "type",
      null,
      { text: "text_delta" },
    );
    state = processEventWithMap(
      state,
      { type: "text", delta: "world" },
      "type",
      null,
      { text: "text_delta" },
    );
    // Each delta appended and pushed as assistant message
    expect(state.messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("remaps 'tool_start' to 'tool_call' and reads top-level name/call_id fields", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEventWithMap(
      state,
      { type: "tool_start", call_id: "c1", name: "search" },
      "type",
      "channel",
      { tool_start: "tool_call" },
    );
    // chanMatches("tool") is false (no channel field), so this should NOT match
    // because chField="channel" and ev.channel is undefined
    expect(state.messages).toHaveLength(0);
  });

  it("remaps 'tool_start' to 'tool_call' with channelField=null (no filter)", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEventWithMap(
      state,
      { type: "tool_start", call_id: "c1", name: "search" },
      "type",
      null,
      { tool_start: "tool_call" },
    );
    expect(state.messages[0]?.content).toBe("Calling search…");
    expect(state.messages[0]?.toolName).toBe("search");
  });

  it("remaps 'tool_end' to 'tool_result' and reads top-level call_id", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    // First add a tool_call message
    state = processEventWithMap(
      state,
      { type: "tool_start", call_id: "c2", name: "write" },
      "type",
      null,
      { tool_start: "tool_call" },
    );
    state = processEventWithMap(
      state,
      { type: "tool_end", call_id: "c2", name: "write", count: 3 },
      "type",
      null,
      { tool_start: "tool_call", tool_end: "tool_result" },
    );
    expect(state.messages[0]?.content).toBe("write done");
    expect(state.messages[0]?.isError).toBeFalsy();
  });

  it("remaps 'tool_end' with error to 'tool_result' with isError=true", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEventWithMap(
      state,
      { type: "tool_start", call_id: "c3", name: "exec" },
      "type",
      null,
      { tool_start: "tool_call", tool_end: "tool_result" },
    );
    state = processEventWithMap(
      state,
      { type: "tool_end", call_id: "c3", name: "exec", error: { message: "timeout" } },
      "type",
      null,
      { tool_start: "tool_call", tool_end: "tool_result" },
    );
    expect(state.messages[0]?.content).toBe("exec failed");
    expect(state.messages[0]?.isError).toBe(true);
  });

  it("passes unmapped events through to onEvent without built-in accumulation", () => {
    // 'ui_action' is not in the map — should not fire any built-in handler
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEventWithMap(
      state,
      { type: "ui_action", action: "show_panel" },
      "type",
      null,
      { text: "text_delta", tool_start: "tool_call" },
    );
    expect(state.messages).toHaveLength(0);
    expect(state.status).toBe("running");
  });

  it("empty eventMap behaves identically to no eventMap (default passthrough)", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    // Standard final_answer with default eventField=event should still work
    state = processEventWithMap(
      state,
      { event: "final_answer", channel: "text", data: { answer: "ok" } },
      "event",
      "channel",
      {},
    );
    expect(state.finalAnswer).toBe("ok");
    expect(state.status).toBe("complete");
  });
});
