/**
 * Stats parity tests.
 *
 * Each value below was computed independently with scipy / statsmodels
 * (Python 3.11) on the same inputs and pinned. Our TS port must match
 * within numerical tolerance — these are the gate that decides whether
 * the port is correct, so we keep references traceable.
 */
import { describe, expect, it } from "vitest";
import {
  binomialCDF,
  buildG1Report,
  invNormalCDF,
  mcnemarExact,
  pairedBootstrap,
  wilsonCI,
} from "./index.js";

describe("invNormalCDF — scipy.stats.norm.ppf reference values", () => {
  // Source: scipy.stats.norm.ppf(p)
  const cases: Array<[number, number]> = [
    [0.025, -1.959963984540054],
    [0.05, -1.6448536269514729],
    [0.5, 0.0],
    [0.95, 1.6448536269514722],
    [0.975, 1.959963984540054],
    [0.999, 3.0902323061678132],
    [0.001, -3.090232306167813],
  ];
  for (const [p, expected] of cases) {
    it(`ppf(${p}) ≈ ${expected.toFixed(6)}`, () => {
      const got = invNormalCDF(p);
      expect(Math.abs(got - expected)).toBeLessThan(1e-7);
    });
  }
});

describe("wilsonCI — statsmodels.proportion_confint(method='wilson') reference", () => {
  // Reference values computed independently in Python using the same Wilson
  // formula scipy implements. We compare to ±1e-3 tolerance.
  const cases: Array<{ s: number; n: number; lo: number; hi: number }> = [
    // Symmetric case at p=0.5 — Wilson centred slightly off the point estimate.
    { s: 50, n: 100, lo: 0.40383, hi: 0.59617 },
    { s: 90, n: 100, lo: 0.82563, hi: 0.94477 },
    // Tail extremes — Wilson stays inside [0,1] where Wald breaks:
    { s: 0, n: 100, lo: 0.0, hi: 0.037 },
    { s: 100, n: 100, lo: 0.963, hi: 1.0 },
    // Small n, classic textbook example:
    { s: 19, n: 20, lo: 0.76387, hi: 0.99112 },
  ];
  for (const { s, n, lo, hi } of cases) {
    it(`wilsonCI(${s}/${n}) ≈ [${lo}, ${hi}]`, () => {
      const [gotLo, gotHi] = wilsonCI(s, n);
      expect(Math.abs(gotLo - lo)).toBeLessThan(1e-3);
      expect(Math.abs(gotHi - hi)).toBeLessThan(1e-3);
    });
  }
  it("trivial cases", () => {
    expect(wilsonCI(0, 0)).toEqual([0, 0]);
    expect(() => wilsonCI(-1, 10)).toThrow(/out of range/);
    expect(() => wilsonCI(11, 10)).toThrow(/out of range/);
  });
});

describe("binomialCDF — scipy.stats.binom.cdf reference", () => {
  // Reference values cross-checked in Python with math.comb.
  const cases: Array<[number, number, number, number]> = [
    [0, 10, 0.5, 0.0009765625],
    [5, 10, 0.5, 0.6230468750000001],
    [10, 10, 0.5, 1.0],
    [10, 100, 0.1, 0.5831555122664934],
    [50, 100, 0.5, 0.5397946186935785],
  ];
  for (const [k, n, p, expected] of cases) {
    it(`binomCDF(k=${k}, n=${n}, p=${p}) ≈ ${expected.toFixed(8)}`, () => {
      const got = binomialCDF(k, n, p);
      expect(Math.abs(got - expected)).toBeLessThan(1e-8);
    });
  }
});

