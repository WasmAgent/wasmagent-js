/**
 * G1 acceptance gate — pooled paired-test discipline for "did candidate
 * beat baseline?" claims.
 *
 * The standard discipline in serious model-evaluation work requires:
 *   1. ≥3 seeds run
 *   2. Pooled paired McNemar p < α (default 0.05)
 *   3. Wilson 95% CI on candidate accuracy reported
 *   4. Per-seed accuracy variance reported
 *
 * G1 is the one and only "did the candidate beat the baseline?" predicate
 * we trust. Single-seed greedy point estimates do not constitute evidence.
 */

import { pairedBootstrap } from "./bootstrap.js";
import { mcnemarExact } from "./mcnemar.js";
import { wilsonCI } from "./wilson.js";

export interface SeedResult {
  seed: number;
  /** Items where candidate was correct (set of item ids). */
  candidateCorrect: Set<string>;
  /** Items where baseline was correct (set of item ids). */
  baselineCorrect: Set<string>;
  /** Total items run for this seed. */
  n: number;
}

export interface G1Report {
  label: string;
  nSeeds: number;
  /** Per-seed candidate accuracy. */
  candidateAccs: number[];
  /** Per-seed baseline accuracy. */
  baselineAccs: number[];
  /** Std-dev of candidate-minus-baseline delta across seeds. */
  seedDeltaStd: number;
  /** Pooled across seeds (the statistic we trust most). */
  pooled: {
    n: number;
    b: number;
    c: number;
    mcnemarP: number;
    deltaAcc: number;
    bootstrapMeanDelta: number;
    bootstrapCiLo: number;
    bootstrapCiHi: number;
    candidateWilson: [number, number];
    baselineWilson: [number, number];
  };
  /** Did we pass the G1 gate at the supplied alpha? */
  passes: boolean;
  alpha: number;
}

/**
 * Build a G1 report from per-seed results. The pooled b/c counts come from
 * concatenating all (seed × item) pairs — each seed's items are treated as
 * fresh draws.
 */
export function buildG1Report(
  label: string,
  seedResults: SeedResult[],
  alpha = 0.05,
  bootstrapB = 2000
): G1Report {
  if (seedResults.length === 0) {
    throw new Error("buildG1Report: at least one seed required");
  }
  if (seedResults.length < 3) {
    // Don't throw — caller may explicitly want a 1- or 2-seed report for
    // exploration. We surface this in `passes` via the alpha gate, which a
    // tiny n-seed run almost always fails to meet anyway.
  }

  // Per-seed accuracies + delta variance.
  const candidateAccs = seedResults.map((s) => s.candidateCorrect.size / s.n);
  const baselineAccs = seedResults.map((s) => s.baselineCorrect.size / s.n);
  const deltas = candidateAccs.map((a, i) => a - (baselineAccs[i] as number));
  const seedDeltaStd = stddev(deltas);

  // Pooled b/c counts.
  let b = 0;
  let c = 0;
  let pooledN = 0;
  let pooledCand = 0;
  let pooledBase = 0;
  // Build pooled match arrays for the bootstrap (each item appears once
  // per seed).
  const pooledCandMatches: boolean[] = [];
  const pooledBaseMatches: boolean[] = [];
  for (const sr of seedResults) {
    pooledN += sr.n;
    pooledCand += sr.candidateCorrect.size;
    pooledBase += sr.baselineCorrect.size;
    // Iterate every item id ever seen in this seed (union of cand+base).
    const allIds = new Set<string>([...sr.candidateCorrect, ...sr.baselineCorrect]);
    // We also need items where BOTH were wrong — those don't appear in
    // either set but still count toward n. For correctness of b/c we only
    // care about items where at least one is right, but for the pooled
    // accuracy we need n items in each match array. Caller is expected to
    // pass complete seedResults (`n` is the authoritative total); we
    // synthesise wrong-wrong items by padding the match arrays with falses.
    const cand = sr.candidateCorrect;
    const base = sr.baselineCorrect;
    let bothWrong = sr.n;
    for (const id of allIds) {
      const candRight = cand.has(id);
      const baseRight = base.has(id);
      if (candRight && !baseRight) b++;
      else if (!candRight && baseRight) c++;
      pooledCandMatches.push(candRight);
      pooledBaseMatches.push(baseRight);
      bothWrong--;
    }
    // Pad remaining items where neither was right.
    for (let i = 0; i < bothWrong; i++) {
      pooledCandMatches.push(false);
      pooledBaseMatches.push(false);
    }
  }

  const { p: mcnemarP } = mcnemarExact(b, c);
  const boot = pairedBootstrap(pooledCandMatches, pooledBaseMatches, bootstrapB, alpha);
  const candidateWilson = wilsonCI(pooledCand, pooledN, alpha);
  const baselineWilson = wilsonCI(pooledBase, pooledN, alpha);

  const passes = seedResults.length >= 3 && mcnemarP < alpha;

  return {
    label,
    nSeeds: seedResults.length,
    candidateAccs,
    baselineAccs,
    seedDeltaStd,
    pooled: {
      n: pooledN,
      b,
      c,
      mcnemarP,
      deltaAcc: (pooledCand - pooledBase) / Math.max(pooledN, 1),
      bootstrapMeanDelta: boot.meanDelta,
      bootstrapCiLo: boot.ciLo,
      bootstrapCiHi: boot.ciHi,
      candidateWilson,
      baselineWilson,
    },
    passes,
    alpha,
  };
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}
