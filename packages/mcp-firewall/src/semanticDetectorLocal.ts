import type {
  SemanticDetectionResult,
  SemanticDetector,
  SemanticDetectorOptions,
} from "./semanticDetector.js";
import { DEFAULT_MALICIOUS_CORPUS } from "./semanticDetector.js";

/**
 * TfidfSemanticDetector --- lightweight in-process semantic detector
 * using TF-IDF vectorization + cosine similarity.
 *
 * This is a zero-dependency fallback that ships with the package.
 * For better accuracy, use an embedding-based detector with fastembed
 * or @xenova/transformers (see docs/semantic-defense.md).
 *
 * Accuracy trade-off: TF-IDF catches lexically similar paraphrases
 * but misses deep semantic rewrites. For production use with
 * sophisticated attackers, prefer an embedding model.
 */
export class TfidfSemanticDetector implements SemanticDetector {
  readonly #corpus: Array<{
    text: string;
    category: string;
    tfidf: Map<string, number>;
  }>;
  readonly #blockThreshold: number;
  readonly #warnThreshold: number;
  readonly #idf: Map<string, number>;

  constructor(
    opts?: SemanticDetectorOptions & {
      corpus?: Array<{ text: string; category: string }>;
    }
  ) {
    const corpus = opts?.corpus ?? DEFAULT_MALICIOUS_CORPUS;
    this.#blockThreshold = opts?.blockThreshold ?? 0.9;
    this.#warnThreshold = opts?.warnThreshold ?? 0.82;

    // Build IDF from corpus
    this.#idf = new Map();
    const N = corpus.length;
    const docFreq = new Map<string, number>();
    for (const entry of corpus) {
      const tokens = new Set(this.#tokenize(entry.text));
      for (const t of tokens) {
        docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
      }
    }
    for (const [term, df] of docFreq) {
      this.#idf.set(term, Math.log((N + 1) / (df + 1)) + 1);
    }

    // Pre-compute TF-IDF vectors for corpus
    this.#corpus = corpus.map((entry) => ({
      ...entry,
      tfidf: this.#computeTfidf(entry.text),
    }));
  }

  /** Similarity threshold for 'high' severity finding. */
  get blockThreshold(): number {
    return this.#blockThreshold;
  }

  /** Similarity threshold for 'medium' severity finding. */
  get warnThreshold(): number {
    return this.#warnThreshold;
  }

  async detect(text: string): Promise<SemanticDetectionResult> {
    const inputVec = this.#computeTfidf(text);
    let maxScore = 0;
    let matchedCategory: string | undefined;
    let matchedEntry: string | undefined;

    for (const entry of this.#corpus) {
      const sim = this.#cosineSimilarity(inputVec, entry.tfidf);
      if (sim > maxScore) {
        maxScore = sim;
        matchedCategory = entry.category;
        matchedEntry = entry.text;
      }
    }

    const aboveThreshold = maxScore >= this.#warnThreshold;
    if (aboveThreshold && matchedCategory !== undefined && matchedEntry !== undefined) {
      return { score: maxScore, matchedCategory, matchedEntry };
    }
    return { score: maxScore };
  }

  #tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  #computeTfidf(text: string): Map<string, number> {
    const tokens = this.#tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    const vec = new Map<string, number>();
    const corpusSize = this.#corpus?.length ?? 1;
    for (const [term, count] of tf) {
      const idf = this.#idf.get(term) ?? Math.log(corpusSize + 1);
      vec.set(term, (count / tokens.length) * idf);
    }
    return vec;
  }

  #cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (const [term, val] of a) {
      normA += val * val;
      const bVal = b.get(term);
      if (bVal !== undefined) dot += val * bVal;
    }
    for (const [, val] of b) normB += val * val;
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
