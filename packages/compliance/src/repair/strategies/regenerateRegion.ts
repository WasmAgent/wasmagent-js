/**
 * RegenerateRegionStrategy — LLM-driven rewrite of the whole artifact
 * (or, in Phase 1, a bounded region of it).
 *
 * Phase 0 scope: "regenerate region" == "regenerate the entire
 * artifact". IFEval responses are small enough that rewriting a
 * span-level region is not worth the complexity yet. The class is
 * named `RegenerateRegionStrategy` so the Phase 1 evolution doesn't
 * require renames.
 *
 * # Prompt shape
 *
 * The LLM gets:
 *   - The original task description (TaskSpec.intent + the verbose
 *     description of every violated constraint).
 *   - The previous artifact (so the model can preserve good parts).
 *   - The violations list (so the model knows what to fix).
 *
 * Output: a single new artifact string. No JSON, no metadata.
 *
 * # Why not stream constraints back as a structured prompt
 *
 * We could ask the model to address each violation in turn with a
 * JSON output. Phase 0 keeps it minimal: a plain rewrite prompt. The
 * structured-output path lands in Phase 1 once we wire XGrammar /
 * Outlines through `@wasmagent/core` models.
 */

import type { ConstraintIR, TaskSpec } from "../../ir/ConstraintIR.js";
import type { ConstraintViolation } from "../../verifier/violation.js";
import type { RepairStrategy, StrategyContext, StrategyResult } from "./types.js";

export interface RegenerateRegionStrategyOptions {
  /**
   * Optional TaskSpec — passed in by the planner so the strategy can
   * include the spec's intent and other constraints' descriptions
   * in the prompt. Without it the prompt is much weaker (the strategy
   * only sees one violation).
   */
  spec?: TaskSpec;
  /**
   * Hard cap on regeneration tokens. Default 512.
   *
   * IFEval responses are short by design (most under 200 tokens). A
   * conservative cap matters because **uncapped llama.cpp generations
   * on a CPU backend can take many minutes** — confirmed via stack
   * sampling on the 2026-06-24 P1 sweep where a single `letter_frequency`
   * sample stalled the sweep for 6+ minutes burning through context.
   * 512 is enough for the longest IFEval reference response with
   * headroom, and small enough to keep the runtime bounded.
   */
  max_tokens?: number;
  /** Temperature; default 0.2 (constraint-driven, not creative). */
  temperature?: number;
}

export class RegenerateRegionStrategy implements RepairStrategy {
  readonly kind = "regenerate_region" as const;
  readonly #opts: RegenerateRegionStrategyOptions;

  constructor(opts: RegenerateRegionStrategyOptions = {}) {
    this.#opts = opts;
  }

  async apply(ctx: StrategyContext): Promise<StrategyResult> {
    if (!ctx.llm) {
      // No LLM available. This is a configuration error at the
      // planner level — surface as null so the planner can fall back
      // (rather than throw and crash the run).
      return { artifact: null, used_llm: false };
    }
    const prompt = buildPrompt(
      ctx.ir,
      ctx.violation,
      ctx.artifact,
      this.#opts.spec,
      ctx.all_violations
    );
    const response = await ctx.llm.complete({
      prompt,
      max_tokens: this.#opts.max_tokens ?? 512,
      temperature: this.#opts.temperature ?? 0.2,
    });
    return {
      artifact: response.text,
      used_llm: true,
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }
}

function buildPrompt(
  ir: ConstraintIR,
  violation: ConstraintViolation,
  previousArtifact: string,
  spec: TaskSpec | undefined,
  allViolations: ConstraintViolation[] | undefined
): string {
  const lines: string[] = [];
  lines.push("You are rewriting a response to satisfy the following constraint(s).");
  lines.push("");
  if (spec) {
    lines.push(`Task: ${spec.intent}`);
    lines.push(`Language: ${spec.language}`);
    lines.push("");
    lines.push("All constraints (the violated ones are marked with ❌):");
    for (const c of spec.constraints) {
      const marker = c.id === ir.id ? "❌" : "•";
      lines.push(`  ${marker} ${c.id}: ${c.description}`);
    }
  } else {
    lines.push(`Constraint to satisfy: ${ir.description}`);
  }
  lines.push("");

  // Targeted violation first.
  lines.push("Specific failure to fix:");
  lines.push(`  ${violation.hint}`);
  lines.push("");

  // Cumulative-constraints block — list every CURRENTLY-FAILING
  // constraint's hint, not just the targeted one. Without this the
  // model often un-fixes constraints that previous rounds cleared
  // (the "repair regression" failure mode — 6 of 23 PCL failures in
  // the 2026-06-24 sweep). The "MUST also still satisfy" framing was
  // chosen because plain "satisfy these too" was empirically weaker
  // on Qwen2.5-1.5B.
  if (allViolations && allViolations.length > 1) {
    const others = allViolations.filter((v) => v.constraint_id !== ir.id);
    if (others.length > 0) {
      lines.push("Your rewrite MUST also still satisfy these other unmet constraints:");
      for (const v of others) {
        lines.push(`  - ${v.constraint_id}: ${v.hint}`);
      }
      lines.push("");
    }
  }

  lines.push("Previous response:");
  lines.push("---");
  lines.push(previousArtifact);
  lines.push("---");
  lines.push("");
  lines.push(
    "Rewrite the response to satisfy ALL constraints. Output ONLY the new response text — no explanation, no markdown fences, no JSON."
  );
  return lines.join("\n");
}
