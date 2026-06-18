/**
 * RunsAggregator — A4 (S3) tests.
 *
 * Pin behavior across the four axes the Studio overview shows: cost,
 * latency, error rate, eval scores. Each test builds a synthetic event
 * stream that exercises one branch of the aggregator.
 */
import type { LoggedEvent } from "./EventLogReplay.js";
import { groupByTraceId, type RunSummary, rollupRuns, summariseRun } from "./RunsAggregator.js";

function ev(
  traceId: string,
  timestampMs: number,
  event: string,
  data: unknown = {},
  channel: "status" | "model" | "text" = "status"
): LoggedEvent {
  return {
    eventId: `${traceId}-${timestampMs}-${event}`,
    // We cast through `unknown` because the `AgentEvent` discriminated union
    // does not include synthetic event names like `step_end` / `human_response`
    // / `eval_score` that some upstream emitters add. The aggregator handles
    // those defensively via a string switch (see `RunsAggregator.summariseRun`),
    // so the cast here is intentional — the test fixture builds shapes the
    // union does not enumerate.
    event: {
      traceId,
      parentTraceId: null,
      timestampMs,
      channel,
      event,
      data,
    } as unknown as LoggedEvent["event"],
  };
}

describe("summariseRun", () => {
  it("rolls token + cost from model_done events", () => {
    const events: LoggedEvent[] = [
      ev("t1", 1000, "step_start"),
      ev(
        "t1",
        2000,
        "model_done",
        {
          modelId: "x",
          step: 1,
          finishReason: "stop",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          estimatedUsd: 0.01,
        },
        "model"
      ),
      ev("t1", 2100, "step_end"),
      ev("t1", 2200, "final_answer", { answer: "42" }, "text"),
    ];
    const s = summariseRun(events);
    expect(s.outcome).toBe("complete");
    expect(s.finalAnswer).toBe("42");
    expect(s.tokens.input).toBe(100);
    expect(s.tokens.output).toBe(50);
    expect(s.tokens.cacheRead).toBe(20);
    expect(s.costUsd).toBeCloseTo(0.01, 6);
    expect(s.modelCalls).toBe(1);
    expect(s.steps).toBe(1);
    expect(s.activeMs).toBe(1100);
  });

  it("subtracts HITL pause from wallMs", () => {
    const events: LoggedEvent[] = [
      ev("t1", 1000, "step_start"),
      ev("t1", 1500, "await_human_input", { promptId: "p", prompt: "?" }),
      ev("t1", 5500, "human_response", { promptId: "p", response: "ok" }),
      ev("t1", 6000, "final_answer", { answer: "ok" }, "text"),
    ];
    const s = summariseRun(events);
    // pauseMs = 4000; raw wall = 5000; reported wall = 1000.
    expect(s.wallMs).toBe(1000);
  });

  it("flips outcome to failed when error present and no final_answer", () => {
    const events: LoggedEvent[] = [
      ev("t1", 1000, "step_start"),
      ev("t1", 1100, "error", { error: "boom" }),
    ];
    const s = summariseRun(events);
    expect(s.outcome).toBe("failed");
    expect(s.errorCount).toBe(1);
  });

  it("keeps outcome=complete when an error is followed by a final_answer (recoverable)", () => {
    const events: LoggedEvent[] = [
      ev("t1", 1000, "step_start"),
      ev("t1", 1100, "error", { error: "transient" }),
      ev("t1", 1200, "final_answer", { answer: "recovered" }, "text"),
    ];
    const s = summariseRun(events);
    expect(s.outcome).toBe("complete");
    expect(s.errorCount).toBe(1);
  });

  it("captures eval scores", () => {
    const events: LoggedEvent[] = [
      ev("t1", 1000, "step_start"),
      ev("t1", 1500, "eval_score", { scorer: "faithfulness", score: 0.92 }),
      ev("t1", 1600, "eval_score", { scorer: "answer_relevance", score: 0.81 }),
      ev("t1", 1800, "final_answer", { answer: "yes" }, "text"),
    ];
    const s = summariseRun(events);
    expect(s.evalScores).toEqual({ faithfulness: 0.92, answer_relevance: 0.81 });
  });
});

describe("rollupRuns", () => {
  it("computes median + p95 wall, error rate, and eval series", () => {
    const summaries: RunSummary[] = [
      // 5 runs of varying wall times.
      makeSummary({ traceId: "r1", startTs: 1, wallMs: 100 }),
      makeSummary({ traceId: "r2", startTs: 2, wallMs: 200 }),
      makeSummary({ traceId: "r3", startTs: 3, wallMs: 300, errorCount: 1, outcome: "failed" }),
      makeSummary({
        traceId: "r4",
        startTs: 4,
        wallMs: 400,
        evalScores: { faithfulness: 0.9 },
      }),
      makeSummary({
        traceId: "r5",
        startTs: 5,
        wallMs: 1000,
        evalScores: { faithfulness: 0.8 },
      }),
    ];
    const rollup = rollupRuns(summaries);
    expect(rollup.totalRuns).toBe(5);
    expect(rollup.failed).toBe(1);
    expect(rollup.completed).toBe(4);
    expect(rollup.errorRate).toBeCloseTo(1 / 5, 6);
    expect(rollup.medianWallMs).toBe(300);
    // p95 across [100,200,300,400,1000] = linear interp between idx 3 (400)
    // and idx 4 (1000) at fraction 0.8 → 400 + 0.8 * 600 = 880.
    expect(rollup.p95WallMs).toBeCloseTo(880, 1);
    expect(rollup.evalScoreSeries.faithfulness).toEqual([0.9, 0.8]);
  });

  it("returns zeros for empty input", () => {
    const rollup = rollupRuns([]);
    expect(rollup.totalRuns).toBe(0);
    expect(rollup.medianWallMs).toBe(0);
    expect(rollup.p95WallMs).toBe(0);
    expect(rollup.errorRate).toBe(0);
  });
});

describe("groupByTraceId", () => {
  it("partitions events by traceId, preserving order within each bucket", () => {
    const events: LoggedEvent[] = [
      ev("a", 1, "step_start"),
      ev("b", 2, "step_start"),
      ev("a", 3, "step_end"),
      ev("a", 4, "final_answer", { answer: "ok" }),
      ev("b", 5, "error", { error: "bad" }),
    ];
    const grouped = groupByTraceId(events);
    expect(grouped.size).toBe(2);
    expect(grouped.get("a")?.map((e) => e.event.event)).toEqual([
      "step_start",
      "step_end",
      "final_answer",
    ]);
    expect(grouped.get("b")?.map((e) => e.event.event)).toEqual(["step_start", "error"]);
  });
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeSummary(overrides: Partial<RunSummary>): RunSummary {
  const base: RunSummary = {
    traceId: overrides.traceId ?? "x",
    startTs: overrides.startTs ?? 0,
    endTs: (overrides.startTs ?? 0) + (overrides.wallMs ?? 0),
    wallMs: overrides.wallMs ?? 0,
    activeMs: overrides.activeMs ?? overrides.wallMs ?? 0,
    outcome: overrides.outcome ?? "complete",
    finalAnswer: overrides.finalAnswer ?? "ok",
    errorCount: overrides.errorCount ?? 0,
    tokens: overrides.tokens ?? { input: 0, output: 0, cacheRead: 0, thinking: 0 },
    costUsd: overrides.costUsd ?? 0,
    modelCalls: overrides.modelCalls ?? 0,
    steps: overrides.steps ?? 0,
    evalScores: overrides.evalScores ?? {},
  };
  return base;
}
