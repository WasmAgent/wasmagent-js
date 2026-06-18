import type { Embedder, Retriever, SearchResult } from "@wasmagent/core";

export interface QdrantStoreOpts {
  /** Qdrant base URL, e.g. "http://localhost:6333" or a cloud URL. */
  url: string;
  /** Optional API key (Qdrant Cloud requires it). */
  apiKey?: string;
  /** Collection name. */
  collection: string;
  /** Embedder used to vectorize text. */
  embedder: Embedder;
}

interface QdrantUpsertBody {
  points: Array<{
    id: string;
    vector: number[];
    payload?: Record<string, unknown>;
  }>;
}

interface QdrantSearchResponseItem {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

interface QdrantSearchResponse {
  result?: QdrantSearchResponseItem[];
}

/**
 * Qdrant-backed vector store. Implements the agentkit `Retriever`
 * interface. Works with both self-hosted Qdrant and Qdrant Cloud.
 *
 * Storage: text is stored in payload under "__text". Metadata fields
 * are stored as-is in the payload.
 */
export class QdrantStore implements Retriever {
  readonly #opts: QdrantStoreOpts;

  constructor(opts: QdrantStoreOpts) {
    this.#opts = opts;
  }

  async add(id: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    const vector = await this.#opts.embedder.embed(text);
    const body: QdrantUpsertBody = {
      points: [
        {
          id,
          vector,
          payload: { ...(metadata ?? {}), __text: text },
        },
      ],
    };
    const resp = await fetch(
      `${this.#opts.url}/collections/${this.#opts.collection}/points?wait=true`,
      {
        method: "PUT",
        headers: this.#headers(),
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) {
      throw new Error(`QdrantStore.add: HTTP ${resp.status} ${await resp.text().catch(() => "")}`);
    }
  }

  async search(query: string, topK = 5): Promise<SearchResult[]> {
    const vector = await this.#opts.embedder.embed(query);
    const body = {
      vector,
      limit: topK,
      with_payload: true,
    };
    const resp = await fetch(
      `${this.#opts.url}/collections/${this.#opts.collection}/points/search`,
      {
        method: "POST",
        headers: this.#headers(),
        body: JSON.stringify(body),
      }
    );
    if (!resp.ok) {
      throw new Error(
        `QdrantStore.search: HTTP ${resp.status} ${await resp.text().catch(() => "")}`
      );
    }
    const data = (await resp.json()) as QdrantSearchResponse;
    return (data.result ?? []).map((m) => {
      const payload = m.payload ?? {};
      const text = (payload.__text as string | undefined) ?? "";
      const cleanMeta = Object.fromEntries(Object.entries(payload).filter(([k]) => k !== "__text"));
      const result: SearchResult = { id: String(m.id), text, score: m.score };
      if (Object.keys(cleanMeta).length > 0) result.metadata = cleanMeta;
      return result;
    });
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.#opts.apiKey) headers["api-key"] = this.#opts.apiKey;
    return headers;
  }
}

/** Convenience factory matching the M2 plan's signature. */
export function qdrantStore(opts: QdrantStoreOpts): QdrantStore {
  return new QdrantStore(opts);
}
