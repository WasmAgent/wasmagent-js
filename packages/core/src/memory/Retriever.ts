/**
 * Minimal RAG / working memory primitives.
 *
 * - Embedder interface: pluggable embedding backend (default: zero-dep TF-IDF)
 * - Retriever interface: add + search
 * - InMemoryVectorStore: cosine-similarity, no external deps (default TF-IDF embedder)
 * - KvBackendVectorStore: persists vectors to any KvBackend (checkpoint or memory store)
 * - makeRetrievalTool: wraps a Retriever as a readOnly, idempotent ToolDefinition;
 *   results are marked untrusted to prevent RAG poisoning (arXiv:2604.00387 RAGShield 2026).
 */

import { z } from "zod";
import type { KvBackend } from "../checkpoint/index.js";
import type { ToolDefinition } from "../tools/types.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmbedResult {
  id: string;
  text: string;
  vector: number[];
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  id: string;
  text: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface Retriever {
  /** Embed a text and add it to the store. Returns the stored entry id. */
  add(id: string, text: string, metadata?: Record<string, unknown>): Promise<void>;
  /** Search for the top-k nearest entries to a query text. */
  search(query: string, topK?: number): Promise<SearchResult[]>;
}

/**
 * D3: Pluggable embedding backend.
 *
 * - Default: TfidfEmbedder (zero external deps, good for prototypes)
 * - Production: use ModelEmbedder with any agentkit Model adapter
 */
export interface Embedder {
  /** Embed a text into a dense vector. */
  embed(text: string): Promise<number[]>;
}

// ── TF-IDF (default, zero deps) ───────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    normA += (a[i] ?? 0) ** 2;
    normB += (b[i] ?? 0) ** 2;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** Lightweight bag-of-words TF embedding — no external deps. */
function tfidfEmbed(text: string, vocab: Map<string, number>): number[] {
  const tokens = text.toLowerCase().match(/\b\w+\b/g) ?? [];
  const vec = new Array<number>(vocab.size).fill(0);
  for (const tok of tokens) {
    const idx = vocab.get(tok);
    if (idx !== undefined) vec[idx] = (vec[idx] ?? 0) + 1;
  }
  return vec;
}

/**
 * Default embedder: sparse bag-of-words TF-IDF.
 * Maintains a shared vocabulary — must be passed the same instance as the vector store
 * to stay in sync. Suitable for in-memory stores; not appropriate for cross-session KV use.
 */
export class TfidfEmbedder implements Embedder {
  readonly #vocab: Map<string, number>;

  constructor(vocab: Map<string, number>) {
    this.#vocab = vocab;
  }

