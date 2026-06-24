/**
 * Repair strategy — common interface for `patch`, `insert_section`,
 * `regenerate_region`, and (eventually) `full`.
 *
 * Each strategy:
 *   1. Receives the current artifact + the violation it should address.
 *   2. Returns the proposed new artifact (or `null` if it can't make
 *      progress — the planner will escalate).
 *
 * Strategies do NOT re-verify. The planner verifies after every round.
 * This keeps strategies small and easy to test in isolation.
 *
 * # Why the strategy returns a *new artifact*, not a diff
 *
 * Phase 0 keeps artifacts small (an IFEval response is under 1 KB).
 * Returning the whole new artifact is simpler than diff-merge logic,
 * and the planner can compute a diff for telemetry if needed. Phase 1
 * may revisit when artifacts grow.
 */

import type { ConstraintIR, RepairStrategy as StrategyKind } from "../../ir/ConstraintIR.js";
import type { ConstraintViolation } from "../../verifier/violation.js";
import type { RepairLLM } from "../RepairLLM.js";

export interface StrategyContext {
  /** Current full text of the artifact under repair. */
  artifact: string;
  /** The violation we are trying to clear. */
  violation: ConstraintViolation;
  /** The IR that produced the violation — gives args/path/category. */
  ir: ConstraintIR;
  /**
   * All currently-failing violations, with the targeted one first.
   *
   * Strategies that rewrite the whole artifact (regenerate_region,
   * future `full`) MUST attend to the full list so they don't
   * accidentally re-break a previously-cleared constraint. Strategies
   * that only touch a span (patch, insert_section) typically ignore
   * this — they're scope-bounded by construction.
   *
   * Optional only for backward compatibility with strategy authors who
   * don't need it. The planner always populates it.
   */
  all_violations?: ConstraintViolation[];
  /**
   * LLM client for strategies that need generation. May be omitted
   * when the planner is configured for deterministic-only repair (used
   * in CI for tests that should not call out to a model).
   */
  llm?: RepairLLM;
}

export interface StrategyResult {
  /** New artifact text, or null if the strategy gives up. */
  artifact: string | null;
  /** Whether this strategy used the LLM (drives token-cost accounting). */
  used_llm: boolean;
  /** Optional LLM usage for the trace. */
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface RepairStrategy {
  readonly kind: StrategyKind;
  apply(ctx: StrategyContext): Promise<StrategyResult>;
}
