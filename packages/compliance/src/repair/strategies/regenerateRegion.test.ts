import { describe, expect, test } from "bun:test";
import type { ConstraintIR, TaskSpec } from "../../ir/ConstraintIR.js";
import type { ConstraintViolation } from "../../verifier/violation.js";
import { FakeRepairLLM } from "../RepairLLM.js";
import { RegenerateRegionStrategy } from "./regenerateRegion.js";

const ir: ConstraintIR = {
  id: "c1",
  description: "must be at least 10 words long",
  verify_method: "ifeval:length_constraints:number_words",
  arg: { relation: "at least", num_words: 10 },
  path: "r.txt",
  level: "hard",
  priority: 100,
  category: "format",
};

const violation: ConstraintViolation = {
  constraint_id: "c1",
  level: "hard",
  category: "format",
  hint: "response has 3 words; requires ≥10",
  detected_at: "post_decode",
};

describe("RegenerateRegionStrategy", () => {
  test("returns null when no LLM is provided", async () => {
    const strategy = new RegenerateRegionStrategy();
    const result = await strategy.apply({
      artifact: "too short",
      violation,
      ir,
    });
    expect(result.artifact).toBeNull();
    expect(result.used_llm).toBe(false);
  });

  test("calls the LLM with a prompt that includes the violation hint", async () => {
    const llm = new FakeRepairLLM([
      { match: () => true, reply: "a much longer response that has at least ten words in it now" },
    ]);
    const strategy = new RegenerateRegionStrategy();
    const result = await strategy.apply({
      artifact: "too short",
      violation,
      ir,
      llm,
    });
    expect(result.used_llm).toBe(true);
    expect(result.artifact).toMatch(/much longer/);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]?.prompt).toContain("response has 3 words");
    expect(llm.calls[0]?.prompt).toContain("too short");
  });

  test("includes other constraints' descriptions when spec is provided", async () => {
    const spec: TaskSpec = {
      id: "test.v1",
      intent: "test_run",
      language: "en",
      constraints: [
        ir,
        {
          id: "c2",
          description: "must not contain commas",
          verify_method: "ifeval:punctuation:no_comma",
          path: "r.txt",
          level: "hard",
          priority: 90,
          category: "format",
        },
      ],
      priority_hierarchy: ["system_policy", "user_explicit_constraints"],
    };
    const llm = new FakeRepairLLM([{ match: () => true, reply: "new text" }]);
    const strategy = new RegenerateRegionStrategy({ spec });
    await strategy.apply({ artifact: "x", violation, ir, llm });
    const prompt = llm.calls[0]?.prompt ?? "";
    expect(prompt).toContain("c1");
    expect(prompt).toContain("c2");
    expect(prompt).toContain("must not contain commas");
    // The violated constraint is marked.
    expect(prompt).toMatch(/❌ c1/);
  });

  test("uses the default temperature 0.2 when not configured", async () => {
    const llm = new FakeRepairLLM([{ match: () => true, reply: "x" }]);
    const strategy = new RegenerateRegionStrategy();
    await strategy.apply({ artifact: "y", violation, ir, llm });
    expect(llm.calls[0]?.temperature).toBe(0.2);
  });

  test("includes ALL outstanding violations when all_violations is provided", async () => {
    // Cumulative-constraints block — the model needs to see *every*
    // currently-failing constraint so it doesn't accidentally
    // un-fix one a previous round cleared.
    const llm = new FakeRepairLLM([{ match: () => true, reply: "ok" }]);
    const strategy = new RegenerateRegionStrategy();
    const otherViolation: ConstraintViolation = {
      constraint_id: "c2",
      level: "hard",
      category: "format",
      hint: "response contains commas",
      detected_at: "post_decode",
    };
    await strategy.apply({
      artifact: "y",
      violation,
      ir,
      llm,
      all_violations: [violation, otherViolation],
    });
    const prompt = llm.calls[0]?.prompt ?? "";
    // The other violation's hint MUST appear, under explicit "MUST
    // also still satisfy" language.
    expect(prompt).toContain("MUST also still satisfy");
    expect(prompt).toContain("response contains commas");
    expect(prompt).toContain("c2:");
    // The targeted violation must NOT appear in the cumulative block
    // (it has its own dedicated section above).
    const cumulativeBlock = prompt.split("MUST also still satisfy")[1] ?? "";
    expect(cumulativeBlock).not.toContain("c1:");
  });

  test("omits cumulative block when only one violation is outstanding", async () => {
    const llm = new FakeRepairLLM([{ match: () => true, reply: "ok" }]);
    const strategy = new RegenerateRegionStrategy();
    await strategy.apply({
      artifact: "y",
      violation,
      ir,
      llm,
      all_violations: [violation],
    });
    expect(llm.calls[0]?.prompt).not.toContain("MUST also still satisfy");
  });
});
