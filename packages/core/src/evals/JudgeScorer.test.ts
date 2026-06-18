/**
 * A4 — JudgeScorer tests.
 *
 * Verify the contract from JudgeScorer.ts:
 *   - parses SCORES / REASONING blocks the prompt asks the judge to emit
 *   - applies criterion weights into the composite
 *   - normalises raw scores to [0, 1] regardless of the underlying scale
 *   - missing criteria default to 0 with a "(judge did not score…)" note
 *   - built-in trajectoryQualityJudge / answerCompletenessJudge wire up
 */

import type { Model, ModelMessage, StreamEvent } from "../models/types.js";
import type { AgentTrace } from "./index.js";
import {
  ANSWER_COMPLETENESS_CRITERIA,
  answerCompletenessJudge,
  judgeScorer,
  runJudgeScorer,
  TRAJECTORY_QUALITY_CRITERIA,
  trajectoryQualityJudge,
} from "./JudgeScorer.js";

function mockModel(reply: string): Model {
  return {
    providerId: "mock/judge",
    async *generate(_messages: ModelMessage[]): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: reply };
      yield { type: "stop", stopReason: "end_turn" };
    },
  };
}

const trace: AgentTrace = {
  traceId: "t1",
  task: "do the thing",
  events: [],
  toolCalls: [{ toolName: "read_file", args: { path: "x" }, callId: "c1" }],
  toolResults: [{ toolName: "read_file", output: "content", callId: "c1", isError: false }],
  finalAnswer: "did the thing",
};

describe("JudgeScorer", () => {
  it("returns a sentinel score from the synchronous Scorer surface", () => {
    const scorer = judgeScorer({
      name: "demo",
      model: mockModel("ignored"),
      criteria: [{ id: "a", description: "x" }],
    });
    const result = scorer.score(trace, { id: "s1", task: "x" });
    expect(result.score).toBe(0);
    expect(result.detail).toMatch(/runJudgeScorer/);
    expect(result.scorer).toBe("demo");
  });

  it("parses scores + reasoning the judge emits", async () => {
    const reply = `SCORES
coverage: 8 (covered all parts)
actionability: 6 (somewhat vague)
honesty: 9 (clearly flagged uncertainty)

REASONING
Mostly complete; the actionability hit cost a few points.`;
    const result = await runJudgeScorer(trace, {
      name: "completeness",
      model: mockModel(reply),
      criteria: ANSWER_COMPLETENESS_CRITERIA,
    });
    expect(result.breakdown.length).toBe(3);
    expect(result.breakdown[0]).toMatchObject({ criterionId: "coverage", raw: 8, normalized: 0.8 });
    expect(result.breakdown[1]?.normalized).toBeCloseTo(0.6, 5);
    expect(result.breakdown[2]?.reasoning).toContain("uncertainty");
    // Composite is the simple mean (all weights default to 1).
    expect(result.score).toBeCloseTo((8 + 6 + 9) / 30, 5);
  });

  it("applies non-uniform weights to the composite", async () => {
    const reply = `SCORES
a: 10 (max)
b: 0 (zero)`;
    const result = await runJudgeScorer(trace, {
      name: "weighted",
      model: mockModel(reply),
      criteria: [
        { id: "a", description: "main", weight: 4 },
        { id: "b", description: "minor", weight: 1 },
      ],
    });
    // Weighted: (4 * 1.0 + 1 * 0.0) / 5 = 0.8
    expect(result.score).toBeCloseTo(0.8, 5);
  });

  it("respects a custom scale (e.g. 5-point scoring)", async () => {
    const reply = `SCORES
quality: 4`;
    const result = await runJudgeScorer(trace, {
      name: "five-point",
      model: mockModel(reply),
      criteria: [{ id: "quality", description: "x" }],
      scale: 5,
    });
    expect(result.breakdown[0]?.normalized).toBe(0.8);
    expect(result.score).toBe(0.8);
  });

  it("missing criteria default to 0 with a placeholder reason", async () => {
    const reply = `SCORES
present: 8 (good)`;
    const result = await runJudgeScorer(trace, {
      name: "missing",
      model: mockModel(reply),
      criteria: [
        { id: "present", description: "x" },
        { id: "absent", description: "y" },
      ],
    });
    expect(result.breakdown[1]?.normalized).toBe(0);
    expect(result.breakdown[1]?.reasoning).toContain("did not score");
  });

  it("clamps out-of-range scores to [0, scale]", async () => {
    const reply = `SCORES
a: 999 (exceeds)
b: -3 (negative)`;
    const result = await runJudgeScorer(trace, {
      name: "clamp",
      model: mockModel(reply),
      criteria: [
        { id: "a", description: "x" },
        { id: "b", description: "y" },
      ],
    });
    expect(result.breakdown[0]?.raw).toBe(10);
    expect(result.breakdown[1]?.raw).toBe(0);
  });

  it("trajectoryQualityJudge wires up the built-in criteria", async () => {
    const reply = `SCORES
efficiency: 7
tool-fit: 8
self-correction: 9`;
    const opts = trajectoryQualityJudge(mockModel(reply));
    expect(opts.name).toBe("trajectoryQuality");
    expect(opts.criteria).toBe(TRAJECTORY_QUALITY_CRITERIA);
    const result = await runJudgeScorer(trace, opts);
    expect(result.breakdown.map((b) => b.criterionId)).toEqual([
      "efficiency",
      "tool-fit",
      "self-correction",
    ]);
    expect(result.score).toBeCloseTo((7 + 8 + 9) / 30, 5);
  });

  it("answerCompletenessJudge wires up the built-in criteria", async () => {
    const reply = `SCORES
coverage: 9
actionability: 9
honesty: 10`;
    const opts = answerCompletenessJudge(mockModel(reply));
    expect(opts.name).toBe("answerCompleteness");
    expect(opts.criteria).toBe(ANSWER_COMPLETENESS_CRITERIA);
    const result = await runJudgeScorer(trace, opts);
    expect(result.score).toBeGreaterThan(0.9);
  });
});
