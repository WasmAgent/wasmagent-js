/**
 * Tests for IPT (Isomorphic Perturbation Test).
 *
 * Cover the four scenarios that map to the paper's findings:
 *   - clean: model invariant across perturbations → low shortcutRate
 *   - shortcut: model passes original, fails all perturbations → high
 *   - degenerate (all-fail): model can't solve any form → 0 (no signal)
 *   - mixed: partial perturbation failures → intermediate signal
 *
 * Plus error-path tests (empty cohort, empty perturbations).
 */

import { describe, expect, it } from "vitest";
import { iptClassify, iptShortcutRate, type IptCohort } from "./ipt.js";

describe("iptShortcutRate — clean cohort (model invariant)", () => {
  it("all original pass + all perturbations pass = 0 shortcut", () => {
    const cohort: IptCohort = [
      { id: "a", original: true, perturbed: [true, true] },
      { id: "b", original: true, perturbed: [true] },
      { id: "c", original: true, perturbed: [true, true, true] },
    ];
    const v = iptShortcutRate(cohort);
    expect(v.cohortSize).toBe(3);
    expect(v.passRateOriginal).toBe(1.0);
    expect(v.passRatePerturbed).toBe(1.0);
    expect(v.shortcutRate).toBe(0);
    expect(iptClassify(v)).toBe("clean");
  });

  it("partially-failing model that fails consistently across forms = no shortcut signal", () => {
    // Model fails everything in pair "b" — original AND perturbed.
    // Not a shortcut: it's just not solving "b".
    const cohort: IptCohort = [
      { id: "a", original: true, perturbed: [true] },
      { id: "b", original: false, perturbed: [false, false] },
      { id: "c", original: true, perturbed: [true] },
    ];
    const v = iptShortcutRate(cohort);
    expect(v.shortcutRate).toBe(0);
    expect(iptClassify(v)).toBe("clean");
  });
});

describe("iptShortcutRate — shortcut cohort (RLVR-style cheating)", () => {
  it("all original pass + all perturbations fail = max shortcut signal", () => {
    const cohort: IptCohort = [
      { id: "a", original: true, perturbed: [false] },
      { id: "b", original: true, perturbed: [false, false] },
      { id: "c", original: true, perturbed: [false] },
    ];
    const v = iptShortcutRate(cohort);
    expect(v.passRateOriginal).toBe(1.0);
    expect(v.passRatePerturbed).toBe(0);
    expect(v.shortcutRate).toBe(1.0);
    expect(iptClassify(v)).toBe("likely-shortcut");
  });

  it("classifier crosses 0.25 threshold around RLVR paper's regime", () => {
    // 1/4 perfectly-shortcut pairs, 3/4 invariant. Rate = 0.25.
    const cohort: IptCohort = [
      { id: "shortcut-1", original: true, perturbed: [false] },
      { id: "invariant-1", original: true, perturbed: [true] },
      { id: "invariant-2", original: true, perturbed: [true] },
      { id: "invariant-3", original: true, perturbed: [true] },
    ];
    const v = iptShortcutRate(cohort);
    expect(v.shortcutRate).toBe(0.25);
    expect(iptClassify(v)).toBe("likely-shortcut"); // ≥ 0.25 boundary
  });
});

describe("iptShortcutRate — partial perturbations (mixed signal)", () => {
  it("model passes original + 1 of 2 perturbations = 0.5 signal for that pair", () => {
    const cohort: IptCohort = [
      { id: "mixed-1", original: true, perturbed: [true, false] },
    ];
    const v = iptShortcutRate(cohort);
    expect(v.perPair[0]?.perturbedPassRate).toBe(0.5);
    expect(v.perPair[0]?.shortcutSignal).toBe(0.5);
    expect(v.shortcutRate).toBe(0.5);
  });

  it("3 perturbations, 1 fails = ~0.33 signal", () => {
    const cohort: IptCohort = [
      { id: "mixed-2", original: true, perturbed: [true, true, false] },
    ];
    const v = iptShortcutRate(cohort);
    expect(v.perPair[0]?.perturbedPassRate).toBeCloseTo(0.667, 2);
    expect(v.perPair[0]?.shortcutSignal).toBeCloseTo(0.333, 2);
  });
});

