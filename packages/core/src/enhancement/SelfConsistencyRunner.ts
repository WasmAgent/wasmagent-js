import type { Model, ModelMessage, GenerateOptions } from "../models/types.js";

export interface SelfConsistencyOptions {
  /** Number of candidate completions (default 3). */
  n?: number;
  /** Abort early when this fraction of candidates agree (default 0.6). */
  earlyStopThreshold?: number;
  /** Max concurrently running generate() calls (default 4). */
  concurrencyLimit?: number;
  /**
   * Optional answer extractor applied before majority voting.
   *
   * Extract a compact, comparable key from a raw candidate text. The vote is cast
   * on the extracted key, but the returned answer is always the original full text
   * of the winning candidate.
   *
   * Default: 3-tier fallback —
   *   1. `\boxed{...}` (LaTeX math answers)
   *   2. Last non-empty line
   *   3. Entire text (original behavior)
   *
   * Use this to handle structured answers (e.g. JSON fields, option letters,
   * numeric values) so that superficially different but semantically identical
   * answers cluster correctly.
   */
  extractAnswer?: (text: string) => string;
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
 *
 * C1 upgrade: voting is performed on the output of extractAnswer(), not on
 * the raw full text. This lets structured answers (boxed math, option letters,
 * last-line summaries) form a majority even when the surrounding reasoning
 * differs. The returned answer is always the original full text of the winner.
 */
export class SelfConsistencyRunner {
  readonly #n: number;
  readonly #earlyStopThreshold: number;
  readonly #concurrencyLimit: number;
  readonly #extractAnswer: (text: string) => string;

  constructor(opts: SelfConsistencyOptions = {}) {
    this.#n = Math.max(1, opts.n ?? 3);
    this.#earlyStopThreshold = opts.earlyStopThreshold ?? 0.6;
    this.#concurrencyLimit = Math.max(1, opts.concurrencyLimit ?? 4);
    this.#extractAnswer = opts.extractAnswer ?? defaultExtractAnswer;
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
    const extractAnswer = this.#extractAnswer;

    const voteCounts = new Map<string, number>();
    // Map from normalized vote key → first full raw text that produced it.
    const keyToFullText = new Map<string, string>();
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
        let rawAnswer: string;
        try {
          rawAnswer = await sampleOne();
        } catch (err) {
          shouldStop = true;
          throw err;
        }
        if (shouldStop) break;

        completed.push(rawAnswer);
        const key = normalizeAnswer(extractAnswer(rawAnswer));
        voteCounts.set(key, (voteCounts.get(key) ?? 0) + 1);
        if (!keyToFullText.has(key)) keyToFullText.set(key, rawAnswer);

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
    // Return the original full text for the winning key.
    const bestAnswer = keyToFullText.get(bestKey) ?? completed[0] ?? "";

    return { answer: bestAnswer, votes: bestCount, totalCandidates: completed.length };
  }
}

/**
 * Default answer extractor — 3-tier fallback:
 *   1. \boxed{...} LaTeX math answer
 *   2. Last non-empty line
 *   3. Entire text (original normalizeAnswer behavior)
 */
function defaultExtractAnswer(text: string): string {
  // Tier 1: LaTeX \boxed{} — common in math reasoning traces
  const boxed = /\\boxed\{([^}]*)\}/.exec(text);
  if (boxed) return boxed[1]!.trim();

  // Tier 2: last non-empty line — common in CoT where the answer is on the final line
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0) return lines[lines.length - 1]!;

  // Tier 3: full text (same as original behavior)
  return text;
}

/**
 * Normalize an answer key for vote comparison.
 * Strips whitespace, lowercases, collapses internal spaces.
 */
function normalizeAnswer(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
