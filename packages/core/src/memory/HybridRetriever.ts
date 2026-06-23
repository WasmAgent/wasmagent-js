import { Bm25Indexer } from "./Bm25Indexer.js";
import type { Embedder, Retriever, SearchResult } from "./Retriever.js";

/**
 * Hybrid retrieval — fuses dense (semantic) embedding scores with
 * sparse (BM25) keyword scores via weighted Reciprocal Rank Fusion +
 * normalized score blend. Generally outperforms either signal alone
 * on real-world QA datasets.
 *
 * Plug in any WasmAgent `Embedder` and an underlying `Retriever` that
 * already does dense ANN search (InMemoryVectorStore, PineconeStore,
 * QdrantStore from `@wasmagent/tools-rag`, etc.). HybridRetriever
 * maintains its own BM25 index in parallel.
 */
export interface HybridRetrieverOpts {
  /** Underlying dense retriever — typically the same one you'd use alone. */
  dense: Retriever;
  /** Weight for BM25 scores. Default: 0.4 */
  bm25Weight?: number;
  /** Weight for dense scores. Default: 0.6 */
  semanticWeight?: number;
  /** BM25 hyper-parameters. */
  k1?: number;
  b?: number;
}

export class HybridRetriever implements Retriever {
  readonly #bm25: Bm25Indexer;
  readonly #dense: Retriever;
  readonly #bm25Weight: number;
  readonly #semanticWeight: number;

  constructor(opts: HybridRetrieverOpts) {
    const k1Opts: { k1?: number; b?: number } = {};
    if (opts.k1 !== undefined) k1Opts.k1 = opts.k1;
    if (opts.b !== undefined) k1Opts.b = opts.b;
    this.#bm25 = new Bm25Indexer(k1Opts);
    this.#dense = opts.dense;
    this.#bm25Weight = opts.bm25Weight ?? 0.4;
    this.#semanticWeight = opts.semanticWeight ?? 0.6;
  }

  async add(id: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    this.#bm25.index(id, text, metadata);
    await this.#dense.add(id, text, metadata);
  }

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    // Pull oversized candidate lists from each side — fusion picks the
    // top-k from the merged set so we don't lose good results that
    // ranked near the edge of either signal.
    const k = Math.max(topK * 4, 20);
    const [denseResults, bm25Results] = await Promise.all([
      this.#dense.search(query, k),
      Promise.resolve(this.#bm25.search(query, k)),
    ]);

    // Normalize each side to [0, 1]
    const normalize = (arr: Array<{ score: number }>): Map<string, number> => {
      if (arr.length === 0) return new Map();
      const max = Math.max(...arr.map((x) => x.score));
      const min = Math.min(...arr.map((x) => x.score));
      const range = max - min || 1;
      const m = new Map<string, number>();
      for (const it of arr as Array<{ id: string; score: number }>) {
        m.set(it.id, (it.score - min) / range);
      }
      return m;
    };

    const denseN = normalize(denseResults);
    const bm25N = normalize(bm25Results);

    // Build a unified candidate map.
    const candidates = new Map<string, SearchResult>();
    for (const r of denseResults) candidates.set(r.id, r);
    for (const r of bm25Results) {
      if (!candidates.has(r.id)) {
        const sr: SearchResult = { id: r.id, text: r.text, score: 0 };
        if (r.metadata !== undefined) sr.metadata = r.metadata;
        candidates.set(r.id, sr);
      }
    }

    const fused: SearchResult[] = [];
    for (const [id, r] of candidates.entries()) {
      const dScore = denseN.get(id) ?? 0;
      const bScore = bm25N.get(id) ?? 0;
      const fusedScore = this.#semanticWeight * dScore + this.#bm25Weight * bScore;
      fused.push({ ...r, score: fusedScore });
    }
    fused.sort((a, b) => b.score - a.score);
    return fused.slice(0, topK);
  }
}

/**
 * Convenience: construct a HybridRetriever from an explicit BM25 index
 * + dense retriever. Use when you want fine-grained control of the BM25
 * lifecycle (e.g. pre-warmed from on-disk corpus). For most cases, just
 * `new HybridRetriever({ dense })` is enough.
 */
export function hybridRetriever(opts: HybridRetrieverOpts): HybridRetriever {
  return new HybridRetriever(opts);
}

// Re-export so consumers don't need a second import.
export type { Embedder };
