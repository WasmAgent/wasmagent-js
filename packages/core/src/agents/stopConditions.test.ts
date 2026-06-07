import { describe, it, expect } from "vitest";
import { stepCountIs, noProgress, costBudget } from "./stopConditions.js";
import type { StopConditionContext } from "./stopConditions.js";

function ctx(overrides: Partial<StopConditionContext> = {}): StopConditionContext {
  return {
    step: 1,
    totalTokens: 0,
    lastCallFingerprints: [],
    callHistory: [],
    ...overrides,
  };
}

describe("stepCountIs", () => {
  it("does not stop before threshold", () => {
    expect(stepCountIs(3)(ctx({ step: 3 }))).toBe(false);
  });

  it("stops when step exceeds threshold", () => {
    expect(stepCountIs(3)(ctx({ step: 4 }))).toBe(true);
  });
});

describe("costBudget", () => {
  it("does not stop below budget", () => {
    expect(costBudget(1000)(ctx({ totalTokens: 999 }))).toBe(false);
  });

  it("stops at exact budget", () => {
    expect(costBudget(1000)(ctx({ totalTokens: 1000 }))).toBe(true);
  });

  it("stops above budget", () => {
    expect(costBudget(1000)(ctx({ totalTokens: 1500 }))).toBe(true);
  });
});

describe("noProgress", () => {
  const fp = (name: string) => `${name}:{}`;

  it("does not stop when fewer than k steps recorded", () => {
    const history = [[fp("search")]];
    expect(noProgress(2)(ctx({ callHistory: history }))).toBe(false);
  });

  it("does not stop when last k steps differ", () => {
    const history = [[fp("search")], [fp("read")], [fp("search")]];
    expect(noProgress(3)(ctx({ callHistory: history }))).toBe(false);
  });

  it("stops when last k steps are identical", () => {
    const history = [[fp("search")], [fp("search")], [fp("search")]];
    expect(noProgress(3)(ctx({ callHistory: history }))).toBe(true);
  });

  it("stops after exactly k identical steps", () => {
    const history = [[fp("a")], [fp("b")], [fp("b")]];
    expect(noProgress(2)(ctx({ callHistory: history }))).toBe(true);
  });

  it("does not stop when a step has no calls (no false positive)", () => {
    const history: string[][] = [[], [], []];
    expect(noProgress(3)(ctx({ callHistory: history }))).toBe(false);
  });

  it("uses full arg signature — same tool, different args => no stop", () => {
    const history = [
      [`search:${JSON.stringify({ q: "foo" }, ["q"])}`],
      [`search:${JSON.stringify({ q: "bar" }, ["q"])}`],
    ];
    expect(noProgress(2)(ctx({ callHistory: history }))).toBe(false);
  });
});
