/**
 * FaithfulnessScorer — checks whether the agent's final answer is
 * grounded in the tool outputs (i.e. doesn't hallucinate facts beyond
 * what the tools returned).
 *
 * Uses an LLM-as-judge approach. Pass an async runner that takes a
 * prompt and returns a score in [0, 1] — typically wrapping a Model
 * adapter's generate() call.
 *
 * Like llmJudgeAsync, this scorer's `score()` is synchronous (the
 * Scorer interface is sync) and returns a sentinel. For real scoring,
 * call `faithfulnessScorerAsync()` directly from your eval runner.
 */

import type { Model } from "../models/types.js";
import type { AgentTrace, Scorer, ScorerResult } from "./index.js";

export interface FaithfulnessOpts {
  /** Model used as judge. Defaults to Haiku-tier expected via caller. */
  model: Model;
  /** Optional max output tokens for the judge call (default 64). */
  maxTokens?: number;
}

const FAITHFULNESS_PROMPT = (toolOutputs: string, answer: string) => `You are a strict fact-checker.

Evaluate whether the AGENT'S ANSWER is fully supported by the TOOL OUTPUTS provided. The answer is "faithful" if every factual claim in it is either present in the tool outputs or is a logical consequence of what the tools returned. The answer is "unfaithful" if it adds claims not supported by tool data.

TOOL OUTPUTS:
${toolOutputs.slice(0, 4000)}

AGENT'S ANSWER:
${answer.slice(0, 2000)}

Reply with a single number between 0.0 and 1.0:
- 1.0: every claim is supported
- 0.5: most claims are supported, some unverifiable
- 0.0: significant hallucinations

Output the number only, no explanation.`;

/** Synchronous sentinel. Use {@link faithfulnessScorerAsync} for real scoring. */
export function faithfulnessScorer(_opts: FaithfulnessOpts): Scorer {
  return {
    name: "faithfulness",
    score(): ScorerResult {
      return {
        scorer: "faithfulness",
        score: 0,
        detail: "Use faithfulnessScorerAsync() for asynchronous LLM evaluation",
      };
    },
  };
}

/** Async faithfulness evaluator — call directly from eval runners. */
export async function faithfulnessScorerAsync(
  opts: FaithfulnessOpts,
  trace: AgentTrace
): Promise<ScorerResult> {
  const toolOutputsText = trace.toolResults
    .map((r) => `[${r.toolName}] ${JSON.stringify(r.output).slice(0, 800)}`)
    .join("\n");
  const answer = trace.finalAnswer ?? "";

  if (!answer.trim()) {
    return { scorer: "faithfulness", score: 0, detail: "no final answer" };
  }
  if (!toolOutputsText.trim()) {
    return {
      scorer: "faithfulness",
      score: 1,
      detail: "no tool outputs to verify against — vacuously faithful",
    };
  }

  let text = "";
  for await (const ev of opts.model.generate(
    [{ role: "user", content: FAITHFULNESS_PROMPT(toolOutputsText, answer) }],
    { stream: true, maxTokens: opts.maxTokens ?? 64 }
  )) {
    if (ev.type === "text_delta" && ev.delta) text += ev.delta;
  }

  const num = Number.parseFloat(text.trim());
  if (Number.isNaN(num)) {
    return {
      scorer: "faithfulness",
      score: 0,
      detail: `judge returned non-numeric: "${text.trim().slice(0, 80)}"`,
    };
  }
  const clamped = Math.max(0, Math.min(1, num));
  return { scorer: "faithfulness", score: clamped, detail: `judge=${clamped}` };
}
