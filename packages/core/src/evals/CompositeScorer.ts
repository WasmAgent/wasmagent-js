/**
 * CompositeScorer — combine multiple scorers with weights into one.
 *
 * Computes a weighted arithmetic mean of the sub-scores. Useful for
 * defining a single "quality" metric on top of multiple dimensions
 * (e.g. 0.5 * faithfulness + 0.3 * efficiency + 0.2 * constraint).
 *
 * The composite name is "composite(<name1>+<name2>+...)" so it's
 * distinguishable in eval reports.
 */

import type { AgentTrace, EvalSample, Scorer, ScorerResult } from "./index.js";

export interface WeightedScorer {
  scorer: Scorer;
  weight: number;
}

export function compositeScorer(scorers: WeightedScorer[], name?: string): Scorer {
  if (scorers.length === 0) {
    return {
      name: "composite(empty)",
      score: () => ({ scorer: "composite(empty)", score: 0, detail: "no scorers" }),
    };
  }

  const composedName = name ?? `composite(${scorers.map((s) => s.scorer.name).join("+")})`;

  return {
    name: composedName,
    score(trace: AgentTrace, sample: EvalSample): ScorerResult {
      let totalWeight = 0;
      let weightedSum = 0;
      const subDetails: string[] = [];
      for (const { scorer, weight } of scorers) {
        if (weight <= 0) continue;
        const result = scorer.score(trace, sample);
        totalWeight += weight;
        weightedSum += weight * result.score;
        subDetails.push(`${scorer.name}=${result.score.toFixed(3)}@${weight}`);
      }
      const score = totalWeight === 0 ? 0 : weightedSum / totalWeight;
      return {
        scorer: composedName,
        score,
        detail: subDetails.join("; "),
      };
    },
  };
}
