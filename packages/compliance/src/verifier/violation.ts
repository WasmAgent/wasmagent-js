/**
 * ConstraintViolation — what failed, and *where* in the artifact.
 *
 * # Why a separate type from CriterionVerdict
 *
 * `@wasmagent/core` `CriterionVerdict` is intentionally minimal — `{ok,
 * criterionId, hint?}`. That's enough for a single-shot retry loop. For
 * **local repair** we need more: which region of the artifact to
 * rewrite, what level/category the violation falls under (so the
 * planner can pick a repair strategy), and which lifecycle stage
 * detected it (pre-decode rule, post-decode validator, or post-tool-call
 * runtime check).
 *
 * `ConstraintViolation` is the enrichment of a failing verdict with the
 * `ConstraintIR` that produced it plus an `evidence_span` pointing into
 * the artifact. The compliance runner is responsible for producing it;
 * the verifier layer remains the simple core contract.
 *
 * # The evidence_span union
 *
 * Different verifiers know different things about *where* a violation
 * lives. Rather than force every verifier to compute every locator, we
 * model the span as a union of optional locators. A markdown verifier
 * sets `region_id` + `line_range`; a JSON schema verifier sets
 * `json_pointer`; a regex verifier sets `char_range`. The repair
 * planner picks whichever locator its strategy needs.
 *
 * Phase 0 verifiers set at most one locator per violation. Future
 * verifiers may set multiple — that's allowed, and the planner prefers
 * `json_pointer` > `region_id` > `line_range` > `char_range`.
 */

import type { CriterionVerdict } from "@wasmagent/core";
import { z } from "zod";
import type { ConstraintCategory, ConstraintIR, ConstraintLevel } from "../ir/ConstraintIR.js";
import { ConstraintCategorySchema, ConstraintLevelSchema } from "../ir/ConstraintIR.js";

/**
 * Lifecycle stage at which the violation was detected.
 *
 *   pre_decode      — caught by a structural pre-check (rare; reserved
 *                     for grammar/schema gate failures before generation).
 *   post_decode     — caught by a verifier after the artifact was
 *                     generated. This is the common case.
 *   post_tool_call  — caught by a tool/state verifier after a tool
 *                     invocation returned. Used for tool args, perms,
 *                     idempotency, and execution-log checks.
 */
export type ViolationStage = "pre_decode" | "post_decode" | "post_tool_call";

/**
 * Locator into the artifact. All fields optional; at least one MUST be
 * present (enforced at the schema level in `EvidenceSpanSchema`).
 */
export interface EvidenceSpan {
  /**
   * Semantic region label (e.g. "section:Conclusion", "tool_call:0",
   * "field:summary"). Free-form so different artifact types can use
   * their own conventions.
   */
  region_id?: string;
  /** RFC 6901 JSON pointer for JSON-shaped artifacts. */
  json_pointer?: string;
  /** Half-open byte/char range `[start, end)` into the artifact. */
  char_range?: [number, number];
  /** Inclusive line range `[start, end]`, 1-indexed. */
  line_range?: [number, number];
}

export interface ConstraintViolation {
  constraint_id: string;
  level: ConstraintLevel;
  category: ConstraintCategory;
  /** Original `Verifier` hint — kept verbatim for round-trip debugging. */
  hint: string;
  evidence_span?: EvidenceSpan;
  detected_at: ViolationStage;
}

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const ViolationStageSchema = z.enum(["pre_decode", "post_decode", "post_tool_call"]);

export const EvidenceSpanSchema = z
  .object({
    region_id: z.string().optional(),
    json_pointer: z.string().optional(),
    char_range: z.tuple([z.number().int(), z.number().int()]).optional(),
    line_range: z.tuple([z.number().int(), z.number().int()]).optional(),
  })
  .refine(
    (s) =>
      s.region_id !== undefined ||
      s.json_pointer !== undefined ||
      s.char_range !== undefined ||
      s.line_range !== undefined,
    {
      message:
        "EvidenceSpan must set at least one locator (region_id, json_pointer, char_range, or line_range)",
    }
  );

export const ConstraintViolationSchema = z.object({
  constraint_id: z.string().min(1),
  level: ConstraintLevelSchema,
  category: ConstraintCategorySchema,
  hint: z.string(),
  evidence_span: EvidenceSpanSchema.optional(),
  detected_at: ViolationStageSchema,
});

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a `ConstraintViolation` from a failing core verdict + the IR
 * that produced it. The caller (`ComplianceVerifier`) is expected to
 * compute the `evidence_span` from the verifier's hint/output and pass
 * it in — this factory does not parse the hint string.
 *
 * Throws if `verdict.ok` is true: passing verdicts have no violation.
 */
export function violationFromVerdict(
  ir: ConstraintIR,
  verdict: CriterionVerdict,
  opts: { stage: ViolationStage; evidence_span?: EvidenceSpan }
): ConstraintViolation {
  if (verdict.ok) {
    throw new Error(
      `violationFromVerdict called on a passing verdict (criterion=${verdict.criterionId})`
    );
  }
  if (verdict.criterionId !== ir.id) {
    throw new Error(
      `verdict/ir mismatch: verdict.criterionId=${verdict.criterionId} but ir.id=${ir.id}`
    );
  }
  return {
    constraint_id: ir.id,
    level: ir.level,
    category: ir.category,
    hint: verdict.hint,
    ...(opts.evidence_span !== undefined ? { evidence_span: opts.evidence_span } : {}),
    detected_at: opts.stage,
  };
}
