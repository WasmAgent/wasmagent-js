import { describe, it, expect } from "vitest";
import { getModelMeta } from "./types.js";

describe("getModelMeta — doubao registry and heuristic", () => {
  it("registered doubao-seed-1-6-251015 is reasoning + supportsReasoningEffort", () => {
    const meta = getModelMeta("doubao-seed-1-6-251015");
    expect(meta.isReasoning).toBe(true);
    expect(meta.supportsReasoningEffort).toBe(true);
    expect(meta.defaultEffort).toBe("medium");
  });

  it("registered doubao-1-5-pro-32k is non-reasoning", () => {
    const meta = getModelMeta("doubao-1-5-pro-32k");
    expect(meta.isReasoning).toBe(false);
    expect(meta.supportsReasoningEffort).toBe(false);
  });

  it("unknown doubao-* falls back to reasoning via heuristic", () => {
    const meta = getModelMeta("doubao-seed-9-9-999999");
    expect(meta.isReasoning).toBe(true);
    expect(meta.supportsReasoningEffort).toBe(true);
  });

  it("endpoint-ID style ep-xxx falls through to default (not doubao heuristic)", () => {
    // ep-xxx doesn't start with "doubao" — falls to generic default
    const meta = getModelMeta("ep-abc123");
    // Generic fallback: isReasoning false (endpoint IDs are not doubao-prefixed)
    expect(meta.isReasoning).toBe(false);
  });
});
