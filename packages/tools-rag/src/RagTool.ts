import type { Retriever, SearchResult, ToolDefinition } from "@wasmagent/core";
import { z } from "zod";

export interface RagToolOpts {
  /** Vector store backing the retrieval. */
  store: Retriever;
  /** Default topK for queries. */
  topK?: number;
  /** Override the tool name (default "retrieve"). Useful when you need
   *  multiple RAG tools in one agent (e.g. "retrieve_docs", "retrieve_code"). */
  name?: string;
  /** Override the tool description shown to the agent. */
  description?: string;
  /** Optional minimum score filter — chunks below this are dropped. */
  minScore?: number;
}

/**
 * Build a RAG retrieval tool — agent → query string → ranked chunks.
 *
 * Wraps any agentkit `Retriever` (InMemoryVectorStore, KvBackendVectorStore,
 * PineconeStore, QdrantStore, or any custom impl) into a tool an agent
 * can call.
 *
 * Hardcodes `readOnly + idempotent: true`, so the DAG scheduler can run
 * multiple retrieval calls in parallel.
 */
export function ragTool(
  opts: RagToolOpts
): ToolDefinition<{ query: string; topK?: number }, SearchResult[]> {
  const inputSchema = z.object({
    query: z.string().min(1).describe("Natural-language query to retrieve relevant chunks for."),
    // .min(1) — not .positive() — to avoid `exclusiveMinimum: true` which
    // Anthropic's draft 2020-12 schema validator rejects as invalid.
    topK: z.number().int().min(1).max(50).optional().describe("Number of results to return."),
  }) as unknown as z.ZodType<{ query: string; topK?: number }>;

  return {
    name: opts.name ?? "retrieve",
    description:
      opts.description ??
      "Retrieve the most relevant chunks of stored knowledge for a query. Returns text + score + metadata.",
    inputSchema,
    outputSchema: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        score: z.number(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
    ) as unknown as z.ZodType<SearchResult[]>,
    readOnly: true,
    idempotent: true,
    forward: async ({ query, topK }) => {
      const k = topK ?? opts.topK ?? 5;
      const results = await opts.store.search(query, k);
      const minScore = opts.minScore ?? Number.NEGATIVE_INFINITY;
      return results.filter((r) => r.score >= minScore);
    },
  };
}
