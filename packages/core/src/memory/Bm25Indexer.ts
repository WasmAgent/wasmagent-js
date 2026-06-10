/**
 * BM25 sparse retrieval — Okapi BM25 implementation in pure TypeScript.
 *
 * Used standalone for keyword-leaning retrieval, or fused with dense
 * embeddings via {@link HybridRetriever} for the best of both worlds.
 */

const DEFAULT_K1 = 1.5;
const DEFAULT_B = 0.75;

interface IndexedDoc {
  id: string;
  text: string;
  /** Term-frequency map for this doc. */
  tf: Map<string, number>;
  /** Total tokens in this doc. */
  length: number;
  metadata?: Record<string, unknown>;
}

export interface Bm25Match {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * Tokenize a string for BM25 indexing.
 * - lowercases
 * - splits on whitespace + punctuation
 * - keeps CJK characters as individual tokens
 */
export function tokenize(text: string): string[] {
  const lowered = text.toLowerCase();
  const tokens: string[] = [];
  // Match: ASCII word, OR Chinese/Japanese/Korean character
  const re = /[a-z0-9_]+|[぀-ヿ㐀-䶿一-鿿가-힯]/g;
  let m: RegExpExecArray | null = re.exec(lowered);
  while (m !== null) {
    tokens.push(m[0]);
    m = re.exec(lowered);
  }
  return tokens;
}

/** Okapi BM25 indexer + scorer. Pure in-memory; no external deps. */
export class Bm25Indexer {
  readonly #k1: number;
  readonly #b: number;
  readonly #docs = new Map<string, IndexedDoc>();
  /** doc count containing each term — used for IDF. */
  readonly #df = new Map<string, number>();
  /** average doc length, recomputed lazily. */
  #avgLen = 0;
  #avgLenDirty = true;

  constructor(opts: { k1?: number; b?: number } = {}) {
    this.#k1 = opts.k1 ?? DEFAULT_K1;
    this.#b = opts.b ?? DEFAULT_B;
  }

  /** Index (or re-index) a document. */
  index(id: string, text: string, metadata?: Record<string, unknown>): void {
    // If re-indexing, decrement old DF first.
    const existing = this.#docs.get(id);
    if (existing) {
      for (const t of existing.tf.keys()) {
        const v = (this.#df.get(t) ?? 1) - 1;
        if (v <= 0) this.#df.delete(t);
        else this.#df.set(t, v);
      }
    }

    const tokens = tokenize(text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    for (const t of tf.keys()) this.#df.set(t, (this.#df.get(t) ?? 0) + 1);

    const doc: IndexedDoc = {
      id,
      text,
      tf,
      length: tokens.length,
      ...(metadata !== undefined && { metadata }),
    };
    this.#docs.set(id, doc);
    this.#avgLenDirty = true;
  }

  /** Remove a document from the index. */
  remove(id: string): boolean {
    const doc = this.#docs.get(id);
    if (!doc) return false;
    for (const t of doc.tf.keys()) {
      const v = (this.#df.get(t) ?? 1) - 1;
      if (v <= 0) this.#df.delete(t);
      else this.#df.set(t, v);
    }
    this.#docs.delete(id);
    this.#avgLenDirty = true;
    return true;
  }

  size(): number {
    return this.#docs.size;
  }

  #avgLength(): number {
    if (!this.#avgLenDirty) return this.#avgLen;
    let total = 0;
    for (const d of this.#docs.values()) total += d.length;
    this.#avgLen = this.#docs.size === 0 ? 0 : total / this.#docs.size;
    this.#avgLenDirty = false;
    return this.#avgLen;
  }

  /** Run a BM25 query and return the top-k matches. */
  search(query: string, topK = 5): Bm25Match[] {
    if (this.#docs.size === 0) return [];
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const N = this.#docs.size;
    const avgLen = this.#avgLength();
    const k1 = this.#k1;
    const b = this.#b;

    const scores: Bm25Match[] = [];
    for (const doc of this.#docs.values()) {
      let score = 0;
      for (const term of queryTokens) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const df = this.#df.get(term) ?? 0;
        // Lucene-style IDF: ln(1 + (N - df + 0.5) / (df + 0.5))
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        const norm = 1 - b + b * (doc.length / Math.max(1, avgLen));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * norm));
      }
      if (score > 0) {
        const match: Bm25Match = { id: doc.id, text: doc.text, score };
        if (doc.metadata !== undefined) match.metadata = doc.metadata;
        scores.push(match);
      }
    }
    scores.sort((a, b2) => b2.score - a.score);
    return scores.slice(0, topK);
  }
}
