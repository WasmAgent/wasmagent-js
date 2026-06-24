import { describe, expect, test } from "bun:test";
import type { ConstraintIR } from "../../ir/ConstraintIR.js";
import type { ConstraintViolation } from "../../verifier/violation.js";
import { PatchStrategy } from "./patch.js";

const baseIR: Omit<ConstraintIR, "verify_method"> = {
  id: "c1",
  description: "",
  level: "hard",
  priority: 100,
  category: "format",
  path: "r.txt",
};

const violation: ConstraintViolation = {
  constraint_id: "c1",
  level: "hard",
  category: "format",
  hint: "",
  detected_at: "post_decode",
};

describe("PatchStrategy", () => {
  const strategy = new PatchStrategy();

  test("strips commas for ifeval:punctuation:no_comma", async () => {
    const result = await strategy.apply({
      artifact: "a, b, c",
      violation,
      ir: { ...baseIR, verify_method: "ifeval:punctuation:no_comma" },
    });
    expect(result.artifact).toBe("a b c");
    expect(result.used_llm).toBe(false);
  });

  test("lowercases ASCII letters for ifeval:change_case:english_lowercase", async () => {
    const result = await strategy.apply({
      artifact: "Hello WORLD! 你好",
      violation,
      ir: { ...baseIR, verify_method: "ifeval:change_case:english_lowercase" },
    });
    expect(result.artifact).toBe("hello world! 你好");
  });

  test("returns null artifact for an unknown verify_method", async () => {
    const result = await strategy.apply({
      artifact: "hi",
      violation,
      ir: { ...baseIR, verify_method: "ifeval:length_constraints:number_words" },
    });
    expect(result.artifact).toBeNull();
    expect(result.used_llm).toBe(false);
  });
});
