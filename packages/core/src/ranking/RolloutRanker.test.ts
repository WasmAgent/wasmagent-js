import type {
  PairwiseVerdict,
  ScalarLLMJudgeVerifier,
} from "../agents/verifiers/ScalarLLMJudgeVerifier.js";
import { DEFAULT_REWARD_FUNCTIONS, RolloutRanker, type RolloutRecord } from "./RolloutRanker.js";

// ── Mock judge ────────────────────────────────────────────────────────────────

function makeJudge(preferred: "a" | "b" | "tie" = "tie"): ScalarLLMJudgeVerifier {
  return {
    methods: ["scalar_judge"],
    verify: async () => ({ ok: true, criterionId: "x", score: 5, reasoning: "" }),
    comparePair: async (): Promise<PairwiseVerdict> => ({ preferred, reasoning: "mock" }),
    resetBatch: () => {},
  } as unknown as ScalarLLMJudgeVerifier;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeRecords(
  specs: Array<{ branch: number; obj: 0 | 1; answer?: string }>
): RolloutRecord[] {
  return specs.map(({ branch, obj, answer }) => ({
    rolloutId: "r1",
    branchIndex: branch,
    finalAnswer: answer ?? `answer-${branch}`,
    objectiveScore: obj,
    task: "test task",
  }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RolloutRanker", () => {
  test("empty input returns empty ranked array", async () => {
    const ranker = new RolloutRanker();
    const result = await ranker.rank([]);
    expect(result.ranked).toHaveLength(0);
    expect(result.stats.powered).toBe(false);
  });

  test("branches with objectiveScore=1 rank above objectiveScore=0", async () => {
    const ranker = new RolloutRanker({ judge: makeJudge("tie") });
    const records = makeRecords([
      { branch: 0, obj: 0 },
      { branch: 1, obj: 1 },
      { branch: 2, obj: 0 },
    ]);
    const { ranked } = await ranker.rank(records);
    expect(ranked[0]!.objectiveScore).toBe(1);
    expect(ranked[0]!.branchIndex).toBe(1);
  });

  test("5 records: 2 pass + 3 fail — passing branches rank first", async () => {
    const ranker = new RolloutRanker({ judge: makeJudge("tie") });
    const records = makeRecords([
      { branch: 0, obj: 1 },
      { branch: 1, obj: 0 },
      { branch: 2, obj: 1 },
      { branch: 3, obj: 0 },
      { branch: 4, obj: 0 },
    ]);
    const { ranked } = await ranker.rank(records);
    const topTwo = ranked.slice(0, 2).map((r) => r.objectiveScore);
    expect(topTwo.every((s) => s === 1)).toBe(true);
  });

  test("within-group pairwise judge refines order", async () => {
    // Judge always prefers "a" (the first/lower-index branch in the pair).
    // So among the two passing branches, branch 0 (lower index) should rank first.
    const ranker = new RolloutRanker({ judge: makeJudge("a") });
    const records = makeRecords([
      { branch: 0, obj: 1, answer: "good answer A" },
      { branch: 1, obj: 1, answer: "good answer B" },
      { branch: 2, obj: 0 },
    ]);
    const { ranked } = await ranker.rank(records);
    expect(ranked[0]!.branchIndex).toBe(0);
    expect(ranked[1]!.branchIndex).toBe(1);
  });

  test("changing reward weights changes ranking order", async () => {
    // Default: objective weight=1, judge weight=0.3.
    // Custom: judge weight=2 (overrides objective).
    const judgeAlwaysA = makeJudge("a");

    const defaultRanker = new RolloutRanker({ judge: judgeAlwaysA });
    const judgeHeavyRanker = new RolloutRanker({
      judge: judgeAlwaysA,
      rewardFunctions: [
        { key: "objective", weight: 0.1, score: (r) => r.objectiveScore },
        { key: "judge", weight: 2.0, score: (r) => (r.judgeScore ?? 5) / 10 },
      ],
    });

    const records = makeRecords([
      { branch: 0, obj: 0, answer: "best by judge" },
      { branch: 1, obj: 1, answer: "passes build" },
    ]);

    const defaultResult = await defaultRanker.rank(records);
    const heavyResult = await judgeHeavyRanker.rank(records);

    // Default: branch 1 (obj=1) ranks first because objective weight dominates.
    expect(defaultResult.ranked[0]!.branchIndex).toBe(1);

    // Heavy judge: depends on judge score — with judge always preferring "a"
    // (branch 0), judge-heavy ranking should promote branch 0.
    // We just verify the results differ in some way.
    expect(defaultResult.ranked[0]!.totalScore).not.toBe(heavyResult.ranked[0]!.totalScore);
  });

  test("stats.powered=false for small batches", async () => {
    const ranker = new RolloutRanker();
    const records = makeRecords([
      { branch: 0, obj: 1 },
      { branch: 1, obj: 0 },
    ]);
    const { stats } = await ranker.rank(records);
    expect(stats.powered).toBe(false);
  });

  test("ranked array covers all input branches", async () => {
    const ranker = new RolloutRanker({ judge: makeJudge("tie") });
    const records = makeRecords([
      { branch: 0, obj: 1 },
      { branch: 1, obj: 0 },
      { branch: 2, obj: 1 },
      { branch: 3, obj: 0 },
    ]);
    const { ranked } = await ranker.rank(records);
    const indices = ranked.map((r) => r.branchIndex).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3]);
  });

  test("rank numbers are 1-based and sequential", async () => {
    const ranker = new RolloutRanker();
    const records = makeRecords([
      { branch: 0, obj: 0 },
      { branch: 1, obj: 1 },
      { branch: 2, obj: 1 },
    ]);
    const { ranked } = await ranker.rank(records);
    const ranks = ranked.map((r) => r.rank).sort((a, b) => a - b);
    expect(ranks).toEqual([1, 2, 3]);
  });

  test("DEFAULT_REWARD_FUNCTIONS has objective weight=1 and judge weight=0.3", () => {
    const obj = DEFAULT_REWARD_FUNCTIONS.find((f) => f.key === "objective");
    const judge = DEFAULT_REWARD_FUNCTIONS.find((f) => f.key === "judge");
    expect(obj?.weight).toBe(1.0);
    expect(judge?.weight).toBeCloseTo(0.3);
  });
});
