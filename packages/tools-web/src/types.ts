/**
 * Shared types for @agentkit-js/tools-web search tool adapters.
 *
 * All built-in adapters (tavily, brave, perplexity) normalize their
 * provider-specific response into the same SearchResult shape so an
 * agent can swap adapters without prompt changes.
 */

export interface SearchResult {
  /** Title of the result page. */
  title: string;
  /** Canonical URL. */
  url: string;
  /** Short snippet / preview text. */
  snippet: string;
  /** Provider-assigned relevance score, 0..1 if available. */
  score?: number;
  /** ISO 8601 publish date if the provider returned one. */
  publishedAt?: string;
}

/** Common options accepted by every web-search tool factory. */
export interface WebSearchToolOpts {
  /** API key for the search provider. Required. */
  apiKey: string;
  /** Max results to return per query. Default: 5. */
  maxResults?: number;
  /** Override the LRU cache TTL (default 5 minutes). Set to 0 to disable cache. */
  cacheTtlMs?: number;
}
