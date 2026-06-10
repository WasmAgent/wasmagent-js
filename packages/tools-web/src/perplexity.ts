import type { ToolDefinition } from "@agentkit-js/core";
import { z } from "zod";
import { LruCache } from "./lruCache.js";
import type { WebSearchToolOpts } from "./types.js";

export interface PerplexityAskOpts extends WebSearchToolOpts {
  /** Perplexity model. Default: "sonar". */
  model?: string;
}

export interface PerplexityAnswer {
  /** The synthesized answer text (with inline citations like [1], [2]). */
  answer: string;
  /** Citation URLs in the order referenced. */
  citations: string[];
}

interface PerplexityApiResponse {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
}

const inputSchema = z.object({
  query: z.string().min(1).describe("The question to answer with web search."),
});

/**
 * Build a Perplexity ask tool — answers a question with citations
 * synthesized from live web search.
 *
 * @see https://docs.perplexity.ai/
 */
export function perplexityAskTool(
  opts: PerplexityAskOpts
): ToolDefinition<{ query: string }, PerplexityAnswer> {
  const cache = new LruCache<string, PerplexityAnswer>(64);
  const ttl = opts.cacheTtlMs ?? 5 * 60_000;

  return {
    name: "perplexity_ask",
    description:
      "Ask a question and receive a synthesized answer with web citations via Perplexity.",
    inputSchema,
    outputSchema: z.object({
      answer: z.string(),
      citations: z.array(z.string()),
    }),
    readOnly: true,
    idempotent: true,
    forward: async ({ query }) => {
      const cached = ttl > 0 ? cache.get(query) : undefined;
      if (cached) return cached;

      const resp = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: opts.model ?? "sonar",
          messages: [{ role: "user", content: query }],
        }),
      });

      if (!resp.ok) {
        throw new Error(`perplexity_ask: HTTP ${resp.status} ${await resp.text().catch(() => "")}`);
      }

      const data = (await resp.json()) as PerplexityApiResponse;
      const answer = data.choices?.[0]?.message?.content ?? "";
      const citations = data.citations ?? [];
      const result: PerplexityAnswer = { answer, citations };

      if (ttl > 0) cache.set(query, result, ttl);
      return result;
    },
  };
}
