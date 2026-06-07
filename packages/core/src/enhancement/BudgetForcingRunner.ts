import type { Model, ModelMessage, GenerateOptions, StreamEvent } from "../models/types.js";

export interface BudgetForcingOptions {
  /**
   * Token to prepend to the assistant's response to force additional thinking.
   * Default: "Wait" — the standard budget-forcing token from Anthropic research.
   */
  prefillToken?: string;
  /**
   * Maximum number of "Wait" rounds before letting the model produce a final answer.
   * Default: 1.
   */
  maxWaitRounds?: number;
  /**
   * Minimum token count the model must produce before budget-forcing is applied.
   * If the initial response is already longer than this, skip forcing.
   * Default: 50 tokens (rough estimate).
   */
  minResponseTokens?: number;
}

export interface BudgetForcingResult {
  answer: string;
  /** Number of Wait rounds injected. */
  waitRoundsUsed: number;
}

/**
 * Budget Forcing runner (S4).
 *
 * Forces the model to produce a longer, more deliberate response by
 * injecting a "Wait" prefill token into the assistant turn and asking
 * it to continue. This gives the model more compute before committing
 * to a final answer.
 *
 * Reference: Muennighoff et al. 2025 "s1: Simple Test-Time Scaling"
 * — budget forcing with "Wait" tokens.
 *
 * Gate: only call this when ModelCapabilities.supportsBudgetForcing is true.
 * For OpenAI models (supportsBudgetForcing=false), omit and rely on
 * temperature/top_p diversity (SelfConsistencyRunner) instead.
 */
export class BudgetForcingRunner {
  readonly #prefillToken: string;
  readonly #maxWaitRounds: number;
  readonly #minResponseTokens: number;

  constructor(opts: BudgetForcingOptions = {}) {
    this.#prefillToken = opts.prefillToken ?? "Wait";
    this.#maxWaitRounds = Math.max(1, opts.maxWaitRounds ?? 1);
    this.#minResponseTokens = opts.minResponseTokens ?? 50;
  }

  /**
   * Generate a response, optionally forcing additional thinking via "Wait" prefill.
   *
   * @param model        The model to use. Should have supportsBudgetForcing=true.
   * @param messages     The assembled context messages. Not mutated.
   * @param generateOpts Options forwarded to all generate() calls.
   */
  async run(
    model: Model,
    messages: ModelMessage[],
    generateOpts: GenerateOptions = {}
  ): Promise<BudgetForcingResult> {
    const opts = { ...generateOpts, stream: true as const };
    let context = [...messages];
    let fullAnswer = "";
    let waitRoundsUsed = 0;

    // Initial generation.
    fullAnswer = await collectText(model, context, opts);

    for (let round = 0; round < this.#maxWaitRounds; round++) {
      // Skip forcing if the response is already long enough.
      const estimatedTokens = Math.ceil(fullAnswer.length / 4);
      if (estimatedTokens >= this.#minResponseTokens) break;

      // Inject the prefill token: append the assistant's draft + "Wait" as an
      // assistant message, then ask the model to continue.
      context = [
        ...context,
        { role: "assistant", content: fullAnswer + "\n" + this.#prefillToken },
        { role: "user", content: "Continue your reasoning and provide the complete answer." },
      ];

      const continuation = await collectText(model, context, opts);
      fullAnswer = continuation;
      waitRoundsUsed++;

      // If the continuation itself is long enough, stop.
      if (Math.ceil(continuation.length / 4) >= this.#minResponseTokens) break;
    }

    return { answer: fullAnswer, waitRoundsUsed };
  }
}

async function collectText(
  model: Model,
  messages: ModelMessage[],
  opts: GenerateOptions
): Promise<string> {
  let text = "";
  for await (const ev of model.generate(messages, opts)) {
    if (ev.type === "text_delta" && ev.delta) text += ev.delta;
  }
  return text.trim();
}
