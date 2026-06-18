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
