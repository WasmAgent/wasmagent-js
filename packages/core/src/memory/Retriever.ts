/**
 * Minimal RAG / working memory primitives.
 *
 * - Retriever interface: embed + search
 * - InMemoryVectorStore: cosine-similarity based, no external deps
 * - RetrievalTool: wraps a Retriever as a readOnly, idempotent ToolDefinition
 *   (ready for DAG speculative pre-fetch as a readOnly node)
 */

import { z } from "zod";
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

// ── InMemoryVectorStore ───────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
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

export class InMemoryVectorStore implements Retriever {
  readonly #entries: EmbedResult[] = [];
  readonly #vocab = new Map<string, number>();

  async add(id: string, text: string, metadata?: Record<string, unknown>): Promise<void> {
    // Update vocab with new tokens.
    const tokens = text.toLowerCase().match(/\b\w+\b/g) ?? [];
    for (const tok of tokens) {
      if (!this.#vocab.has(tok)) {
        this.#vocab.set(tok, this.#vocab.size);
      }
    }
    // Re-embed all existing entries with updated vocab.
    for (const entry of this.#entries) {
      entry.vector = tfidfEmbed(entry.text, this.#vocab);
    }
    this.#entries.push({
      id,
      text,
      vector: tfidfEmbed(text, this.#vocab),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  async search(query: string, topK = 3): Promise<SearchResult[]> {
    if (this.#entries.length === 0) return [];
    const qVec = tfidfEmbed(query, this.#vocab);
    const scored: SearchResult[] = this.#entries.map((e) => ({
      id: e.id,
      text: e.text,
      score: cosineSimilarity(qVec, e.vector),
      ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  get size(): number { return this.#entries.length; }
}

// ── RetrievalTool ─────────────────────────────────────────────────────────────

/**
 * Wraps a Retriever as a readOnly, idempotent ToolDefinition.
 * The DAG scheduler will launch this speculatively alongside write nodes.
 */
export function makeRetrievalTool(
  retriever: Retriever,
  opts: { name?: string; description?: string; defaultTopK?: number } = {}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): ToolDefinition<any, any> {
  return {
    name: opts.name ?? "retrieve",
    description: opts.description ?? "Search the knowledge base for relevant documents given a query.",
    inputSchema: z.object({
      query: z.string().describe("The search query"),
      topK: z.number().int().positive().optional().describe("Number of results to return (default 3)"),
    }),
    outputSchema: z.object({
      results: z.array(z.object({
        id: z.string(),
        text: z.string(),
        score: z.number(),
        metadata: z.record(z.unknown()).optional(),
      })),
    }),
    readOnly: true,
    idempotent: true,
    async forward(input) {
      const results = await retriever.search(input.query, input.topK ?? opts.defaultTopK ?? 3);
      return { results };
    },
  };
}
