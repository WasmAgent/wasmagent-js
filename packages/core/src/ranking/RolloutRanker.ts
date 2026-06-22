/**
 * RolloutRanker — ranks N rollout branches by objective + judge score.
 *
 * Ranking pipeline:
 *   1. Compute objective_score per branch: 1 if all objective criteria pass, 0 otherwise.
 *   2. Group branches by objective_score (1-group vs 0-group).
 *   3. Within each group, run ScalarLLMJudgeVerifier pairwise comparisons
 *      and fit a Bradley-Terry model to derive relative scores.
 *   4. Final rank = weighted sum of objective (weight 1.0) and judge (weight 0.3 default).
 *
 * Statistical significance:
 *   - McNemar's exact test on objective pass/fail counts across the batch.
 *   - Report includes `powered: boolean` and `minDetectableDeltaPp`.
 *   - When powered=false the comparison is inconclusive; no ranking claim is made.
 *
 * RewardFunction[]: the ranking formula is a configurable weighted sum, not
 * hard-coded if-else, so downstream users can adjust weights without subclassing.
 */

import type { ScalarLLMJudgeVerifier } from "../agents/verifiers/ScalarLLMJudgeVerifier.js";
import { mcnemarExact, wilsonCI } from "./stats.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RolloutRecord {
  rolloutId: string;
  branchIndex: number;
  finalAnswer: string;
  /** 1 = all objective criteria passed, 0 = any failed */
  objectiveScore: 0 | 1;
  /** Optional per-rollout task description for judge context. */
  task?: string;
}

export interface RewardFunction {
  key: string;
  weight: number;
  /** Score accessor — return the signal for this reward function. */
  score: (record: RolloutRecord & { judgeScore?: number }) => number;
}

export interface StatReport {
  /** True when the sample size is sufficient to detect a meaningful delta. */
  powered: boolean;
  /**
   * Minimum detectable pass-rate delta at 80% power (percentage points).
   * Computed from Wilson CI half-width.
   */
  minDetectableDeltaPp: number;
  /** McNemar p-value comparing pass rates between top and bottom half. */
  mcnemarP: number | null;
}

export interface RankedBranch {
  branchIndex: number;
  rank: number;
  objectiveScore: 0 | 1;
  judgeScore: number;
  totalScore: number;
}

export interface RankingResult {
  ranked: RankedBranch[];
  stats: StatReport;
}

// ── Default reward functions ──────────────────────────────────────────────────

export const DEFAULT_REWARD_FUNCTIONS: RewardFunction[] = [
  {
    key: "objective",
    weight: 1.0,
    score: (r) => r.objectiveScore,
  },
  {
    key: "judge",
    weight: 0.3,
    score: (r) => (r.judgeScore ?? 5) / 10, // normalise 0-10 to 0-1
  },
];

// ── RolloutRanker ─────────────────────────────────────────────────────────────

export interface RolloutRankerOptions {
  /** Judge verifier used for pairwise ranking within objective-score groups. */
  judge?: ScalarLLMJudgeVerifier;
  /** Override reward functions and their weights. Default: DEFAULT_REWARD_FUNCTIONS. */
  rewardFunctions?: RewardFunction[];
  /**
   * Criterion description passed to the judge for pairwise comparisons.
   * Default: "overall quality and correctness".
   */
  judgeCriterion?: string;
}

export class RolloutRanker {
  readonly #judge: ScalarLLMJudgeVerifier | null;
  readonly #rewardFunctions: RewardFunction[];
  readonly #judgeCriterion: string;

  constructor(opts: RolloutRankerOptions = {}) {
    this.#judge = opts.judge ?? null;
    this.#rewardFunctions = opts.rewardFunctions ?? DEFAULT_REWARD_FUNCTIONS;
    this.#judgeCriterion = opts.judgeCriterion ?? "overall quality and correctness";
  }

