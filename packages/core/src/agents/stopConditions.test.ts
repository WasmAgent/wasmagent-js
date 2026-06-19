import type { StopConditionContext } from "./stopConditions.js";
import {
  costBudget,
  noProgress,
  parseStopPolicies,
  parseStopPolicy,
  stepCountIs,
} from "./stopConditions.js";

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

describe("parseStopPolicy", () => {
  const base: StopConditionContext = {
    step: 1,
    totalTokens: 0,
    lastCallFingerprints: [],
    callHistory: [],
  };

  it("parses 'steps:10' — stops at step 11", () => {
    const cond = parseStopPolicy("steps:10");
    expect(cond).not.toBeNull();
    expect(cond!({ ...base, step: 10 })).toBe(false);
    expect(cond!({ ...base, step: 11 })).toBe(true);
  });

  it("parses 'stepCount:5' (alias) — same as steps:5", () => {
    const cond = parseStopPolicy("stepCount:5");
    expect(cond).not.toBeNull();
    expect(cond!({ ...base, step: 5 })).toBe(false);
    expect(cond!({ ...base, step: 6 })).toBe(true);
  });

  it("parses 'cost:50000' — stops when tokens >= 50000", () => {
    const cond = parseStopPolicy("cost:50000");
    expect(cond).not.toBeNull();
    expect(cond!({ ...base, totalTokens: 49999 })).toBe(false);
    expect(cond!({ ...base, totalTokens: 50000 })).toBe(true);
  });

  it("parses 'costBudget:1000' (alias)", () => {
    const cond = parseStopPolicy("costBudget:1000");
    expect(cond).not.toBeNull();
    expect(cond!({ ...base, totalTokens: 1000 })).toBe(true);
  });

  it("parses 'noProgress' — defaults to k=3", () => {
    const cond = parseStopPolicy("noProgress");
    expect(cond).not.toBeNull();
    const repeat = [["a:{}"], ["a:{}"], ["a:{}"]];
    expect(cond!({ ...base, callHistory: repeat })).toBe(true);
  });

  it("parses 'noProgress:5' — uses k=5", () => {
    const cond = parseStopPolicy("noProgress:5");
    expect(cond).not.toBeNull();
    const three = [["a:{}"], ["a:{}"], ["a:{}"]];
    const five = [["a:{}"], ["a:{}"], ["a:{}"], ["a:{}"], ["a:{}"]];
    expect(cond!({ ...base, callHistory: three })).toBe(false);
    expect(cond!({ ...base, callHistory: five })).toBe(true);
  });

  it("returns null for unknown descriptors", () => {
    expect(parseStopPolicy("unknown")).toBeNull();
    expect(parseStopPolicy("steps:notanumber")).toBeNull();
    expect(parseStopPolicy("")).toBeNull();
  });

  it("parseStopPolicies filters nulls and returns valid conditions", () => {
    const conds = parseStopPolicies(["steps:2", "bad-descriptor", "cost:100"]);
    expect(conds).toHaveLength(2);
  });
});
