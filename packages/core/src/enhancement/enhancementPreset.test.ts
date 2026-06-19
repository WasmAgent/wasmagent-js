import { describe, expect, it } from "bun:test";
import { resolveEnhancement } from "./index.js";

describe("resolveEnhancement", () => {
  it("'none' returns undefined", () => {
    expect(resolveEnhancement("none")).toBeUndefined();
  });

  it("'reflect-once' returns reflectRefine with maxCycles=1", () => {
    const p = resolveEnhancement("reflect-once");
    expect(p?.reflectRefine?.enabled).toBe(true);
    expect(p?.reflectRefine?.maxCycles).toBe(1);
  });

  it("'self-consistency:3' returns selfConsistency with n=3", () => {
    const p = resolveEnhancement("self-consistency:3");
    expect(p?.selfConsistency?.enabled).toBe(true);
    expect(p?.selfConsistency?.n).toBe(3);
  });

  it("'parallel-fork:3' returns parallelForkJoin with branches=3", () => {
    const p = resolveEnhancement("parallel-fork:3");
    expect(p?.parallelForkJoin?.enabled).toBe(true);
    expect(p?.parallelForkJoin?.branches).toBe(3);
  });

  it("'budget-forcing' returns budgetForcing enabled", () => {
    const p = resolveEnhancement("budget-forcing");
    expect(p?.budgetForcing?.enabled).toBe(true);
  });
});
