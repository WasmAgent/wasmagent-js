import { describe, expect, test } from "bun:test";
import type { ConstraintIR } from "../../ir/ConstraintIR.js";
import type { ConstraintViolation } from "../../verifier/violation.js";
import { InsertSectionStrategy } from "./insertSection.js";

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

describe("InsertSectionStrategy", () => {
  const strategy = new InsertSectionStrategy();

  test("prepends <<untitled>> for missing title", async () => {
    const result = await strategy.apply({
      artifact: "body of the response",
      violation,
      ir: { ...baseIR, verify_method: "ifeval:detectable_format:title" },
    });
    expect(result.artifact).toMatch(/^<<untitled>>\n/);
    expect(result.artifact?.includes("body of the response")).toBe(true);
  });

  test("appends missing keywords as a trailer for keywords:existence", async () => {
    const result = await strategy.apply({
      artifact: "the meeting went well",
      violation,
      ir: {
        ...baseIR,
        verify_method: "ifeval:keywords:existence",
        arg: { keywords: ["unicorn", "rainbow", "well"] },
      },
    });
    // 'well' present → not in trailer; the other two missing.
    expect(result.artifact?.endsWith("Keywords: unicorn, rainbow")).toBe(true);
  });

  test("returns the artifact unchanged when nothing actually missing", async () => {
    const result = await strategy.apply({
      artifact: "unicorn and rainbow agree",
      violation,
      ir: {
        ...baseIR,
        verify_method: "ifeval:keywords:existence",
        arg: { keywords: ["unicorn", "rainbow"] },
      },
    });
    expect(result.artifact).toBe("unicorn and rainbow agree");
  });

  test("returns null for an unhandled verify_method", async () => {
    const result = await strategy.apply({
      artifact: "x",
      violation,
      ir: { ...baseIR, verify_method: "ifeval:punctuation:no_comma" },
    });
    expect(result.artifact).toBeNull();
  });

  test("returns null when keywords arg is missing", async () => {
    const result = await strategy.apply({
      artifact: "x",
      violation,
      ir: { ...baseIR, verify_method: "ifeval:keywords:existence", arg: {} },
    });
    expect(result.artifact).toBeNull();
  });

  test("prepends prompt for combination:repeat_prompt", async () => {
    const prompt = "Write a haiku about cats.";
    const result = await strategy.apply({
      artifact: "i refuse to repeat that",
      violation,
      ir: {
        ...baseIR,
        verify_method: "ifeval:combination:repeat_prompt",
        arg: { prompt_to_repeat: prompt },
      },
    });
    // Must start with the verbatim prompt for the IFEval verifier to pass.
    expect(result.artifact?.startsWith(prompt)).toBe(true);
    // Existing body is preserved after a blank-line separator.
    expect(result.artifact).toBe(`${prompt}\n\ni refuse to repeat that`);
  });

  test("is idempotent for combination:repeat_prompt (no double-prepend)", async () => {
    const prompt = "Tell me a story.";
    const already = `${prompt}\n\nOnce upon a time...`;
    const result = await strategy.apply({
      artifact: already,
      violation,
      ir: {
        ...baseIR,
        verify_method: "ifeval:combination:repeat_prompt",
        arg: { prompt_to_repeat: prompt },
      },
    });
    expect(result.artifact).toBe(already);
  });

  test("returns null for combination:repeat_prompt when arg missing", async () => {
    const result = await strategy.apply({
      artifact: "x",
      violation,
      ir: {
        ...baseIR,
        verify_method: "ifeval:combination:repeat_prompt",
        arg: {},
      },
    });
    expect(result.artifact).toBeNull();
  });
});