  updateVocab(text: string): void {
    const tokens = text.toLowerCase().match(/\b\w+\b/g) ?? [];
    for (const tok of tokens) {
      if (!this.#vocab.has(tok)) this.#vocab.set(tok, this.#vocab.size);
    }
  }

  async embed(text: string): Promise<number[]> {
    return tfidfEmbed(text, this.#vocab);
  }
}

// ── InMemoryVectorStore ───────────────────────────────────────────────────────

export class InMemoryVectorStore implements Retriever {
  readonly #entries: EmbedResult[] = [];
  readonly #vocab = new Map<string, number>();
  readonly #embedder: Embedder;

  /**
   * @param embedder Custom embedder. Defaults to TF-IDF with a shared internal vocab.
   *   When using an external embedder (ModelEmbedder), the vocab is not used for queries —
   *   the embedder is called directly for both adds and queries.
   */
  constructor(embedder?: Embedder) {
    this.#embedder = embedder ?? new TfidfEmbedder(this.#vocab);
  }

  async add(id: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    if (this.#embedder instanceof TfidfEmbedder) {
      this.#embedder.updateVocab(text);
      // Re-embed all existing entries with updated vocab for TF-IDF consistency.
      for (const entry of this.#entries) {
        entry.vector = tfidfEmbed(entry.text, this.#vocab);
      }
    }
    this.#entries.push({
      id,
      text,
      vector: await this.#embedder.embed(text),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  async search(query: string, topK = 3): Promise<SearchResult[]> {
    if (this.#entries.length === 0) return [];
    if (this.#embedder instanceof TfidfEmbedder) {
      this.#embedder.updateVocab(query);
    }
    const qVec = await this.#embedder.embed(query);
    const scored: SearchResult[] = this.#entries.map((e) => ({
      id: e.id,
      text: e.text,
      score: cosineSimilarity(qVec, e.vector),
      ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  get size(): number {
    return this.#entries.length;
  }
}

// ── KvBackendVectorStore ──────────────────────────────────────────────────────

/**
 * D3: Persistent vector store backed by any KvBackend (checkpoint store, Redis, etc.).
 *
 * Vectors and metadata are stored as JSON under a key prefix. The store loads lazily
 * on first access and can persist across sessions.
 *
 * Requires an external embedder (ModelEmbedder or any Embedder) since TF-IDF vocabulary
 * cannot be reliably persisted and restored across sessions.
 */
export class KvBackendVectorStore implements Retriever {
  readonly #kv: KvBackend;
  readonly #prefix: string;
  readonly #embedder: Embedder;
  #index: Map<string, EmbedResult> | null = null;

  constructor(kv: KvBackend, embedder: Embedder, prefix = "rag:") {
    this.#kv = kv;
    this.#embedder = embedder;
    this.#prefix = prefix;
  }

  async #loadIndex(): Promise<Map<string, EmbedResult>> {
    if (this.#index !== null) return this.#index;
    const raw = await this.#kv.get(`${this.#prefix}__index__`);
    if (!raw) {
      this.#index = new Map();
    } else {
      const entries = JSON.parse(raw) as EmbedResult[];
      this.#index = new Map(entries.map((e) => [e.id, e]));
    }
    return this.#index;
  }

  async #saveIndex(): Promise<void> {
    const idx = await this.#loadIndex();
    await this.#kv.put(`${this.#prefix}__index__`, JSON.stringify([...idx.values()]));
  }

  async add(id: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    const idx = await this.#loadIndex();
    const vector = await this.#embedder.embed(text);
    idx.set(id, { id, text, vector, ...(metadata !== undefined ? { metadata } : {}) });
    await this.#saveIndex();
  }

  async search(query: string, topK = 3): Promise<SearchResult[]> {
    const idx = await this.#loadIndex();
    if (idx.size === 0) return [];
    const qVec = await this.#embedder.embed(query);
    const scored: SearchResult[] = [...idx.values()].map((e) => ({
      id: e.id,
      text: e.text,
      score: cosineSimilarity(qVec, e.vector),
      ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }
}

// ── RetrievalTool ─────────────────────────────────────────────────────────────

/**
 * Wraps a Retriever as a readOnly, idempotent ToolDefinition.
 * The DAG scheduler will launch this speculatively alongside write nodes.
 *
 * D3: Results are marked trust:"untrusted" — retrieval content is external data
 * that may have been poisoned (RAGShield 2026). MessageAssembler wraps untrusted
 * outputs in <untrusted_tool_output> delimiters to prevent injection.
 */
export function makeRetrievalTool(
  retriever: Retriever,
  opts: { name?: string; description?: string; defaultTopK?: number } = {}
  // biome-ignore lint/suspicious/noExplicitAny: intentional
): ToolDefinition<any, any> {
  return {
    name: opts.name ?? "retrieve",
    description:
      opts.description ?? "Search the knowledge base for relevant documents given a query.",
    inputSchema: z.object({
      query: z.string().describe("The search query"),
      // Use .min(1) instead of .positive(): zod-to-json-schema's openApi3
      // target emits draft-04-style `exclusiveMinimum: true` for .positive(),
      // which Anthropic's draft 2020-12 validator rejects with 400
      // "tools.N.custom.input_schema: JSON schema is invalid".
      topK: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Number of results to return (default 3)"),
    }),
    outputSchema: z.object({
      results: z.array(
        z.object({
          id: z.string(),
          text: z.string(),
          score: z.number(),
          metadata: z.record(z.unknown()).optional(),
        })
      ),
    }),
    readOnly: true,
    idempotent: true,
    trust: "untrusted" as const,
    async forward(input) {
      const results = await retriever.search(input.query, input.topK ?? opts.defaultTopK ?? 3);
      return { results };
    },
  };
}
