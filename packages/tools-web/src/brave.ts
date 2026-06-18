import type { ToolDefinition } from "@wasmagent/core";
import { z } from "zod";
import { LruCache } from "./lruCache.js";
import type { SearchResult, WebSearchToolOpts } from "./types.js";

export interface BraveSearchOpts extends WebSearchToolOpts {
  /** Brave SafeSearch level. */
  safeSearch?: "off" | "moderate" | "strict";
  /** ISO country code. Default: "US". */
  country?: string;
}

interface BraveApiWebResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

interface BraveApiResponse {
  web?: { results?: BraveApiWebResult[] };
}

const inputSchema = z.object({
  query: z.string().min(1).describe("The search query."),
});

/**
 * Build a Brave Search web tool.
 *
 * @see https://brave.com/search/api/
 */
export function braveSearchTool(
  opts: BraveSearchOpts
): ToolDefinition<{ query: string }, SearchResult[]> {
  const cache = new LruCache<string, SearchResult[]>(64);
  const ttl = opts.cacheTtlMs ?? 5 * 60_000;
  const maxResults = opts.maxResults ?? 5;

  return {
    name: "brave_search",
    description:
      "Search the web via Brave Search. Returns up to N ranked results with title, url, snippet.",
    inputSchema,
    outputSchema: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
        publishedAt: z.string().optional(),
      })
    ) as unknown as z.ZodType<SearchResult[]>,
    readOnly: true,
    idempotent: true,
    forward: async ({ query }) => {
      const cached = ttl > 0 ? cache.get(query) : undefined;
      if (cached) return cached;

      const params = new URLSearchParams({
        q: query,
        count: String(maxResults),
        safesearch: opts.safeSearch ?? "moderate",
        country: opts.country ?? "US",
      });

      const resp = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: {
          "X-Subscription-Token": opts.apiKey,
          Accept: "application/json",
        },
      });

      if (!resp.ok) {
        throw new Error(`brave_search: HTTP ${resp.status} ${await resp.text().catch(() => "")}`);
      }

      const data = (await resp.json()) as BraveApiResponse;
      const results: SearchResult[] = (data.web?.results ?? []).slice(0, maxResults).map((r) => {
        const item: SearchResult = {
          title: r.title,
          url: r.url,
          snippet: r.description,
        };
        if (r.age) item.publishedAt = r.age;
        return item;
      });

      if (ttl > 0) cache.set(query, results, ttl);
      return results;
    },
  };
}
