import type { OutputGuardrail } from "../guardrails/index.js";
import { runOutputGuardrails } from "../guardrails/index.js";
import type { GenerateOptions, Model, ModelMessage } from "../models/types.js";

export interface ReflectRefineOptions {
  /** Maximum reflection-refinement cycles (default 1). */
  maxCycles?: number;
  /**
   * Quality signal function. Receives the draft answer and returns true when
   * the answer is good enough to stop. Default: always refine once regardless.
   */
  qualitySignal?: (draft: string) => boolean | Promise<boolean>;
  /** Prompt appended to ask the model to critique the draft. */
  critiquePrompt?: string;
  /** Prompt appended to ask the model to refine given the critique. */
  refinePrompt?: string;
  /**
   * C1: Output guardrails used as quality signal.
   * If any output guardrail passes (no tripwire), the draft is considered
   * satisfactory and the loop terminates early. If a tripwire fires, that
   * signals the loop should continue refining.
   *
   * Takes priority over qualitySignal when provided.
   */
  outputGuardrails?: OutputGuardrail[];
}

export interface ReflectRefineResult {
  answer: string;
  /** Number of refinement cycles actually performed. */
  cyclesUsed: number;
}

const DEFAULT_CRITIQUE_PROMPT =
  "Review your previous answer for accuracy and completeness. " +
  "Identify any errors, gaps, or improvements needed. " +
  "Provide your critique inside <critique>...</critique> tags.";

const DEFAULT_REFINE_PROMPT =
  "Given the critique above, produce an improved final answer. " +
  "Respond with the refined answer only — no preamble.";

/**
 * Reflect-Refine runner (P3).
 *
 * Two-phase loop:
 *   1. Critique phase — model reviews its own draft and identifies issues.
 *   2. Refine phase  — model rewrites the answer given the critique.
 *
 * The loop runs at most maxCycles times. Each cycle uses an isolated context
 * (the critique + refine exchange is NOT added to the caller's message history)
 * so the upstream assembler's state is never mutated.
 *
 * A qualitySignal callback can terminate the loop early when the draft is
 * already satisfactory (e.g. contains the expected format, passes a regex).
 */
export class ReflectRefineRunner {
  readonly #maxCycles: number;
  readonly #qualitySignal: (draft: string) => boolean | Promise<boolean>;
  readonly #critiquePrompt: string;
  readonly #refinePrompt: string;
  readonly #outputGuardrails: OutputGuardrail[];

  constructor(opts: ReflectRefineOptions = {}) {
    this.#maxCycles = Math.max(1, opts.maxCycles ?? 1);
    this.#outputGuardrails = opts.outputGuardrails ?? [];
    if (this.#outputGuardrails.length > 0) {
      // C1: output guardrails take priority — draft passes when NO tripwire fires.
      this.#qualitySignal = async (draft: string) => {
        const tripwire = await runOutputGuardrails(this.#outputGuardrails, draft);
        return tripwire === null; // null = all passed = draft is good
      };
    } else {
      this.#qualitySignal = opts.qualitySignal ?? (() => false);
    }
    this.#critiquePrompt = opts.critiquePrompt ?? DEFAULT_CRITIQUE_PROMPT;
    this.#refinePrompt = opts.refinePrompt ?? DEFAULT_REFINE_PROMPT;
  }

  /**
   * Generate an initial answer, then iteratively critique and refine it.
   *
   * @param model      The model used for all phases.
   * @param messages   The assembled context (task + history). Not mutated.
   * @param generateOpts  Options forwarded to every generate() call.
   */
  async run(
    model: Model,
    messages: ModelMessage[],
    generateOpts: GenerateOptions = {}
  ): Promise<ReflectRefineResult> {
    const opts = { ...generateOpts, stream: true };

    // Phase 0: generate initial draft.
    let draft = await collectText(model, messages, opts);
    let cyclesUsed = 0;

    for (let cycle = 0; cycle < this.#maxCycles; cycle++) {
      // Check quality signal — stop early if draft is good enough.
      if (await this.#qualitySignal(draft)) break;

      // Phase 1: critique — isolated context, does not mutate `messages`.
      const critiqueCtx: ModelMessage[] = [
        ...messages,
        { role: "assistant", content: draft },
        { role: "user", content: this.#critiquePrompt },
      ];
      const critique = await collectText(model, critiqueCtx, opts);

      // Phase 2: refine — incorporate critique into context.
      const refineCtx: ModelMessage[] = [
        ...critiqueCtx,
        { role: "assistant", content: critique },
        { role: "user", content: this.#refinePrompt },
      ];
      draft = await collectText(model, refineCtx, opts);
      cyclesUsed++;
    }

    return { answer: draft, cyclesUsed };
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
