/**
 * RelevanceScorer — measures semantic similarity between the agent's
 * final answer and the expected answer using cosine similarity over
 * embeddings.
 *
 * Unlike exactMatch, this scorer accepts paraphrases and rewordings as
 * long as the core meaning is preserved.
 *
 * Like FaithfulnessScorer, the sync `score()` returns a sentinel —
 * call `relevanceScorerAsync()` from your eval runner for real scoring.
 */

import type { Embedder } from "../memory/Retriever.js";
import type { AgentTrace, EvalSample, Scorer, ScorerResult } from "./index.js";

export interface RelevanceOpts {
  embedder: Embedder;
  /** Optional list of expected answers if not on the sample. */
  expectedAnswers?: string[];
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Synchronous sentinel — use {@link relevanceScorerAsync} for real scoring. */
export function relevanceScorer(_opts: RelevanceOpts): Scorer {
  return {
    name: "relevance",
    score(): ScorerResult {
      return {
        scorer: "relevance",
        score: 0,
        detail: "Use relevanceScorerAsync() for asynchronous embedding evaluation",
      };
    },
  };
}

/** Async relevance scorer — embeds actual + expected, returns max cosine similarity. */
export async function relevanceScorerAsync(
  opts: RelevanceOpts,
  trace: AgentTrace,
  sample: EvalSample
): Promise<ScorerResult> {
  const actual = (trace.finalAnswer ?? "").trim();
  if (!actual) return { scorer: "relevance", score: 0, detail: "no final answer" };

  const expected: string[] =
    opts.expectedAnswers ?? (sample.expectedAnswer ? [sample.expectedAnswer] : []);
  if (expected.length === 0) {
    return { scorer: "relevance", score: 0, detail: "no expectedAnswer to compare to" };
  }

  const actualVec = await opts.embedder.embed(actual);
  let bestSim = 0;
  for (const e of expected) {
    const v = await opts.embedder.embed(e);
    const sim = cosineSimilarity(actualVec, v);
    if (sim > bestSim) bestSim = sim;
  }
  // Clamp to [0, 1]; cosine can be negative if vectors point in opposite
  // directions, which we treat as zero relevance.
  const score = Math.max(0, Math.min(1, bestSim));
  return { scorer: "relevance", score, detail: `bestCosine=${bestSim.toFixed(3)}` };
}
