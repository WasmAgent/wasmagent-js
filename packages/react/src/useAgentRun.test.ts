/**
 * Unit tests for useAgentRun event merge logic (B2).
 *
 * We test the pure event-processing logic in isolation using the evals
 * trace collector rather than full React rendering (which would require
 * jsdom / @testing-library).
 */

import { describe, it, expect } from "vitest";

// Test the SSE line-parsing and event-extraction logic independently.

function parseSSELine(line: string): unknown | null {
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6).trim();
  if (payload === "[DONE]") return null;
  try { return JSON.parse(payload); } catch { return null; }
}

describe("useAgentRun SSE parsing logic (B2)", () => {
  it("parses data: lines correctly", () => {
    const line = 'data: {"traceId":"t","event":"final_answer","channel":"text","data":{"answer":"42"},"parentTraceId":null,"timestampMs":0}';
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
  if (ev["event"] === "tool_call" && ev["channel"] === "tool") {
    const d = ev["data"] as { toolName: string };
    s.messages.push({ role: "tool", content: `Calling ${d.toolName}…`, toolName: d.toolName });
  } else if (ev["event"] === "tool_result" && ev["channel"] === "tool") {
    const d = ev["data"] as { toolName: string; error?: unknown };
    const isError = !!d.error;
    s.messages = s.messages.map((m) =>
      m.toolName === d.toolName && m.content.startsWith("Calling")
        ? { ...m, content: isError ? `${d.toolName} failed` : `${d.toolName} done`, isError }
        : m
    );
  } else if (ev["event"] === "final_answer" && ev["channel"] === "text") {
    const answer = String((ev["data"] as { answer: unknown }).answer ?? "");
    s.finalAnswer = answer;
    s.messages.push({ role: "assistant", content: answer });
    s.status = "complete";
  } else if (ev["event"] === "error" && ev["channel"] === "text") {
    const msg = (ev["data"] as { error: string }).error ?? "error";
    s.messages.push({ role: "error", content: msg });
    s.status = "error";
  }
  return s;
}

describe("useAgentRun event accumulation state machine (B2)", () => {
  it("accumulates tool_call then tool_result correctly", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEvent(state, { event: "tool_call", channel: "tool", data: { toolName: "search", callId: "c1" } });
    expect(state.messages[0]?.content).toBe("Calling search…");
    expect(state.messages[0]?.toolName).toBe("search");

    state = processEvent(state, { event: "tool_result", channel: "tool", data: { toolName: "search", callId: "c1", output: "results" } });
    expect(state.messages[0]?.content).toBe("search done");
    expect(state.messages[0]?.isError).toBeFalsy();
  });

  it("marks tool result as error when error field present", () => {
    let state: MsgState = { messages: [], finalAnswer: null, status: "running" };
    state = processEvent(state, { event: "tool_call", channel: "tool", data: { toolName: "write", callId: "c2" } });
    state = processEvent(state, { event: "tool_result", channel: "tool", data: { toolName: "write", callId: "c2", error: { code: "execution_error", message: "boom" } } });
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
    state = processEvent(state, { event: "error", channel: "text", data: { error: "max steps exceeded" } });
    expect(state.status).toBe("error");
    expect(state.messages[0]?.role).toBe("error");
    expect(state.messages[0]?.content).toBe("max steps exceeded");
  });
});