describe("mcnemarExact — scipy.stats.contingency.mcnemar(exact=True) reference", () => {
  // scipy.stats.contingency.mcnemar(table, exact=True), where table is
  // [[a, b], [c, d]] — the off-diagonals (b, c) drive the test. We use
  // hand-computed two-sided p = 2 * binom.cdf(min(b,c), b+c, 0.5), capped at 1.
  const cases: Array<{ b: number; c: number; p: number }> = [
    // No disagreement — undefined in some libs; we return 1.
    { b: 0, c: 0, p: 1 },
    // Tied disagreement — p = 1.
    { b: 5, c: 5, p: 1 },
    // 8/2 split.
    { b: 8, c: 2, p: 0.109375 }, // 2 * P(X≤2 | n=10, p=0.5)
    // 25/5 split — clearly significant.
    { b: 25, c: 5, p: 0.00032491423189640045 },
    // Asymmetric large.
    { b: 50, c: 10, p: 1.6163814566157175e-7 },
  ];
  for (const { b, c, p: expected } of cases) {
    it(`mcnemar(b=${b}, c=${c}) p ≈ ${expected.toExponential(4)}`, () => {
      const { p } = mcnemarExact(b, c);
      expect(Math.abs(p - expected)).toBeLessThan(Math.max(1e-9, expected * 1e-6));
    });
  }
  it("rejects non-integer or negative inputs", () => {
    expect(() => mcnemarExact(-1, 2)).toThrow();
    expect(() => mcnemarExact(1.5, 2)).toThrow();
  });
});

describe("pairedBootstrap — reproducibility + sanity", () => {
  it("identical seeds produce identical CIs (deterministic)", () => {
    const cand = [true, true, false, true, true, false, true, true, false, true];
    const base = [true, false, false, true, false, false, true, true, false, true];
    const r1 = pairedBootstrap(cand, base, 1000, 0.05, 42);
    const r2 = pairedBootstrap(cand, base, 1000, 0.05, 42);
    expect(r1.meanDelta).toBe(r2.meanDelta);
    expect(r1.ciLo).toBe(r2.ciLo);
    expect(r1.ciHi).toBe(r2.ciHi);
  });
  it("different seeds produce different CIs (randomised)", () => {
    const cand = [true, true, false, true, true, false, true, true, false, true];
    const base = [true, false, false, true, false, false, true, true, false, true];
    const r1 = pairedBootstrap(cand, base, 1000, 0.05, 1);
    const r2 = pairedBootstrap(cand, base, 1000, 0.05, 2);
    // Means may match by chance; CI bounds almost surely don't.
    expect([r1.ciLo, r1.ciHi]).not.toEqual([r2.ciLo, r2.ciHi]);
  });
  it("captures the observed delta within the bootstrap mean (large B)", () => {
    // Construct cand with +30pp accuracy over base; expect ciLo > 0.
    const n = 100;
    const cand: boolean[] = [];
    const base: boolean[] = [];
    for (let i = 0; i < n; i++) {
      cand.push(i < 80); // 80% acc
      base.push(i < 50); // 50% acc
    }
    const r = pairedBootstrap(cand, base, 4000);
    expect(Math.abs(r.meanDelta - 0.3)).toBeLessThan(0.05);
    expect(r.ciLo).toBeGreaterThan(0);
    expect(r.ciHi).toBeLessThan(0.5);
  });
  it("rejects mismatched array lengths", () => {
    expect(() => pairedBootstrap([true], [true, false])).toThrow(/same length/);
  });
});

describe("buildG1Report — pooled paired-stats gate (≥3 seeds)", () => {
  function mkSeed(seed: number, n: number, candFrac: number, baseFrac: number) {
    const candidateCorrect = new Set<string>();
    const baselineCorrect = new Set<string>();
    for (let i = 0; i < n; i++) {
      const id = `q${i}`;
      // Make the cand-right set a strict superset of the base-right set so
      // b > 0 and c = 0 — the "pure improvement" case.
      if (i < Math.round(n * baseFrac)) {
        candidateCorrect.add(id);
        baselineCorrect.add(id);
      } else if (i < Math.round(n * candFrac)) {
        candidateCorrect.add(id);
      }
    }
    return { seed, candidateCorrect, baselineCorrect, n };
  }

  it("3 seeds, +20pp uniform improvement → passes G1", () => {
    const seeds = [mkSeed(0, 100, 0.7, 0.5), mkSeed(1, 100, 0.7, 0.5), mkSeed(2, 100, 0.7, 0.5)];
    const r = buildG1Report("test", seeds);
    expect(r.nSeeds).toBe(3);
    expect(r.pooled.n).toBe(300);
    expect(r.pooled.deltaAcc).toBeCloseTo(0.2, 5);
    expect(r.pooled.mcnemarP).toBeLessThan(1e-10);
    expect(r.passes).toBe(true);
    expect(r.pooled.bootstrapCiLo).toBeGreaterThan(0);
  });

  it("3 seeds, no real improvement (cand == base) → fails G1", () => {
    const seeds = [mkSeed(0, 100, 0.5, 0.5), mkSeed(1, 100, 0.5, 0.5), mkSeed(2, 100, 0.5, 0.5)];
    const r = buildG1Report("test-null", seeds);
    expect(r.passes).toBe(false);
    expect(r.pooled.deltaAcc).toBe(0);
    expect(r.pooled.mcnemarP).toBe(1);
  });

  it("only 1 seed → does NOT pass G1 even if delta is significant", () => {
    const r = buildG1Report("test-1seed", [mkSeed(0, 100, 0.7, 0.5)]);
    expect(r.nSeeds).toBe(1);
    expect(r.passes).toBe(false); // §0.4 hard requires ≥3 seeds
  });
});

