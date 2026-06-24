import { describe, expect, test } from "bun:test";
import type { CriterionVerdict } from "@wasmagent/core";
import type { ConstraintIR } from "../ir/ConstraintIR.js";
import {
  ConstraintViolationSchema,
  EvidenceSpanSchema,
  violationFromVerdict,
} from "./violation.js";

const ir: ConstraintIR = {
  id: "c1",
  description: "must contain conclusion",
  verify_method: "file_contains",
  arg: "# Conclusion",
  path: "out.md",
  level: "hard",
  priority: 100,
  category: "format",
};

describe("EvidenceSpan", () => {
  test("requires at least one locator", () => {
    expect(() => EvidenceSpanSchema.parse({})).toThrow();
  });

  test("accepts region_id only", () => {
    expect(() => EvidenceSpanSchema.parse({ region_id: "section:Conclusion" })).not.toThrow();
  });

  test("accepts char_range tuple", () => {
    expect(() => EvidenceSpanSchema.parse({ char_range: [10, 25] })).not.toThrow();
  });
});

describe("violationFromVerdict", () => {
  test("converts a failing verdict to a violation", () => {
    const verdict: CriterionVerdict = {
      ok: false,
      criterionId: "c1",
      hint: "file out.md does not contain '# Conclusion'",
    };
    const v = violationFromVerdict(ir, verdict, {
      stage: "post_decode",
      evidence_span: { region_id: "section:Conclusion" },
    });
    expect(v.constraint_id).toBe("c1");
    expect(v.level).toBe("hard");
    expect(v.category).toBe("format");
    expect(v.detected_at).toBe("post_decode");
    expect(v.evidence_span?.region_id).toBe("section:Conclusion");
    // Schema round-trip — the factory output must validate.
    expect(() => ConstraintViolationSchema.parse(v)).not.toThrow();
  });

  test("omits evidence_span when not provided", () => {
    const verdict: CriterionVerdict = { ok: false, criterionId: "c1", hint: "x" };
    const v = violationFromVerdict(ir, verdict, { stage: "post_decode" });
    expect(v.evidence_span).toBeUndefined();
  });

  test("throws on a passing verdict", () => {
    const verdict: CriterionVerdict = { ok: true, criterionId: "c1" };
    expect(() => violationFromVerdict(ir, verdict, { stage: "post_decode" })).toThrow();
  });

  test("throws on verdict/ir id mismatch", () => {
    const verdict: CriterionVerdict = { ok: false, criterionId: "other", hint: "x" };
    expect(() => violationFromVerdict(ir, verdict, { stage: "post_decode" })).toThrow();
  });
});
