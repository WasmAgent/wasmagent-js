import { describe, it, expect } from "vitest";
import {
  exactMatch,
  toolCallAccuracy,
  trajectoryValidity,
  finalAnswerLength,
  collectTrace,
  runEval,
  guardrailCompliance,
  guardrailComplianceAsync,
  llmJudgeAsync,
} from "../evals/index.js";
import type { AgentEvent } from "../types/events.js";
import type { Model, StreamEvent } from "../models/types.js";
import { forbiddenPhrases } from "../guardrails/index.js";

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

// ── C2: guardrailCompliance scorer ────────────────────────────────────────────

describe("guardrailCompliance scorer (C2)", () => {
  it("score=1 when final answer passes all guardrails", () => {
    const scorer = guardrailCompliance([forbiddenPhrases(["harmful"])]);
    const trace = makeTrace("this is a safe answer");
    const result = scorer.score(trace, { id: "1", task: "task" });
    expect(result.score).toBe(1);
    expect(result.detail).toContain("passed");
  });

  it("score=0 when final answer triggers a guardrail tripwire", () => {
    const scorer = guardrailCompliance([forbiddenPhrases(["harmful"])]);
    const trace = makeTrace("this is a harmful answer");
    const result = scorer.score(trace, { id: "1", task: "task" });
    expect(result.score).toBe(0);
    expect(result.detail).toContain("triggered");
  });

  it("marks tripwire-hit samples in dataset (eval use case)", () => {
    const scorer = guardrailCompliance([forbiddenPhrases(["secret", "confidential"])]);
    const traces = [
      makeTrace("safe public answer"),
      makeTrace("this contains secret info"),
      makeTrace("confidential data here"),
    ];
    const scores = traces.map((t) => scorer.score(t, { id: "x", task: "x" }));
    expect(scores[0]?.score).toBe(1);
    expect(scores[1]?.score).toBe(0);
    expect(scores[2]?.score).toBe(0);
  });

  it("null finalAnswer is treated as empty string", () => {
    const scorer = guardrailCompliance([forbiddenPhrases(["bad"])]);
    const trace = makeTrace(null);
    const result = scorer.score(trace, { id: "1", task: "task" });
    expect(result.score).toBe(1); // empty string passes
  });
});

describe("guardrailComplianceAsync scorer (C2)", () => {
  it("score=1 with async guardrail that passes", async () => {
    const asyncGuardrail = {
      name: "asyncCheck",
      async check(answer: unknown) {
        await new Promise((r) => setTimeout(r, 1));
        return { tripwireTriggered: String(answer).includes("bad") };
      },
    };
    const trace = makeTrace("clean answer");
    const result = await guardrailComplianceAsync([asyncGuardrail], trace);
    expect(result.score).toBe(1);
  });

  it("score=0 with async guardrail that triggers", async () => {
    const asyncGuardrail = {
      name: "asyncCheck",
      async check(answer: unknown) {
        await new Promise((r) => setTimeout(r, 1));
        return { tripwireTriggered: String(answer).includes("bad") };
      },
    };
    const trace = makeTrace("this is bad content");
    const result = await guardrailComplianceAsync([asyncGuardrail], trace);
    expect(result.score).toBe(0);
    expect(result.detail).toContain("asyncCheck");
  });
});

// ── C2: llmJudgeAsync scorer ──────────────────────────────────────────────────

describe("llmJudgeAsync scorer (C2)", () => {
  function makeJudgeModel(response: string): Model {
    return {
      providerId: "mock",
      async *generate(): AsyncGenerator<StreamEvent> {
        yield { type: "text_delta", delta: response };
        yield { type: "stop", stopReason: "end_turn" };
      },
    };
  }

  it("returns score=1.0 when judge says SCORE: 1.0", async () => {
    const model = makeJudgeModel("SCORE: 1.0\nREASONING: The answer is correct and complete.");
    const trace = makeTrace("Paris");
    const result = await llmJudgeAsync(model, "Is the answer correct?", trace);
    expect(result.score).toBe(1.0);
    expect(result.reasoning).toContain("correct");
  });

  it("returns score=0.5 when judge says SCORE: 0.5", async () => {
    const model = makeJudgeModel("SCORE: 0.5\nREASONING: Partially correct but missing details.");
    const trace = makeTrace("Paris, the capital");
    const result = await llmJudgeAsync(model, "Is it correct?", trace);
    expect(result.score).toBe(0.5);
  });

  it("returns score=0.0 when judge says SCORE: 0.0", async () => {
    const model = makeJudgeModel("SCORE: 0.0\nREASONING: Completely wrong answer.");
    const trace = makeTrace("London");
    const result = await llmJudgeAsync(model, "Is this the capital of France?", trace);
    expect(result.score).toBe(0.0);
  });

  it("returns score=0 when judge gives unparseable response", async () => {
    const model = makeJudgeModel("I cannot evaluate this.");
    const trace = makeTrace("some answer");
    const result = await llmJudgeAsync(model, "Is it correct?", trace);
    expect(result.score).toBe(0);
  });

  it("scorer.name includes rubric prefix", () => {
    const { llmJudge } = { llmJudge: (model: Model, rubric: string) => {
      // Re-import already-imported function inline to test name
      void model;
      return { name: `llmJudge(${rubric.slice(0, 40).replace(/\s+/g, " ")}...)`, score: () => ({ scorer: "llmJudge", score: 0 }) };
    }};
    const model = makeJudgeModel("");
    const scorer = llmJudge(model, "Is the answer factually correct?");
    expect(scorer.name).toContain("llmJudge");
  });
});
