import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "../types/events.js";
import type { RankedBranch } from "./RolloutRanker.js";
import { RolloutSFTAnnotator } from "./RolloutSFTAnnotator.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeEvent(
  overrides: Partial<AgentEvent> & Pick<AgentEvent, "event" | "channel" | "data">
): AgentEvent {
  return {
    traceId: "t1",
    parentTraceId: null,
    timestampMs: Date.now(),
    ...overrides,
  } as AgentEvent;
}

function makeRankedBranch(overrides?: Partial<RankedBranch>): RankedBranch {
  return {
    branchIndex: 0,
    rank: 1,
    objectiveScore: 1,
    judgeScore: 8,
    totalScore: 1.24,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("RolloutSFTAnnotator", () => {
  const annotator = new RolloutSFTAnnotator();

  test("recovery bucket: assistant turn after tool_result with error", () => {
    const trajectory: AgentEvent[] = [
      makeEvent({
        channel: "tool",
        event: "tool_result",
        data: {
          callId: "c1",
          toolName: "run_code",
          output: "",
          error: { code: "execution_error", message: "ENOENT" },
          batchId: "b1",
          batchSize: 1,
          stepIndex: 1,
        },
      }),
      makeEvent({
        channel: "model",
        event: "model_done",
        data: { modelId: "sonnet", step: 2, finishReason: "end_turn" },
      }),
    ];

    const result = annotator.annotate(trajectory, makeRankedBranch());
    expect(result).toHaveLength(1);
    expect(result[0]!.turnIndex).toBe(1);
    expect(result[0]!.lossWeightTokens).toBe("recovery");
  });

  test("state_summary bucket: model_done with content followed by tool_call", () => {
    const trajectory: AgentEvent[] = [
      makeEvent({
        channel: "model",
        event: "model_done",
        data: { modelId: "sonnet", step: 1, finishReason: "end_turn" },
      }),
      makeEvent({
        channel: "tool",
        event: "tool_call",
        data: {
          toolName: "read_file",
          args: { path: "/tmp/x" },
          callId: "c2",
          batchId: "b2",
          batchSize: 1,
          stepIndex: 2,
        },
      }),
    ];

    const result = annotator.annotate(trajectory, makeRankedBranch());
    expect(result).toHaveLength(1);
    expect(result[0]!.turnIndex).toBe(0);
    expect(result[0]!.lossWeightTokens).toBe("state_summary");
  });

  test("high_value bucket: assistant turn before successful tool_result in high-scoring branch", () => {
    const trajectory: AgentEvent[] = [
      makeEvent({
        channel: "model",
        event: "model_done",
        data: { modelId: "sonnet", step: 1, finishReason: "end_turn" },
      }),
      makeEvent({
        channel: "tool",
        event: "tool_result",
        data: {
          callId: "c3",
          toolName: "run_code",
          output: "ok",
          batchId: "b3",
          batchSize: 1,
          stepIndex: 2,
        },
      }),
    ];

    // High-scoring branch: objectiveScore=1, totalScore well above threshold+0.5
    const branch = makeRankedBranch({ objectiveScore: 1, totalScore: 1.3 });
    const result = annotator.annotate(trajectory, branch);
    expect(result).toHaveLength(1);
    expect(result[0]!.turnIndex).toBe(0);
    expect(result[0]!.lossWeightTokens).toBe("high_value");
  });

  test("default bucket: no special signal present", () => {
    const trajectory: AgentEvent[] = [
      makeEvent({
        channel: "text",
        event: "final_answer",
        data: { answer: "done" },
      }),
    ];

    // Low-scoring branch so high_value rule does not fire
    const branch = makeRankedBranch({ objectiveScore: 0, totalScore: 0.3 });
    const result = annotator.annotate(trajectory, branch);
    expect(result).toHaveLength(1);
    expect(result[0]!.turnIndex).toBe(0);
    expect(result[0]!.lossWeightTokens).toBe("default");
  });

  test("empty trajectory returns empty annotations", () => {
    const result = annotator.annotate([], makeRankedBranch());
    expect(result).toEqual([]);
  });
});
