/**
 * ConstraintScorer — hard-constraint satisfaction.
 *
 * Tests whether the agent's run met required behavioral constraints:
 * specific tools must have been called, the answer must mention
 * required strings, the answer must be under a length limit, etc.
 *
 * Returns 1.0 only when ALL constraints are satisfied, else 0.0.
 * Use this for "must include policy disclaimer" or "must call validator
 * tool" use cases. For graded scoring, combine with CompositeScorer.
 */

import type { AgentTrace, Scorer, ScorerResult } from "./index.js";

export interface Constraints {
  /** Tools that MUST have been called at least once. */
  mustUseTool?: string[];
  /** Tools that must NOT have been called. */
  mustNotUseTool?: string[];
  /** Substrings that MUST appear in the final answer. */
  mustContain?: string[];
  /** Substrings that must NOT appear. */
  mustNotContain?: string[];
  /** Maximum length (chars) for the final answer. */
  maxLength?: number;
  /** Minimum length (chars) for the final answer. */
  minLength?: number;
}

export function constraintScorer(constraints: Constraints): Scorer {
  return {
    name: "constraint",
    score(trace: AgentTrace): ScorerResult {
      const violations: string[] = [];
      const calledTools = new Set(trace.toolCalls.map((c) => c.toolName));
      const answer = trace.finalAnswer ?? "";

      for (const tool of constraints.mustUseTool ?? []) {
        if (!calledTools.has(tool)) violations.push(`missing tool: ${tool}`);
      }
      for (const tool of constraints.mustNotUseTool ?? []) {
        if (calledTools.has(tool)) violations.push(`forbidden tool: ${tool}`);
      }
      for (const phrase of constraints.mustContain ?? []) {
        if (!answer.includes(phrase)) violations.push(`missing phrase: "${phrase}"`);
      }
      for (const phrase of constraints.mustNotContain ?? []) {
        if (answer.includes(phrase)) violations.push(`forbidden phrase: "${phrase}"`);
      }
      if (constraints.maxLength !== undefined && answer.length > constraints.maxLength) {
        violations.push(`length ${answer.length} > maxLength ${constraints.maxLength}`);
      }
      if (constraints.minLength !== undefined && answer.length < constraints.minLength) {
        violations.push(`length ${answer.length} < minLength ${constraints.minLength}`);
      }

      const score = violations.length === 0 ? 1 : 0;
      const result: ScorerResult = { scorer: "constraint", score };
      if (violations.length > 0) {
        result.detail = violations.join("; ");
      } else {
        result.detail = "all constraints satisfied";
      }
      return result;
    },
  };
}
