import type { RolloutBranchResult } from "../enhancement/RolloutForkRunner.js";
import type { RankedBranch } from "./RolloutRanker.js";
import type { ForkContext } from "./RolloutTreeExporter.js";
import { buildTreeRecord, toDpoRecordWithForkContext } from "./RolloutTreeExporter.js";

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

// ── buildTreeRecord ──────────────────────────────────────────────────────────

describe("buildTreeRecord", () => {
  test("returns null for empty branches", () => {
    const forkContexts = new Map<number, ForkContext>();
    const result = buildTreeRecord([], [], forkContexts);
    expect(result).toBeNull();
  });

  test("correctly builds fork_map from contexts", () => {
    const branches = [makeBranch(0, "A"), makeBranch(1, "B"), makeBranch(2, "C")];
    const ranked = [makeRanked(0, 1, 1, 1.0), makeRanked(1, 2, 0, 0.5), makeRanked(2, 3, 0, 0.3)];
    const forkContexts = new Map<number, ForkContext>([
      [0, { forkedAtStep: 3, forkedAtEventId: "evt-3" }],
      [1, { forkedAtStep: 3, forkedAtEventId: "evt-3" }],
      [2, { forkedAtStep: 5, forkedAtEventId: "evt-5" }],
    ]);

    const record = buildTreeRecord(branches, ranked, forkContexts);
    expect(record).not.toBeNull();
    expect(record!.fork_map).toEqual({
      3: [0, 1],
      5: [2],
    });
  });

  test("maps branch scores from ranked", () => {
    const branches = [makeBranch(0, "A"), makeBranch(1, "B")];
    const ranked = [makeRanked(0, 1, 1, 1.15), makeRanked(1, 2, 0, 0.42)];
    const forkContexts = new Map<number, ForkContext>([
      [0, { forkedAtStep: 2, forkedAtEventId: "evt-2" }],
      [1, { forkedAtStep: 2, forkedAtEventId: "evt-2" }],
    ]);

    const record = buildTreeRecord(branches, ranked, forkContexts);
    expect(record).not.toBeNull();
    expect(record!.branches[0]!.objective_score).toBe(1);
    expect(record!.branches[0]!.total_score).toBeCloseTo(1.15);
    expect(record!.branches[1]!.objective_score).toBe(0);
    expect(record!.branches[1]!.total_score).toBeCloseTo(0.42);
  });

  test("uses rollout_id and task from first branch", () => {
    const branches = [makeBranch(0, "A", { rolloutId: "r-99", task: "my task" })];
    const ranked = [makeRanked(0, 1, 1, 1.0)];
    const forkContexts = new Map<number, ForkContext>([
      [0, { forkedAtStep: 0, forkedAtEventId: "evt-0" }],
    ]);

    const record = buildTreeRecord(branches, ranked, forkContexts);
    expect(record!.rollout_id).toBe("r-99");
    expect(record!.task).toBe("my task");
  });

  test("defaults fork context to step 0 when missing", () => {
    const branches = [makeBranch(0, "A")];
    const ranked = [makeRanked(0, 1, 1, 1.0)];
    const forkContexts = new Map<number, ForkContext>();

    const record = buildTreeRecord(branches, ranked, forkContexts);
    expect(record!.branches[0]!.forked_at_step).toBe(0);
    expect(record!.branches[0]!.forked_at_event_id).toBe("");
    expect(record!.branches[0]!.shared_prefix_steps).toBe(0);
  });
});

// ── toDpoRecordWithForkContext ───────────────────────────────────────────────

describe("toDpoRecordWithForkContext", () => {
  test("produces DPO pairs per fork point", () => {
    const branches = [
      makeBranch(0, "answer A"),
      makeBranch(1, "answer B"),
      makeBranch(2, "answer C"),
      makeBranch(3, "answer D"),
    ];
    const ranked = [
      makeRanked(0, 1, 1, 1.15),
      makeRanked(1, 2, 0, 0.15),
      makeRanked(2, 1, 1, 1.0),
      makeRanked(3, 2, 0, 0.3),
    ];
    const forkContexts = new Map<number, ForkContext>([
      [0, { forkedAtStep: 3, forkedAtEventId: "evt-3" }],
      [1, { forkedAtStep: 3, forkedAtEventId: "evt-3" }],
      [2, { forkedAtStep: 7, forkedAtEventId: "evt-7" }],
      [3, { forkedAtStep: 7, forkedAtEventId: "evt-7" }],
    ]);

    const records = toDpoRecordWithForkContext(branches, ranked, forkContexts, TS);
    expect(records).toHaveLength(2);
    // First pair from step 3: branch 0 chosen, branch 1 rejected
    expect(records[0]!.chosen).toBe("answer A");
    expect(records[0]!.rejected).toBe("answer B");
    // Second pair from step 7: branch 2 chosen, branch 3 rejected
    expect(records[1]!.chosen).toBe("answer C");
    expect(records[1]!.rejected).toBe("answer D");
  });

  test("returns empty array when all branches share same fork and only one branch per fork", () => {
    const branches = [makeBranch(0, "A"), makeBranch(1, "B")];
    const ranked = [makeRanked(0, 1, 1, 1.0), makeRanked(1, 2, 0, 0.5)];
    // Each branch at a different fork point — no pair possible
    const forkContexts = new Map<number, ForkContext>([
      [0, { forkedAtStep: 2, forkedAtEventId: "evt-2" }],
      [1, { forkedAtStep: 5, forkedAtEventId: "evt-5" }],
    ]);

    const records = toDpoRecordWithForkContext(branches, ranked, forkContexts, TS);
    expect(records).toHaveLength(0);
  });

  test("skips fork points with identical final answers", () => {
    const branches = [makeBranch(0, "same"), makeBranch(1, "same")];
    const ranked = [makeRanked(0, 1, 1, 1.0), makeRanked(1, 2, 0, 0.5)];
    const forkContexts = new Map<number, ForkContext>([
      [0, { forkedAtStep: 3, forkedAtEventId: "evt-3" }],
      [1, { forkedAtStep: 3, forkedAtEventId: "evt-3" }],
    ]);

    const records = toDpoRecordWithForkContext(branches, ranked, forkContexts, TS);
    expect(records).toHaveLength(0);
  });

  test("returns empty array with empty forkContexts", () => {
    const branches = [makeBranch(0, "A"), makeBranch(1, "B")];
    const ranked = [makeRanked(0, 1, 1, 1.0), makeRanked(1, 2, 0, 0.5)];
    const forkContexts = new Map<number, ForkContext>();

    const records = toDpoRecordWithForkContext(branches, ranked, forkContexts, TS);
    expect(records).toHaveLength(0);
  });
});
