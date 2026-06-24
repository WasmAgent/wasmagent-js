/**
 * ConstraintIR — typed, repairable, prioritised superset of `@wasmagent/core`
 * `Criterion`.
 *
 * # Why extend Criterion instead of redefining
 *
 * `@wasmagent/core` already exposes a deterministic `Verifier` interface keyed
 * on `verify_method` (an open string union). `Criterion` is the JSON-shaped
 * "what to check"; `Verifier` is the code that turns it into a verdict. We
 * keep both. A `ConstraintIR` is a `Criterion` plus four orthogonal axes the
 * core lacks:
 *
 *   - `level`     — hard vs. soft (hard failures must block the run)
 *   - `priority`  — used by the resolver when constraints conflict
 *   - `category`  — format / content / style / tool / state / security / semantic
 *   - `repair`    — which repair strategy + region applies on failure
 *
 * This means **every existing `Verifier` (DeterministicVerifier,
 * BuildPassesVerifier, ScalarLLMJudgeVerifier, …) works on ConstraintIR
 * unchanged**. The compliance layer adds the orchestration, conflict
 * resolution, and repair planning on top.
 *
 * # On evidence_span
 *
 * `Criterion` produces a `CriterionVerdict` with at most a `hint` string.
 * For local repair we need *where* in the artifact the violation lives — a
 * section name, a JSON pointer, a char/line range. The compliance layer
 * collects this in `ConstraintViolation` (sibling file), not on the IR
 * itself; the IR only declares *what to check* and *how to repair*.
 *
 * # Stability
 *
 * Phase-0 contract. Add fields liberally during alpha; rename them only
 * with a Changeset note. The wire shape is mirrored in
 * `schemas/constraint-ir.schema.json` — keep the two in sync.
 */

import type { Criterion } from "@wasmagent/core";
import { z } from "zod";

/**
 * Hardness of a constraint.
 *
 *   hard — failure blocks the run; repair is required before the run can
 *          be marked "pass". Used for format/structure/tool-args/security
 *          constraints where downstream consumers depend on the contract.
 *   soft — failure is recorded but does not block. Used for style and
 *          quality preferences whose violation is acceptable. The
 *          `RepairPlanner` may opportunistically repair soft violations
 *          when the budget allows.
 */
export type ConstraintLevel = "hard" | "soft";

/**
 * Taxonomy used to slice failure rates in the eval report. Not used at
 * runtime for dispatch — verifiers are still selected by `verify_method`.
 */
export type ConstraintCategory =
  | "format" // JSON/Markdown structure, schema shape
  | "content" // section presence, keyword coverage, citation
  | "style" // tone, register, language id
  | "tool" // tool-call name/args/order/idempotency
  | "state" // execution log, transaction consistency
  | "security" // sandbox, denylist, permission policy
  | "semantic"; // judge / NLI / argumentation quality

/**
 * Strategy the RepairPlanner should attempt first when this constraint
 * fails. The planner may escalate (e.g. `patch` → `regenerate_region`)
 * if cheaper strategies don't clear the violation.
 *
 *   patch              — token/span edit; cheapest, used for
 *                        missing-keyword / wrong-format-fragment.
 *   insert_section     — add a missing markdown section or JSON field.
 *   regenerate_region  — rewrite a bounded region (section, field, tool
 *                        arg block) keeping the rest of the artifact.
 *   full               — last resort; regenerate the whole artifact.
 */
export type RepairStrategy = "patch" | "insert_section" | "regenerate_region" | "full";

export interface RepairPolicy {
  strategy: RepairStrategy;
  /**
   * Where the strategy should apply. Interpretation depends on the
   * artifact type:
   *   - markdown: section heading (e.g. "Conclusion")
   *   - json:     JSON pointer (e.g. "/outputs/0/value")
   *   - tool:     argument name (e.g. "query")
   * Optional — `patch` may run without a target by relying on the
   * violation's `evidence_span` instead.
   */
  target_region?: string;
  /** Per-constraint override of TaskSpec.repair.max_rounds. */
  max_rounds?: number;
}

/**
 * ConstraintIR — what to check, how strict, and how to repair on
 * failure. Extends `@wasmagent/core` `Criterion` so the existing
 * `VerificationPipeline` can run it verbatim.
 */
export interface ConstraintIR extends Criterion {
  level: ConstraintLevel;
  /**
   * Priority for conflict resolution. Higher wins. Range is open; the
   * conventional band is 0 (style hint) – 100 (system policy). The
   * resolver compares constraints **within the same priority class** of
   * `TaskSpec.priority_hierarchy`; this number breaks ties inside the
   * class.
   */
  priority: number;
  category: ConstraintCategory;
  repair?: RepairPolicy;
}

/**
 * Sources of authority for constraints, in conventional descending
 * order. Used by the conflict resolver: when two constraints disagree,
 * the one whose source appears earlier in `TaskSpec.priority_hierarchy`
 * wins, with `priority` (number) used to break ties inside a source.
 */
export type ConstraintSource =
  | "system_policy"
  | "user_explicit_constraints"
  | "task_package_constraints"
  | "tool_output_constraints"
  | "history_constraints"
  | "style_preferences";

