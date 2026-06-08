import type { GenerateOptions, Model, ModelMessage } from "../models/types.js";

export interface ParallelForkJoinOptions {
  /** Number of parallel branches to run (default 3). */
  branches?: number;
  /** Max concurrent branch generate() calls (default: branches). */
  concurrency?: number;
  /**
   * Per-branch context modifier. Receives the branch index (0..branches-1) and
   * the original messages, returns the messages array for that branch.
   * Default: identity — all branches receive the same context.
   */
  branchPrompt?: (index: number, baseMessages: ModelMessage[]) => ModelMessage[];
  /**
   * Aggregation strategy after all branches complete (default "summary").
   *
   * - "summary"  — one additional model call summarises all branch answers.
   * - "first"    — return the first completed branch answer (fastest).
   * - fn         — user-supplied synchronous aggregator over branch answer strings.
   */
  aggregation?: "summary" | "first" | ((results: string[]) => string);
  /** Max tokens for the summary aggregation call (default 1024). */
  aggregationMaxTokens?: number;
}

export interface ParallelForkJoinResult {
  /** Final aggregated answer. */
  answer: string;
  /** Individual answers from each completed branch (useful for inspection). */
  branches: string[];
  /** Number of branches that completed successfully. */
  branchesCompleted: number;
}

const DEFAULT_SUMMARY_PROMPT =
  "You have received multiple independent answers to the same question. " +
  "Synthesise them into a single, comprehensive final answer. " +
  "Resolve any contradictions by choosing the most well-supported position. " +
  "Respond with the synthesised answer only — no preamble.";

/**
 * Parallel Fork-Join runner (L4).
 *
 * Forks the current context into N independent branches, runs them
 * concurrently (up to a concurrency cap), then joins via a configurable
 * aggregation strategy.
 *
 * Difference from SelfConsistencyRunner:
 *  - SelfConsistency: N identical copies → majority vote (redundancy, accuracy).
 *  - ParallelForkJoin: N optionally-differentiated branches → synthesis join
 *    (diversity, coverage). branchPrompt lets each branch explore a different
 *    angle (e.g. "analyse from a risk perspective" vs "analyse from an
 *    opportunity perspective") before a final synthesis call joins them.
 *
 * All branches share the same immutable prefix — the original messages[] is
 * never mutated; each fork gets an independent copy.
 */
export class ParallelForkJoinRunner {
  readonly #branches: number;
  readonly #concurrency: number;
  readonly #branchPrompt: (idx: number, msgs: ModelMessage[]) => ModelMessage[];
  readonly #aggregation: "summary" | "first" | ((results: string[]) => string);
  readonly #aggregationMaxTokens: number;

  constructor(opts: ParallelForkJoinOptions = {}) {
    this.#branches = Math.max(1, opts.branches ?? 3);
    this.#concurrency = Math.max(1, opts.concurrency ?? this.#branches);
    this.#branchPrompt = opts.branchPrompt ?? ((_i, msgs) => msgs);
    this.#aggregation = opts.aggregation ?? "summary";
    this.#aggregationMaxTokens = opts.aggregationMaxTokens ?? 1024;
  }

  /**
   * Fork the context into N branches, run in parallel, join results.
   *
   * @param model       The model used for all branch and aggregation calls.
   * @param messages    The assembled context (task + history). Not mutated.
   * @param generateOpts  Options forwarded to every branch generate() call.
   */
  async run(
    model: Model,
    messages: ModelMessage[],
    generateOpts: GenerateOptions = {}
  ): Promise<ParallelForkJoinResult> {
    const n = this.#branches;
    const limit = Math.min(this.#concurrency, n);
    const opts = { ...generateOpts, stream: true };

    // "first" mode: race all branches, return winner immediately.
    if (this.#aggregation === "first") {
      const branchCtxs = Array.from({ length: n }, (_, i) => this.#branchPrompt(i, messages));
      const answer = await Promise.race(branchCtxs.map((ctx) => collectText(model, ctx, opts)));
      return { answer, branches: [answer], branchesCompleted: 1 };
    }

    // Standard mode: run all branches, collect results, then aggregate.
    const completed: string[] = [];

    // Round-robin concurrency: worker i handles branch indices i, i+limit, i+2*limit, …
    const workerFn = async (startIdx: number): Promise<void> => {
      for (let idx = startIdx; idx < n; idx += limit) {
        const branchCtx = this.#branchPrompt(idx, messages);
        try {
          const answer = await collectText(model, branchCtx, opts);
          completed.push(answer);
        } catch {
          // A failing branch is dropped — other branches continue.
        }
      }
    };

    await Promise.all(Array.from({ length: limit }, (_, i) => workerFn(i)));

    if (completed.length === 0) {
      return { answer: "", branches: [], branchesCompleted: 0 };
    }

    if (completed.length === 1) {
      return { answer: completed[0]!, branches: completed, branchesCompleted: 1 };
    }

    const finalAnswer = await this.#joinResults(model, messages, completed);
    return { answer: finalAnswer, branches: completed, branchesCompleted: completed.length };
  }

  async #joinResults(
    model: Model,
    originalMessages: ModelMessage[],
    branchAnswers: string[]
  ): Promise<string> {
    if (typeof this.#aggregation === "function") {
      return this.#aggregation(branchAnswers);
    }

    // "summary": build a synthesis context and call the model once.
    const branchList = branchAnswers.map((a, i) => `Answer ${i + 1}:\n${a}`).join("\n\n---\n\n");

    const summaryCtx: ModelMessage[] = [
      ...originalMessages,
      {
        role: "user",
        content: `${branchList}\n\n---\n\n${DEFAULT_SUMMARY_PROMPT}`,
      },
    ];

    return collectText(model, summaryCtx, {
      stream: true,
      maxTokens: this.#aggregationMaxTokens,
    });
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
