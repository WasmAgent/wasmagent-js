/**
 * RepairTrace — one record per repair round.
 *
 * Mirrors `@wasmagent/protocol` (schemas/compliance/repair-trace.schema.json) field-for-field; this is
 * the TS-typed view of the same wire shape.
 *
 * # Why "per round", not "per violation"
 *
 * A single round can target multiple violations (e.g. one
 * `regenerate_region` rewrite often clears 3-4 failing constraints at
 * once). Recording per round keeps the trace compact and matches the
 * cost-accounting unit: one LLM call = one round = one trace entry.
 *
 * # Trace shape
 *
 * Each entry says:
 *   - which round this is (1-indexed)
 *   - which violations the round attempted to clear
 *   - which strategy ran
 *   - whether the re-verification cleared the targeted violations
 *   - which violations are still failing after the round (for the
 *     next round's planning)
 *   - token cost and latency for the round (optional but recommended)
 */

import { z } from "zod";
import { RepairStrategySchema } from "../ir/ConstraintIR.js";

export interface RepairTraceEntry {
  /** 1-indexed round number within a single run. */
  round: number;
  /** constraint_ids this round targeted. Non-empty. */
  violation_ids: string[];
  strategy: "patch" | "insert_section" | "regenerate_region" | "full";
  /** Optional region label the strategy aimed at, if any. */
  target_region?: string;
  /**
   * True iff post-repair re-verification cleared *all* targeted
   * violations. False means escalation may be needed in the next
   * round.
   */
  ok: boolean;
  /**
   * Set to `true` when the strategy produced an artifact that
   * re-broke a previously-passing constraint, and the planner rolled
   * back. The trace entry is recorded so that downstream consumers
   * can count regressions, but the artifact state is unchanged from
   * before this round. Implies `ok=false`.
   */
  rolled_back?: boolean;
  /** Violations still failing after this round. May overlap with violation_ids. */
  remaining_violation_ids?: string[];
  token_cost?: {
    prompt?: number;
    generation?: number;
  };
  latency_ms?: number;
}

export const RepairTraceEntrySchema = z.object({
  round: z.number().int().positive(),
  violation_ids: z.array(z.string()).min(1),
  strategy: RepairStrategySchema,
  target_region: z.string().optional(),
  ok: z.boolean(),
  rolled_back: z.boolean().optional(),
  remaining_violation_ids: z.array(z.string()).optional(),
  token_cost: z
    .object({
      prompt: z.number().int().nonnegative().optional(),
      generation: z.number().int().nonnegative().optional(),
    })
    .optional(),
  latency_ms: z.number().int().nonnegative().optional(),
});
