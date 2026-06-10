import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../types/events.js";
import {
  type AgentTrace,
  compositeScorer,
  constraintScorer,
  type EvalSample,
  efficiencyScorer,
  exactMatch,
  recoveryScorer,
} from "./index.js";

const traceShell = (extras: Partial<AgentTrace> = {}): AgentTrace => ({
  traceId: "t1",
  task: "test",
  events: [],
  finalAnswer: "ok",
  toolCalls: [],
  toolResults: [],
  ...extras,
});

const sample: EvalSample = { id: "s1", task: "test" };

describe("efficiencyScorer", () => {
  it("returns 1 with no budgets", () => {
    const r = efficiencyScorer().score(traceShell(), sample);
    expect(r.score).toBe(1);
  });

  it("returns 1 when within all budgets", () => {
    const events: AgentEvent[] = [
      {
        traceId: "t1",
        parentTraceId: null,
        timestampMs: 1000,
        channel: "model",
        event: "model_done",
        data: {
          modelId: "m",
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.001,
          step: 0,
        } as never,
      } as never,
      {
        traceId: "t1",
        parentTraceId: null,
        timestampMs: 5000,
        channel: "thinking",
        event: "step_start",
        data: { step: 0 } as never,
      } as never,
    ];
    const r = efficiencyScorer({
      maxTokens: 1000,
      maxDurationMs: 60_000,
      maxCostUsd: 0.5,
      maxSteps: 10,
    }).score(traceShell({ events }), sample);
    expect(r.score).toBe(1);
  });

  it("returns < 1 when over a budget", () => {
    const events: AgentEvent[] = [
      {
        traceId: "t1",
        parentTraceId: null,
        timestampMs: 1000,
        channel: "model",
        event: "model_done",
        data: { modelId: "m", inputTokens: 5000, outputTokens: 0, step: 0 } as never,
      } as never,
    ];
    const r = efficiencyScorer({ maxTokens: 1000 }).score(traceShell({ events }), sample);
    expect(r.score).toBeLessThan(1);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });
});

describe("constraintScorer", () => {
  it("passes when no constraints", () => {
    const r = constraintScorer({}).score(traceShell(), sample);
    expect(r.score).toBe(1);
  });

  it("fails when required tool missing", () => {
    const r = constraintScorer({ mustUseTool: ["search"] }).score(
      traceShell({ toolCalls: [{ toolName: "calc", args: {}, callId: "c1" }] }),
      sample
    );
    expect(r.score).toBe(0);
    expect(r.detail).toMatch(/missing tool/);
  });

  it("passes when all constraints satisfied", () => {
    const r = constraintScorer({
      mustUseTool: ["search"],
      mustContain: ["answer"],
      maxLength: 200,
    }).score(
      traceShell({
        toolCalls: [{ toolName: "search", args: {}, callId: "c1" }],
        finalAnswer: "the answer is 42",
      }),
      sample
    );
    expect(r.score).toBe(1);
  });

  it("fails on forbidden phrase", () => {
    const r = constraintScorer({ mustNotContain: ["secret"] }).score(
      traceShell({ finalAnswer: "the secret is X" }),
      sample
    );
    expect(r.score).toBe(0);
  });
});

describe("recoveryScorer", () => {
  it("returns 1 with no failures", () => {
    expect(recoveryScorer().score(traceShell(), sample).score).toBe(1);
  });

  it("returns 0 when failure with no following success", () => {
    const r = recoveryScorer().score(
      traceShell({
        toolResults: [{ toolName: "x", output: null, callId: "c1", isError: true }],
      }),
      sample
    );
    expect(r.score).toBe(0);
  });

  it("returns 1 when all failures recovered", () => {
    const r = recoveryScorer().score(
      traceShell({
        toolResults: [
          { toolName: "x", output: null, callId: "c1", isError: true },
          { toolName: "x", output: "ok", callId: "c2", isError: false },
        ],
      }),
      sample
    );
    expect(r.score).toBe(1);
  });

  it("returns fraction for mixed", () => {
    const r = recoveryScorer().score(
      traceShell({
        toolResults: [
          { toolName: "x", output: null, callId: "c1", isError: true },
          { toolName: "x", output: "ok", callId: "c2", isError: false },
          { toolName: "y", output: null, callId: "c3", isError: true },
        ],
      }),
      sample
    );
    // Failure c1 followed by success c2 → recovered=1
    // Failure c3 has no subsequent success → not recovered
    expect(r.score).toBeCloseTo(0.5, 5);
  });
});

describe("compositeScorer", () => {
  it("returns 0 when given no scorers", () => {
    expect(compositeScorer([]).score(traceShell(), sample).score).toBe(0);
  });

  it("computes weighted mean", () => {
    const cmp = compositeScorer([
      { scorer: { name: "always1", score: () => ({ scorer: "always1", score: 1 }) }, weight: 1 },
      { scorer: { name: "always0", score: () => ({ scorer: "always0", score: 0 }) }, weight: 1 },
    ]);
    const r = cmp.score(traceShell(), sample);
    expect(r.score).toBeCloseTo(0.5, 5);
  });

  it("respects weight ratios", () => {
    const cmp = compositeScorer([
      { scorer: { name: "always1", score: () => ({ scorer: "always1", score: 1 }) }, weight: 3 },
      { scorer: { name: "always0", score: () => ({ scorer: "always0", score: 0 }) }, weight: 1 },
    ]);
    expect(cmp.score(traceShell(), sample).score).toBeCloseTo(0.75, 5);
  });

  it("can use exactMatch as a sub-scorer", () => {
    const cmp = compositeScorer([{ scorer: exactMatch, weight: 1 }]);
    const r = cmp.score(traceShell({ finalAnswer: "yes" }), { ...sample, expectedAnswer: "yes" });
    expect(r.score).toBe(1);
  });
});