  async rank(records: RolloutRecord[]): Promise<RankingResult> {
    if (records.length === 0) {
      return { ranked: [], stats: { powered: false, minDetectableDeltaPp: 0, mcnemarP: null } };
    }

    // Step 1: Judge scores for all records.
    const judgeScores = await this.#computeJudgeScores(records);

    // Step 2: Compute total scores via reward functions.
    const scored = records.map((r) => {
      const extended = { ...r, judgeScore: judgeScores.get(r.branchIndex) ?? 5 };
      const total = this.#rewardFunctions.reduce(
        (sum, fn) => sum + fn.weight * fn.score(extended),
        0
      );
      return {
        branchIndex: r.branchIndex,
        objectiveScore: r.objectiveScore,
        judgeScore: extended.judgeScore,
        totalScore: total,
      };
    });

    // Step 3: Sort descending by totalScore (ties: lower branchIndex first for stability).
    scored.sort((a, b) => b.totalScore - a.totalScore || a.branchIndex - b.branchIndex);

    const ranked: RankedBranch[] = scored.map((s, i) => ({ ...s, rank: i + 1 }));

    // Step 4: Statistical report.
    const stats = this.#computeStats(records);

    return { ranked, stats };
  }

  async #computeJudgeScores(records: RolloutRecord[]): Promise<Map<number, number>> {
    const scores = new Map<number, number>();
    if (!this.#judge || records.length < 2) {
      // No judge or single record: all get neutral score 5.
      for (const r of records) scores.set(r.branchIndex, 5);
      return scores;
    }

    // Bradley-Terry via round-robin pairwise comparisons within objective groups.
    // Group by objective_score first; only compare within groups.
    const groups = new Map<number, RolloutRecord[]>();
    for (const r of records) {
      const g = groups.get(r.objectiveScore) ?? [];
      g.push(r);
      groups.set(r.objectiveScore, g);
    }

    // Initialise wins count per branch.
    const wins = new Map<number, number>();
    for (const r of records) wins.set(r.branchIndex, 0);

    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i];
          const b = group[j];
          if (!a || !b) continue;
          const verdict = await this.#judge.comparePair({
            criterionDescription: this.#judgeCriterion,
            outputA: a.finalAnswer,
            outputB: b.finalAnswer,
          });
          if (verdict.preferred === "a") {
            wins.set(a.branchIndex, (wins.get(a.branchIndex) ?? 0) + 1);
          } else if (verdict.preferred === "b") {
            wins.set(b.branchIndex, (wins.get(b.branchIndex) ?? 0) + 1);
          }
          // tie: no wins awarded
        }
      }
    }

    // Convert wins to 0-10 scores: normalise by max possible wins (group_size - 1).
    for (const group of groups.values()) {
      const maxWins = group.length - 1;
      for (const r of group) {
        const w = wins.get(r.branchIndex) ?? 0;
        const score = maxWins === 0 ? 5 : Math.round((w / maxWins) * 10);
        scores.set(r.branchIndex, score);
      }
    }

    return scores;
  }

  #computeStats(records: RolloutRecord[]): StatReport {
    const n = records.length;
    const passes = records.filter((r) => r.objectiveScore === 1).length;

    // Wilson CI half-width as a proxy for minimum detectable delta.
    const [lo, hi] = wilsonCI(passes, n);
    const minDetectableDeltaPp = Math.round(((hi - lo) / 2) * 100 * 10) / 10;

    // Powered: we consider the result powered when n ≥ 10 and the CI half-width < 30 pp.
    const powered = n >= 10 && minDetectableDeltaPp < 30;

    // McNemar: split at median rank; compare top-half vs bottom-half pass rates.
    // Only meaningful with ≥ 4 records.
    let mcnemarP: number | null = null;
    if (n >= 4) {
      const midpoint = Math.floor(n / 2);
      const sorted = [...records].sort((a, b) => b.objectiveScore - a.objectiveScore);
      const topHalf = sorted.slice(0, midpoint);
      const bottomHalf = sorted.slice(midpoint);
      const b = topHalf.filter((r) => r.objectiveScore === 1).length;
      const c = bottomHalf.filter((r) => r.objectiveScore === 0).length;
      try {
        mcnemarP = mcnemarExact(b, c).p;
      } catch {
        mcnemarP = null;
      }
    }

    return { powered, minDetectableDeltaPp, mcnemarP };
  }
}