export interface ToolPolicy {
  allowed: string[];
  denied?: string[];
}

export interface TaskSpecRepairConfig {
  /** Max repair rounds across all violations in a single run. */
  max_rounds: number;
  /** Default strategy when a constraint has no per-constraint repair policy. */
  default_strategy: RepairStrategy;
}

export interface TaskSpecTraceConfig {
  record_constraint_eval: boolean;
  record_tool_calls: boolean;
  record_repairs: boolean;
}

/**
 * TaskSpec — the public contract for a compliance run.
 *
 * One TaskSpec → one run → one ComplianceEvalRecord. The spec can be
 * hand-authored (Phase 0) or compiled from natural language (Phase 2+).
 * Either way, the runtime treats it as the source of truth: every
 * verifier verdict, every repair, every export is traceable back to a
 * constraint id declared here.
 */
export interface TaskSpec {
  /** Stable id used to group runs of the same task across models / time. */
  id: string;
  /** Free-form intent label (e.g. "produce_research_plan"). */
  intent: string;
  /** BCP-47 language tag (e.g. "zh-CN", "en"). */
  language: string;
  /** Optional audience label, surfaced to style/semantic verifiers. */
  audience?: string;
  constraints: ConstraintIR[];
  /**
   * Authority order for conflict resolution. Earlier sources win. The
   * runtime does not enforce a fixed list — task packages may introduce
   * their own sources — but the conventional default is:
   *   ["system_policy", "user_explicit_constraints",
   *    "task_package_constraints", "tool_output_constraints",
   *    "history_constraints", "style_preferences"]
   */
  priority_hierarchy: ConstraintSource[];
  tools?: ToolPolicy;
  repair?: TaskSpecRepairConfig;
  trace?: TaskSpecTraceConfig;
}

// ── Zod schemas — runtime validation ───────────────────────────────────────
//
// We keep the Zod schemas in the same file as the TS types so the two
// shapes can't drift. JSON schema lives in `schemas/*.schema.json` and
// is generated/synced manually for Phase 0 — moving to
// `zod-to-json-schema` is a Phase 1 task.

export const ConstraintLevelSchema = z.enum(["hard", "soft"]);

export const ConstraintCategorySchema = z.enum([
  "format",
  "content",
  "style",
  "tool",
  "state",
  "security",
  "semantic",
]);

export const RepairStrategySchema = z.enum([
  "patch",
  "insert_section",
  "regenerate_region",
  "full",
]);

export const RepairPolicySchema = z.object({
  strategy: RepairStrategySchema,
  target_region: z.string().optional(),
  max_rounds: z.number().int().positive().optional(),
});

/**
 * Zod schema for ConstraintIR. Note we do NOT validate `verify_method`
 * against a fixed enum — it is an open string in core so custom
 * verifiers can register their own method names.
 */
export const ConstraintIRSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  verify_method: z.string().min(1),
  arg: z.unknown().optional(),
  path: z.string().optional(),
  level: ConstraintLevelSchema,
  priority: z.number(),
  category: ConstraintCategorySchema,
  repair: RepairPolicySchema.optional(),
});

export const ConstraintSourceSchema = z.enum([
  "system_policy",
  "user_explicit_constraints",
  "task_package_constraints",
  "tool_output_constraints",
  "history_constraints",
  "style_preferences",
]);

export const ToolPolicySchema = z.object({
  allowed: z.array(z.string()),
  denied: z.array(z.string()).optional(),
});

export const TaskSpecRepairConfigSchema = z.object({
  max_rounds: z.number().int().nonnegative(),
  default_strategy: RepairStrategySchema,
});

export const TaskSpecTraceConfigSchema = z.object({
  record_constraint_eval: z.boolean(),
  record_tool_calls: z.boolean(),
  record_repairs: z.boolean(),
});

export const TaskSpecSchema = z.object({
  id: z.string().min(1),
  intent: z.string().min(1),
  language: z.string().min(1),
  audience: z.string().optional(),
  constraints: z.array(ConstraintIRSchema).min(1),
  priority_hierarchy: z.array(ConstraintSourceSchema).min(1),
  tools: ToolPolicySchema.optional(),
  repair: TaskSpecRepairConfigSchema.optional(),
  trace: TaskSpecTraceConfigSchema.optional(),
});

/**
 * Parse-and-validate a TaskSpec from unknown JSON input.
 *
 * Returns the typed value on success, throws a `z.ZodError` on failure.
 * Callers that want to surface validation errors to a user should catch
 * and inspect `error.issues`.
 */
export function parseTaskSpec(raw: unknown): TaskSpec {
  return TaskSpecSchema.parse(raw) as TaskSpec;
}

/**
 * Default priority hierarchy used when a TaskSpec omits it. Exposed as
 * a constant so tests and downstream packages can refer to it without
 * stringly-typed duplication.
 */
export const DEFAULT_PRIORITY_HIERARCHY: readonly ConstraintSource[] = [
  "system_policy",
  "user_explicit_constraints",
  "task_package_constraints",
  "tool_output_constraints",
  "history_constraints",
  "style_preferences",
] as const;
