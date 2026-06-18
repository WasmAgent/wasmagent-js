/**
 * @wasmagent/tools-web — web-search tool adapters for agentkit-js.
 *
 * Three production-ready providers, normalized to a common
 * {@link SearchResult} schema so an agent can swap providers without
 * touching its prompt or tool-handling code.
 *
 * @example
 *   import { tavilySearchTool } from "@wasmagent/tools-web";
 *   const search = tavilySearchTool({ apiKey: process.env.TAVILY_API_KEY! });
 *   const agent = new ToolCallingAgent({ model, tools: [search] });
 */

export type { BraveSearchOpts } from "./brave.js";
export { braveSearchTool } from "./brave.js";
export { LruCache } from "./lruCache.js";
export type { PerplexityAnswer, PerplexityAskOpts } from "./perplexity.js";
export { perplexityAskTool } from "./perplexity.js";
export type { TavilySearchOpts } from "./tavily.js";
export { tavilySearchTool } from "./tavily.js";
export type { SearchResult, WebSearchToolOpts } from "./types.js";
