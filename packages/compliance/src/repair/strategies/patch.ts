/**
 * PatchStrategy — deterministic single-edit repair for cheap, local
 * violations.
 *
 * What "cheap" means: a regex or single-character transform suffices.
 * Two IFEval classes fit:
 *
 *   - `ifeval:punctuation:no_comma`     → strip commas
 *   - `ifeval:change_case:english_lowercase` → lowercase ASCII letters
 *
 * Anything else returns `artifact: null`, signalling the planner to
 * escalate. The planner does NOT call patch for constraints whose
 * `repair.strategy` is not `patch` — but defensive `null` returns
 * cover the edge case where a future TaskSpec assigns `patch` to
 * something we don't handle.
 *
 * # Why not LLM
 *
 * For these two violations the deterministic transform is exact: comma
 * removal is a literal regex `s/,//g`, lowercasing is `String#toLowerCase`
 * applied per char. Using an LLM here costs tokens and risks re-introducing
 * the violation through hallucinated edits.
 */

import type { ConstraintIR } from "../../ir/ConstraintIR.js";
import type { ConstraintViolation } from "../../verifier/violation.js";
import type { RepairStrategy, StrategyContext, StrategyResult } from "./types.js";

export class PatchStrategy implements RepairStrategy {
  readonly kind = "patch" as const;

  async apply(ctx: StrategyContext): Promise<StrategyResult> {
    const transformer = pickTransformer(ctx.ir, ctx.violation);
    if (!transformer) {
      return { artifact: null, used_llm: false };
    }
    return {
      artifact: transformer(ctx.artifact),
      used_llm: false,
    };
  }
}

type Transformer = (text: string) => string;

/** Pick a transformer based on the constraint's verify_method. */
function pickTransformer(ir: ConstraintIR, _violation: ConstraintViolation): Transformer | null {
  switch (ir.verify_method) {
    case "ifeval:punctuation:no_comma":
      return (t) => t.replace(/,/g, "");
    case "ifeval:change_case:english_lowercase":
      return (t) => lowercaseAsciiOnly(t);
    default:
      return null;
  }
}

/**
 * Lowercase only ASCII A–Z; leave other characters alone. Matches the
 * IFEval verifier's reading of `english_lowercase`.
 */
function lowercaseAsciiOnly(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch >= 65 && ch <= 90) {
      out += String.fromCharCode(ch + 32);
    } else {
      out += text[i];
    }
  }
  return out;
}
