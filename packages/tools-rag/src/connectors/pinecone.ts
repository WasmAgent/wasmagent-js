import type { Embedder, Retriever, SearchResult } from "@wasmagent/core";

export interface PineconeStoreOpts {
  /** Pinecone API key. */
  apiKey: string;
  /** Index host URL, e.g. "https://my-idx-1234.svc.us-east-1.pinecone.io". */
  indexHost: string;
  /** Optional namespace within the index. */
  namespace?: string;
  /** Embedder used to vectorize text on add() / search(). */
  embedder: Embedder;
}

interface PineconeVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

interface PineconeQueryResponse {
  matches?: Array<{
    id: string;
    score: number;
    metadata?: Record<string, unknown>;
  }>;
}

/**
 * Pinecone-backed vector store. Implements the agentkit `Retriever`
 * interface so it drops in anywhere `InMemoryVectorStore` /
 * `KvBackendVectorStore` is used.
 *
 * Storage format: stores text inside metadata under the `__text` key so
 * search() can return it without an extra fetch.
 */
export class PineconeStore implements Retriever {
  readonly #opts: PineconeStoreOpts;

  constructor(opts: PineconeStoreOpts) {
    this.#opts = opts;
  }

  async add(id: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    const vector = await this.#opts.embedder.embed(text);
    const v: PineconeVector = {
      id,
      values: vector,
      metadata: { ...(metadata ?? {}), __text: text },
    };
    const body = {
      vectors: [v],
      ...(this.#opts.namespace ? { namespace: this.#opts.namespace } : {}),
    };
    const resp = await fetch(`${this.#opts.indexHost}/vectors/upsert`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(
        `PineconeStore.add: HTTP ${resp.status} ${await resp.text().catch(() => "")}`
      );
    }
  }

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    const vector = await this.#opts.embedder.embed(query);
    const body = {
      vector,
      topK,
      includeMetadata: true,
      ...(this.#opts.namespace ? { namespace: this.#opts.namespace } : {}),
    };
    const resp = await fetch(`${this.#opts.indexHost}/query`, {
      method: "POST",
      headers: this.#headers(),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      throw new Error(
        `PineconeStore.search: HTTP ${resp.status} ${await resp.text().catch(() => "")}`
      );
    }
    const data = (await resp.json()) as PineconeQueryResponse;
    return (data.matches ?? []).map((m) => {
      const meta = m.metadata ?? {};
      const text = (meta.__text as string | undefined) ?? "";
      const cleanMeta = Object.fromEntries(Object.entries(meta).filter(([k]) => k !== "__text"));
      const result: SearchResult = { id: m.id, text, score: m.score };
      if (Object.keys(cleanMeta).length > 0) result.metadata = cleanMeta;
      return result;
    });
  }

  #headers(): Record<string, string> {
    return {
      "Api-Key": this.#opts.apiKey,
      "Content-Type": "application/json",
      "X-Pinecone-API-Version": "2025-01",
    };
  }
}

/** Convenience factory matching the M2 plan's signature. */
export function pineconeStore(opts: PineconeStoreOpts): PineconeStore {
  return new PineconeStore(opts);
}