describe("iptShortcutRate — original-fail edge cases", () => {
  it("model fails original, passes perturbations = 0 signal (rectified)", () => {
    // The shortcut hypothesis is "memorise the canonical form".
    // If the model fails the canonical form but passes perturbations,
    // it's certainly NOT exhibiting that shortcut. Rectified to 0.
    const cohort: IptCohort = [
      { id: "weird-1", original: false, perturbed: [true, true] },
    ];
    const v = iptShortcutRate(cohort);
    expect(v.perPair[0]?.shortcutSignal).toBe(0);
    expect(v.shortcutRate).toBe(0);
  });

  it("everything fails = 0 signal (degenerate, no diagnostic value)", () => {
    const cohort: IptCohort = [
      { id: "broken-1", original: false, perturbed: [false] },
      { id: "broken-2", original: false, perturbed: [false, false] },
    ];
    const v = iptShortcutRate(cohort);
    expect(v.passRateOriginal).toBe(0);
    expect(v.passRatePerturbed).toBe(0);
    expect(v.shortcutRate).toBe(0);
    expect(iptClassify(v)).toBe("clean"); // technically clean but useless
  });
});

describe("iptShortcutRate — aggregation invariants", () => {
  it("perturbedPassRate weights pairs equally regardless of perturbation count", () => {
    // Pair A: 1 perturbation passes (1/1 = 100%)
    // Pair B: 3 perturbations pass (3/3 = 100%)
    // Pair C: 1 of 3 perturbations passes (1/3 = 33%)
    // Cohort mean = (1.0 + 1.0 + 0.333) / 3 ≈ 0.778
    const cohort: IptCohort = [
      { id: "a", original: true, perturbed: [true] },
      { id: "b", original: true, perturbed: [true, true, true] },
      { id: "c", original: true, perturbed: [true, false, false] },
    ];
    const v = iptShortcutRate(cohort);
    expect(v.passRatePerturbed).toBeCloseTo(0.778, 2);
  });

  it("perPair length matches cohort length", () => {
    const cohort: IptCohort = [
      { id: "a", original: true, perturbed: [true] },
      { id: "b", original: false, perturbed: [false] },
    ];
    const v = iptShortcutRate(cohort);
    expect(v.perPair.length).toBe(2);
    expect(v.perPair.map((p) => p.id)).toEqual(["a", "b"]);
  });
});

describe("iptShortcutRate — error paths", () => {
  it("throws on empty cohort", () => {
    expect(() => iptShortcutRate([])).toThrow(/cohort must contain ≥1 pair/);
  });

  it("throws on a pair with empty perturbations array", () => {
    expect(() =>
      iptShortcutRate([{ id: "broken", original: true, perturbed: [] }]),
    ).toThrow(/has no perturbations/);
  });
});

describe("iptClassify — threshold boundaries", () => {
  it("just below 0.10 is clean", () => {
    const verdict = {
      cohortSize: 100,
      passRateOriginal: 1,
      passRatePerturbed: 0.91,
      shortcutRate: 0.099,
      perPair: [],
    };
    expect(iptClassify(verdict)).toBe("clean");
  });

  it("0.10 exactly is suspicious", () => {
    expect(iptClassify({ cohortSize: 1, passRateOriginal: 1, passRatePerturbed: 0.9, shortcutRate: 0.1, perPair: [] })).toBe("suspicious");
  });

  it("just below 0.25 is suspicious", () => {
    expect(iptClassify({ cohortSize: 1, passRateOriginal: 1, passRatePerturbed: 0.751, shortcutRate: 0.249, perPair: [] })).toBe("suspicious");
  });

  it("0.25 exactly is likely-shortcut", () => {
    expect(iptClassify({ cohortSize: 1, passRateOriginal: 1, passRatePerturbed: 0.75, shortcutRate: 0.25, perPair: [] })).toBe("likely-shortcut");
  });
});
