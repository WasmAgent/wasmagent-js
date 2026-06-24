/**
 * ComplianceVerifier — thin wrapper around `@wasmagent/core`
 * `VerificationPipeline` that enriches failing verdicts into
 * `ConstraintViolation`s.
 *
 * # What this is (and isn't)
 *
 * This is the **glue** between the core verifier protocol and the
 * compliance run record. It doesn't introduce a new verifier dispatch
 * mechanism — it reuses `VerificationPipeline` verbatim. The added
 * value is:
 *
 *   1. Drive verification from a `TaskSpec` rather than a loose array
 *      of criteria (so verifier output stays traceable to a stable
 *      task id).
 *   2. Convert failing `CriterionVerdict`s into `ConstraintViolation`s
 *      that carry the `ConstraintIR` (level/category) plus an
 *      `evidence_span` for downstream local repair.
 *
 * Phase 0 sets the simplest possible `evidence_span`: for a
 * `file_contains` failure we set `region_id` to the failing file path.
 * Verifier-specific span computation (e.g. JSON pointers, line ranges)
 * lands as those verifiers are added in Phase 0 Days 3-4.
 *
 * # Why no priority resolver here
 *
 * Conflict resolution is a planner concern, not a verifier concern. A
 * verifier reports what it sees. The `RepairPlanner` (sibling
 * directory) consumes the violation list and decides which
 * non-conformances to act on and in what order, using
 * `TaskSpec.priority_hierarchy` + `ConstraintIR.priority`.
 */

import type { Criterion, VerificationPipeline } from "@wasmagent/core";
import type { ConstraintIR, TaskSpec } from "../ir/ConstraintIR.js";
import {
  type ConstraintViolation,
  type EvidenceSpan,
  type ViolationStage,
  violationFromVerdict,
} from "./violation.js";

/**
 * Hook a caller can register to compute richer `evidence_span` locators
 * for a given verify_method. The default (no hook) emits a `region_id`
 * built from the constraint's `path` (or the constraint id if no path
 * is set).
 */
export type EvidenceSpanHook = (ir: ConstraintIR, hint: string) => EvidenceSpan | undefined;

export interface ComplianceVerifierOptions {
  /**
   * Configured `VerificationPipeline` from `@wasmagent/core`. Callers
   * own pipeline construction so they can register custom verifiers
   * (IFEvalVerifier, JSON schema verifier, etc.) before wrapping.
   */
  pipeline: VerificationPipeline;
  /**
   * Optional per-method evidence span computer. Map keys are
   * `verify_method` strings; the value is invoked when that method's
   * verdict fails.
   */
  evidenceSpanHooks?: Record<string, EvidenceSpanHook>;
}

export interface ComplianceVerificationResult {
  ok: boolean;
  /** Violations in the order their constraints appeared in the TaskSpec. */
  violations: ConstraintViolation[];
  /** All criteria that PASSED — useful for partial-progress UI. */
  passing_constraint_ids: string[];
  /**
   * Compact aggregated hint mirrored from the underlying pipeline, for
   * Prompt+Retry baselines that want a plain-string feedback loop.
   */
  hint?: string;
}

export class ComplianceVerifier {
  readonly #pipeline: VerificationPipeline;
  readonly #hooks: Record<string, EvidenceSpanHook>;

  constructor(opts: ComplianceVerifierOptions) {
    this.#pipeline = opts.pipeline;
    this.#hooks = opts.evidenceSpanHooks ?? {};
  }

  /**
   * Run all of the spec's constraints through the underlying pipeline
   * and convert failing verdicts to violations.
   *
   * `stage` is recorded on each violation. Most callers pass
   * `"post_decode"`. Tool/state verifiers should pass
   * `"post_tool_call"`. `"pre_decode"` is reserved for future
   * grammar/schema gate checks.
   */
  async verify(
    spec: TaskSpec,
    opts: { stage?: ViolationStage } = {}
  ): Promise<ComplianceVerificationResult> {
    const stage: ViolationStage = opts.stage ?? "post_decode";
    // ConstraintIR extends Criterion, so the pipeline accepts the array
    // verbatim. We cast through `as Criterion[]` because TS won't widen
    // the union automatically across the package boundary.
    const criteria: Criterion[] = spec.constraints as Criterion[];
    const result = await this.#pipeline.run(criteria);

    const irById = new Map(spec.constraints.map((c) => [c.id, c]));
    const violations: ConstraintViolation[] = [];
    const passing_constraint_ids: string[] = [];

    for (const verdict of result.verdicts) {
      if (verdict.ok) {
        passing_constraint_ids.push(verdict.criterionId);
        continue;
      }
      const ir = irById.get(verdict.criterionId);
      if (!ir) {
        // Should be impossible — the pipeline only emits verdicts for
        // criteria we passed in. Defensive: skip rather than crash.
        continue;
      }
      const hook = this.#hooks[ir.verify_method];
      const evidence_span = hook?.(ir, verdict.hint) ?? defaultEvidenceSpan(ir);
      violations.push(
        violationFromVerdict(ir, verdict, {
          stage,
          ...(evidence_span !== undefined ? { evidence_span } : {}),
        })
      );
    }

    return {
      ok: violations.length === 0,
      violations,
      passing_constraint_ids,
      ...(result.hint !== undefined ? { hint: result.hint } : {}),
    };
  }
}

/**
 * Default span: use the constraint's `path` as a `region_id`, falling
 * back to the constraint id. Always emits something so the planner has
 * a target, even when the verifier doesn't know more.
 */
function defaultEvidenceSpan(ir: ConstraintIR): EvidenceSpan {
  return {
    region_id: ir.path !== undefined ? `path:${ir.path}` : `constraint:${ir.id}`,
  };
}
