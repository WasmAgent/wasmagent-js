import type { RolloutBranchResult } from "../enhancement/RolloutForkRunner.js";
import type { AgentEvent } from "../types/events.js";
import { toDpoRecord, toJsonl, toPpoRecords } from "./RolloutExporter.js";
import type { RankedBranch } from "./RolloutRanker.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeBranch(
  branchIndex: number,
  finalAnswer: string,
  overrides: Partial<RolloutBranchResult> = {}
): RolloutBranchResult {
  return {
    rolloutId: "rollout-1",
    task: "the task",
    branchIndex,
    temperature: 0.7,
    seed: null,
    sessionId: `session-${branchIndex}`,
    trajectory: [],
    toolCallSequence: [],
    finalAnswer,
    buildResult: null,
    ...overrides,
  };
}

function makeRanked(
  branchIndex: number,
  rank: number,
  objectiveScore: 0 | 1,
  totalScore: number
): RankedBranch {
  return { branchIndex, rank, objectiveScore, judgeScore: 5, totalScore };
}

const TS = 1_700_000_000_000;

// ── toDpoRecord ───────────────────────────────────────────────────────────────

describe("toDpoRecord", () => {
  test("chosen has higher rank than rejected; returns correct provenance fields", () => {
    const branches = [makeBranch(0, "answer A"), makeBranch(1, "answer B")];
    const ranked = [makeRanked(0, 1, 1, 1.15), makeRanked(1, 2, 0, 0.15)];
    const record = toDpoRecord(branches, ranked, TS);
    expect(record).not.toBeNull();
    expect(record!.chosen).toBe("answer A");
    expect(record!.rejected).toBe("answer B");
    expect(record!.provenance.source).toBe("wasmagent-rollout");
    expect(record!.provenance.rollout_id).toBe("rollout-1");
    expect(record!.provenance.chosen_branch).toBe(0);
    expect(record!.provenance.rejected_branch).toBe(1);
    expect(record!.provenance.objective_score.chosen).toBe(1);
    expect(record!.provenance.objective_score.rejected).toBe(0);
    expect(record!.provenance.exported_at_ms).toBe(TS);
    expect(record!.provenance.n_gram_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("returns null when chosen.finalAnswer === rejected.finalAnswer", () => {
    const branches = [makeBranch(0, "same answer"), makeBranch(1, "same answer")];
    const ranked = [makeRanked(0, 1, 1, 1.15), makeRanked(1, 2, 0, 0.15)];
    const record = toDpoRecord(branches, ranked, TS);
    expect(record).toBeNull();
  });

  test("returns null when fewer than 2 branches in ranked", () => {
    const branches = [makeBranch(0, "only answer")];
    const ranked = [makeRanked(0, 1, 1, 1.15)];
    const record = toDpoRecord(branches, ranked, TS);
    expect(record).toBeNull();
  });

  test("prompt comes from chosen branch task", () => {
    const branches = [makeBranch(0, "answer A"), makeBranch(1, "answer B")];
    const ranked = [makeRanked(0, 1, 1, 1.15), makeRanked(1, 2, 0, 0.15)];
    const record = toDpoRecord(branches, ranked, TS);
    expect(record!.prompt).toBe("the task");
  });

  test("tool_call_sequence comes from chosen branch", () => {
    const fakeEvent: AgentEvent = {
      event: "tool_call",
      channel: "tool",
      traceId: "t1",
      parentTraceId: null,
      timestampMs: 0,
      data: {
        toolName: "myTool",
        args: {},
        callId: "c1",
        batchId: "b1",
        batchSize: 1,
        stepIndex: 0,
      },
    };
    const branches = [
      makeBranch(0, "answer A", { toolCallSequence: [fakeEvent] }),
      makeBranch(1, "answer B"),
    ];
    const ranked = [makeRanked(0, 1, 1, 1.15), makeRanked(1, 2, 0, 0.15)];
    const record = toDpoRecord(branches, ranked, TS);
    expect(record!.tool_call_sequence).toHaveLength(1);
    expect(record!.tool_call_sequence[0]).toBe(fakeEvent);
  });

  test("returns null when ranked has 0 entries", () => {
    const branches = [makeBranch(0, "answer")];
    const record = toDpoRecord(branches, [], TS);
    expect(record).toBeNull();
  });
});

// ── toPpoRecords ──────────────────────────────────────────────────────────────

describe("toPpoRecords", () => {
  test("returns one record per branch", () => {
    const branches = [makeBranch(0, "A"), makeBranch(1, "B"), makeBranch(2, "C")];
    const ranked = [makeRanked(0, 1, 1, 1.15), makeRanked(1, 3, 0, 0.15), makeRanked(2, 2, 1, 1.0)];
    const records = toPpoRecords(branches, ranked, TS);
    expect(records).toHaveLength(3);
  });

  test("reward matches totalScore from ranked result", () => {
    const branches = [makeBranch(0, "A"), makeBranch(1, "B")];
    const ranked = [makeRanked(0, 1, 1, 1.15), makeRanked(1, 2, 0, 0.42)];
    const records = toPpoRecords(branches, ranked, TS);
    const r0 = records.find((r) => r.provenance.branch_index === 0)!;
    const r1 = records.find((r) => r.provenance.branch_index === 1)!;
    expect(r0.reward).toBeCloseTo(1.15);
    expect(r1.reward).toBeCloseTo(0.42);
  });

  test("records contain correct prompt, completion and provenance", () => {
    const branches = [makeBranch(0, "answer zero")];
    const ranked = [makeRanked(0, 1, 1, 0.9)];
    const [rec] = toPpoRecords(branches, ranked, TS);
    expect(rec!.prompt).toBe("the task");
    expect(rec!.completion).toBe("answer zero");
    expect(rec!.provenance.source).toBe("wasmagent-rollout");
    expect(rec!.provenance.rollout_id).toBe("rollout-1");
    expect(rec!.provenance.branch_index).toBe(0);
    expect(rec!.provenance.objective_score).toBe(1);
    expect(rec!.provenance.exported_at_ms).toBe(TS);
    expect(rec!.provenance.n_gram_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test("returns empty array when no branches match ranked", () => {
    const branches = [makeBranch(0, "A")];
    const records = toPpoRecords(branches, [], TS);
    expect(records).toHaveLength(0);
  });
});

// ── toJsonl ───────────────────────────────────────────────────────────────────

describe("toJsonl", () => {
  test("each line is valid JSON", () => {
    const records = [{ a: 1 }, { b: 2 }, { c: 3 }];
    const jsonl = toJsonl(records);
    const lines = jsonl.split("\n");
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("correct number of lines", () => {
    const records = [{ a: 1 }, { b: 2 }];
    const jsonl = toJsonl(records);
    expect(jsonl.split("\n")).toHaveLength(2);
  });

  test("empty array produces empty string", () => {
    expect(toJsonl([])).toBe("");
  });

  test("single record produces one line without trailing newline", () => {
    const jsonl = toJsonl([{ x: 42 }]);
    expect(jsonl).toBe('{"x":42}');
    expect(jsonl.includes("\n")).toBe(false);
  });

  test("content round-trips correctly", () => {
    const records = [
      { id: "a", val: 1 },
      { id: "b", val: 2 },
    ];
    const jsonl = toJsonl(records);
    const parsed = jsonl.split("\n").map((l) => JSON.parse(l));
    expect(parsed[0]).toEqual({ id: "a", val: 1 });
    expect(parsed[1]).toEqual({ id: "b", val: 2 });
  });
});