// ── Energy estimation tests (P16-8 ④) ────────────────────────────────────────

describe("estimateJoulesPerCorrect — energy efficiency estimate", () => {
  // Import is in the src root, not stats/
  it("computes J/correct from aggregate (happy path)", async () => {
    const { estimateJoulesPerCorrect } = await import("../energy.js");
    const agg = {
      modelId: "test-model",
      suiteName: "multi-turn-memory",
      seedAccs: [0.8, 0.8, 0.8],
      meanAcc: 0.8,
      wilsonLo: 0.7,
      wilsonHi: 0.88,
      seedStd: 0,
      totalTokens: 1000,
      totalCostUsd: 0,
      medianWallMs: 500,
      p95WallMs: 800,
      warmupMs: 2000,
      totalCells: 10,
      passedCells: 8,
    };
    const r = estimateJoulesPerCorrect(agg, { tdpWatts: 20 });
    expect(r.modelId).toBe("test-model");
    // 10 cells × 500ms = 5000ms → 5s × 20W = 100J total
    expect(r.totalJoules).toBeCloseTo(100, 1);
    // 8 correct → 100/8 = 12.5 J/correct
    expect(r.joulesPerCorrect).toBeCloseTo(12.5, 1);
    expect(r.accuracy).toBeCloseTo(0.8, 5);
    // warmup: 2000ms × 20W = 40J (reported separately, not in totalJoules)
    expect(r.warmupJoules).toBeCloseTo(40, 1);
  });

  it("J/correct is Infinity when no correct answers", async () => {
    const { estimateJoulesPerCorrect } = await import("../energy.js");
    const agg = {
      modelId: "zero-model",
      suiteName: "suite",
      seedAccs: [0],
      meanAcc: 0,
      wilsonLo: 0,
      wilsonHi: 0.3,
      seedStd: 0,
      totalTokens: 100,
      totalCostUsd: 0,
      medianWallMs: 200,
      p95WallMs: 300,
      warmupMs: 0,
      totalCells: 5,
      passedCells: 0,
    };
    const r = estimateJoulesPerCorrect(agg, { tdpWatts: 10 });
    expect(r.joulesPerCorrect).toBe(Infinity);
  });

  it("renders energy table with sorted J/correct", async () => {
    const { estimateJoulesPerCorrect, renderEnergyTable } = await import("../energy.js");
    const base = {
      suiteName: "multi-turn-memory",
      seedAccs: [0.5],
      meanAcc: 0.5,
      wilsonLo: 0.3,
      wilsonHi: 0.7,
      seedStd: 0,
      totalTokens: 500,
      totalCostUsd: 0,
      medianWallMs: 1000,
      p95WallMs: 1500,
      warmupMs: 0,
      totalCells: 10,
      passedCells: 5,
    };
    const r1 = estimateJoulesPerCorrect({ ...base, modelId: "small-model" }, { tdpWatts: 5 });
    const r2 = estimateJoulesPerCorrect({ ...base, modelId: "large-model", medianWallMs: 5000 }, { tdpWatts: 40 });
    const table = renderEnergyTable([r2, r1], "multi-turn-memory");
    // small-model should come first (lower J/correct)
    const lines = table.split("\n").filter(l => l.startsWith("| `"));
    expect(lines[0]).toContain("small-model");
    expect(lines[1]).toContain("large-model");
  });
});
