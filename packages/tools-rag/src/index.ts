/**
 * @agentkit-js/tools-rag — RAG / embedding tools for agentkit-js.
 *
 * Provides:
 * - {@link HttpEmbedder}: generic embedder for any OpenAI-compatible
 *   /v1/embeddings endpoint (OpenAI, Voyage, Cohere via overrides,
 *   plus local servers like Ollama / vLLM / LM Studio)
 * - {@link PineconeStore}: Pinecone-backed vector store
 * - {@link QdrantStore}: Qdrant-backed vector store (self-hosted or cloud)
 * - {@link ragTool}: ToolDefinition wrapper turning any Retriever into
 *   an agent-callable retrieval tool
 *
 * Re-exports from `@agentkit-js/core`:
 * - InMemoryVectorStore (in-process)
 * - KvBackendVectorStore (Cloudflare KV / Redis-backed)
 * - TfidfEmbedder (zero-deps prototype embedder)
 *
 * @example
 *   import { HttpEmbedder, qdrantStore, ragTool } from "@agentkit-js/tools-rag";
 *   const embedder = new HttpEmbedder({
 *     apiKey: process.env.OPENAI_API_KEY!,
 *     model: "text-embedding-3-small",
 *   });
 *   const store = qdrantStore({
 *     url: "http://localhost:6333",
 *     collection: "my-docs",
 *     embedder,
 *   });
 *   await store.add("doc-1", "agentkit-js is a TypeScript agent runtime");
 *   const tool = ragTool({ store });
 *   // pass `tool` to ToolCallingAgent constructor
 */

export type { Embedder, Retriever, SearchResult } from "@agentkit-js/core";
// Re-exports of core's already-shipped vector primitives, for convenient
// single-import access.
export {
  InMemoryVectorStore,
  KvBackendVectorStore,
  TfidfEmbedder,
} from "@agentkit-js/core";
export type { PineconeStoreOpts } from "./connectors/pinecone.js";
export { PineconeStore, pineconeStore } from "./connectors/pinecone.js";
export type { QdrantStoreOpts } from "./connectors/qdrant.js";
export { QdrantStore, qdrantStore } from "./connectors/qdrant.js";
export type { HttpEmbedderOpts } from "./HttpEmbedder.js";
export { HttpEmbedder, OpenAiCompatibleEmbedder } from "./HttpEmbedder.js";
export type { RagToolOpts } from "./RagTool.js";
export { ragTool } from "./RagTool.js";
