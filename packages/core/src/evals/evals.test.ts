import { describe, it, expect } from "vitest";
import {
  exactMatch,
  toolCallAccuracy,
  trajectoryValidity,
  finalAnswerLength,
  collectTrace,
  runEval,
} from "../evals/index.js";
import type { AgentEvent } from "../types/events.js";

function makeTrace(finalAnswer: string | null, toolNames: string[] = []) {
  const events: AgentEvent[] = [];
  for (let i = 0; i < toolNames.length; i++) {
    const callId = `call-${i}`;
    events.push({ traceId: "t1", parentTraceId: null, channel: "tool", event: "tool_call", data: { toolName: toolNames[i]!, args: {}, callId, batchId: "b", batchSize: 1, stepIndex: i }, timestampMs: 0 });
    events.push({ traceId: "t1", parentTraceId: null, channel: "tool", event: "tool_result", data: { toolName: toolNames[i]!, callId, output: "ok", batchId: "b", batchSize: 1, stepIndex: i }, timestampMs: 0 });
  }
  if (finalAnswer !== null) {
    events.push({ traceId: "t1", parentTraceId: null, channel: "text", event: "final_answer", data: { answer: finalAnswer }, timestampMs: 0 });
  }
  return collectTrace("test task", events);
}

describe("exactMatch scorer (B1)", () => {
  it("returns 1 for exact match", () => {
    const trace = makeTrace("Paris");
    const result = exactMatch.score(trace, { id: "1", task: "capital?", expectedAnswer: "Paris" });
    expect(result.score).toBe(1);
  });

  it("returns 1 for case-insensitive match", () => {
    const trace = makeTrace("paris");
    const result = exactMatch.score(trace, { id: "1", task: "capital?", expectedAnswer: "PARIS" });
    expect(result.score).toBe(1);
  });

  it("returns 0 for mismatch", () => {
    const trace = makeTrace("London");
    const result = exactMatch.score(trace, { id: "1", task: "capital?", expectedAnswer: "Paris" });
    expect(result.score).toBe(0);
  });

  it("returns 0 for null finalAnswer", () => {
    const trace = makeTrace(null);
    const result = exactMatch.score(trace, { id: "1", task: "?", expectedAnswer: "Paris" });
    expect(result.score).toBe(0);
  });
});

describe("toolCallAccuracy scorer (B1)", () => {
  it("returns 1 for exact tool sequence match", () => {
    const trace = makeTrace("ok", ["search", "read"]);
    const result = toolCallAccuracy.score(trace, { id: "1", task: "", expectedTools: ["search", "read"] });
    expect(result.score).toBe(1);
  });

  it("returns lower score for wrong order (A1 DoD: wrong order < correct order)", () => {
    const traceCorrect = makeTrace("ok", ["search", "read"]);
    const traceWrong = makeTrace("ok", ["read", "search"]);
    const correct = toolCallAccuracy.score(traceCorrect, { id: "1", task: "", expectedTools: ["search", "read"] });
    const wrong = toolCallAccuracy.score(traceWrong, { id: "1", task: "", expectedTools: ["search", "read"] });
    expect(correct.score).toBeGreaterThan(wrong.score);
  });

  it("returns lower score for extra/missing tools", () => {
    const trace = makeTrace("ok", ["search"]);
    const result = toolCallAccuracy.score(trace, { id: "1", task: "", expectedTools: ["search", "read", "write"] });
    expect(result.score).toBeLessThan(1);
  });

  it("returns 1 when no expectedTools specified", () => {
    const trace = makeTrace("ok", ["anything"]);
    const result = toolCallAccuracy.score(trace, { id: "1", task: "" });
    expect(result.score).toBe(1);
  });
});

describe("trajectoryValidity scorer (B1)", () => {
  it("returns 1 when all tool_calls have matching tool_results", () => {
    const trace = makeTrace("ok", ["search"]);
    expect(trajectoryValidity.score(trace, { id: "1", task: "" }).score).toBe(1);
  });

  it("returns 1 when there are no tool calls", () => {
    const trace = makeTrace("ok", []);
    expect(trajectoryValidity.score(trace, { id: "1", task: "" }).score).toBe(1);
  });

  it("returns fractional score when some results are missing", () => {
    // Manually craft a trace with 2 calls but only 1 result.
    const events: AgentEvent[] = [
      { traceId: "t", parentTraceId: null, channel: "tool", event: "tool_call", data: { toolName: "a", args: {}, callId: "c1", batchId: "b", batchSize: 2, stepIndex: 1 }, timestampMs: 0 },
      { traceId: "t", parentTraceId: null, channel: "tool", event: "tool_call", data: { toolName: "b", args: {}, callId: "c2", batchId: "b", batchSize: 2, stepIndex: 1 }, timestampMs: 0 },
      { traceId: "t", parentTraceId: null, channel: "tool", event: "tool_result", data: { toolName: "a", callId: "c1", output: "ok", batchId: "b", batchSize: 2, stepIndex: 1 }, timestampMs: 0 },
    ];
    const trace = collectTrace("task", events);
    expect(trajectoryValidity.score(trace, { id: "1", task: "" }).score).toBe(0.5);
  });
});

describe("finalAnswerLength scorer (B1)", () => {
  it("returns 1 for answer at or above target length", () => {
    const trace = makeTrace("x".repeat(300));
    expect(finalAnswerLength(200).score(trace, { id: "1", task: "" }).score).toBe(1);
  });

  it("returns proportional score for shorter answer", () => {
    const trace = makeTrace("x".repeat(100));
    expect(finalAnswerLength(200).score(trace, { id: "1", task: "" }).score).toBeCloseTo(0.5);
  });
});

describe("runEval (B1)", () => {
  it("runs samples and returns scores for each", async () => {
    async function* mockRunner(task: string): AsyncGenerator<AgentEvent> {
      yield { traceId: "t", parentTraceId: null, channel: "text", event: "final_answer", data: { answer: task === "capital of France?" ? "Paris" : "wrong" }, timestampMs: 0 };
    }

    const dataset = [
      { id: "1", task: "capital of France?", expectedAnswer: "Paris" },
      { id: "2", task: "capital of Germany?", expectedAnswer: "Berlin" },
    ];

    const results = await runEval(dataset, mockRunner, [exactMatch]);
    expect(results).toHaveLength(2);
    expect(results[0]!.scores[0]!.score).toBe(1);  // "Paris" matches
    expect(results[1]!.scores[0]!.score).toBe(0);  // "wrong" doesn't match "Berlin"
  });
});
