import type { ToolDefinition } from "@wasmagent/core";
import { z } from "zod";
import { LruCache } from "./lruCache.js";
import type { SearchResult, WebSearchToolOpts } from "./types.js";

export interface TavilySearchOpts extends WebSearchToolOpts {
  /** Search depth. Tavily-specific. Default: "basic". */
  searchDepth?: "basic" | "advanced";
  /** Whether to include short content snippets. */
  includeAnswer?: boolean;
}

interface TavilyApiResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  published_date?: string;
}

interface TavilyApiResponse {
  results?: TavilyApiResult[];
  answer?: string;
}

const inputSchema = z.object({
  query: z.string().min(1).describe("The search query."),
});

/**
 * Build a Tavily web-search tool.
 *
 * @see https://tavily.com/
 */
export function tavilySearchTool(
  opts: TavilySearchOpts
): ToolDefinition<{ query: string }, SearchResult[]> {
  const cache = new LruCache<string, SearchResult[]>(64);
  const ttl = opts.cacheTtlMs ?? 5 * 60_000;

  return {
    name: "tavily_search",
    description:
      "Search the web via Tavily. Returns up to N ranked results with title, url, snippet, score, publishedAt.",
    inputSchema,
    outputSchema: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
        score: z.number().optional(),
        publishedAt: z.string().optional(),
      })
    ) as unknown as z.ZodType<SearchResult[]>,
    readOnly: true,
    idempotent: true,
    forward: async ({ query }) => {
      const cached = ttl > 0 ? cache.get(query) : undefined;
      if (cached) return cached;

      const resp = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: opts.apiKey,
          query,
          search_depth: opts.searchDepth ?? "basic",
          max_results: opts.maxResults ?? 5,
          include_answer: opts.includeAnswer ?? false,
        }),
      });

      if (!resp.ok) {
        throw new Error(`tavily_search: HTTP ${resp.status} ${await resp.text().catch(() => "")}`);
      }

      const data = (await resp.json()) as TavilyApiResponse;
      const results: SearchResult[] = (data.results ?? []).map((r) => {
        const item: SearchResult = {
          title: r.title,
          url: r.url,
          snippet: r.content,
        };
        if (r.score !== undefined) item.score = r.score;
        if (r.published_date) item.publishedAt = r.published_date;
        return item;
      });

      if (ttl > 0) cache.set(query, results, ttl);
      return results;
    },
  };
}
