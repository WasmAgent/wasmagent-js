import type { Model, ModelMessage, GenerateOptions } from "../models/types.js";

export interface SelfConsistencyOptions {
  /** Number of candidate completions (default 3). */
  n?: number;
  /** Abort early when this fraction of candidates agree (default 0.6). */
  earlyStopThreshold?: number;
  /** Max concurrently running generate() calls (default 4). */
  concurrencyLimit?: number;
}

export interface SelfConsistencyResult {
  answer: string;
  /** How many candidates agreed on this answer. */
  votes: number;
  /** Total candidates generated before early-stop or completion. */
  totalCandidates: number;
}

/**
 * Self-consistency runner (P2).
 *
 * Generates N candidate answers in parallel with a concurrency cap, then
 * majority-votes. Stops early as soon as earlyStopThreshold fraction of
 * completed candidates agree, saving token cost on easy questions.
 *
 * Strategy mirrors Wang et al. 2022 "Self-Consistency Improves Chain of
 * Thought Reasoning" but is model-agnostic and streaming-native.
 */
export class SelfConsistencyRunner {
  readonly #n: number;
  readonly #earlyStopThreshold: number;
  readonly #concurrencyLimit: number;

  constructor(opts: SelfConsistencyOptions = {}) {
    this.#n = Math.max(1, opts.n ?? 3);
    this.#earlyStopThreshold = opts.earlyStopThreshold ?? 0.6;
    this.#concurrencyLimit = Math.max(1, opts.concurrencyLimit ?? 4);
  }

  /**
   * Run self-consistency sampling and return the majority-vote answer.
   *
   * @param model  The model to sample from.
   * @param messages  The messages to send (typically the full assembled context).
   * @param generateOpts  Extra generate options forwarded to each call.
   */
  async run(
    model: Model,
    messages: ModelMessage[],
    generateOpts: GenerateOptions = {}
  ): Promise<SelfConsistencyResult> {
    const n = this.#n;
    const threshold = this.#earlyStopThreshold;
    const limit = Math.min(this.#concurrencyLimit, n);

    const voteCounts = new Map<string, number>();
    const completed: string[] = [];
    let shouldStop = false;

    const sampleOne = async (): Promise<string> => {
      let text = "";
      for await (const ev of model.generate(messages, { ...generateOpts, stream: true })) {
        if (ev.type === "text_delta" && ev.delta) text += ev.delta;
      }
      return text.trim();
    };

    // Distribute jobs round-robin across worker slots — worker i handles indices i, i+limit, i+2*limit, …
    const workerFn = async (startIdx: number): Promise<void> => {
      for (let jobIdx = startIdx; jobIdx < n && !shouldStop; jobIdx += limit) {
        const answer = await sampleOne();
        if (shouldStop) break;

        completed.push(answer);
        const key = normalizeAnswer(answer);
        voteCounts.set(key, (voteCounts.get(key) ?? 0) + 1);

        // Check early stop: requires at least 2 completed candidates so a single
        // result can never trivially hit 100% and abort prematurely.
        if (completed.length >= 2) {
          const topCount = Math.max(...voteCounts.values());
          if (topCount / completed.length >= threshold) {
            shouldStop = true;
            break;
          }
        }
      }
    };

    // Start `limit` workers concurrently; they self-schedule via round-robin index striping.
    await Promise.all(Array.from({ length: limit }, (_, i) => workerFn(i)));

    // Pick winner from voteCounts.
    let bestKey = "";
    let bestCount = 0;
    for (const [key, count] of voteCounts) {
      if (count > bestCount) { bestCount = count; bestKey = key; }
    }
    const bestAnswer = completed.find((r) => normalizeAnswer(r) === bestKey) ?? completed[0] ?? "";

    return { answer: bestAnswer, votes: bestCount, totalCandidates: completed.length };
  }
}

/**
 * Normalize an answer for vote comparison.
 * Strips whitespace, lowercases, collapses internal spaces.
 */
function normalizeAnswer(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
