# tool-search-rag — End-to-end RAG demo

A minimal example showing the typical RAG agent loop:

1. **Embedder** — `HttpEmbedder` calls OpenAI's `/v1/embeddings` to vectorize text
2. **Vector store** — `InMemoryVectorStore` indexes the vectors
3. **Web search** — `tavilySearchTool` brings live information in (configured but commented in this minimal seed flow)
4. **RAG tool** — `ragTool({ store })` lets the agent retrieve from the store via natural-language queries
5. **Agent** — `ToolCallingAgent` orchestrates the calls and returns a synthesized answer

## Setup

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
export TAVILY_API_KEY=...
bun install
bun run start
```

Expected output (truncated):

```
→ tool_call: retrieve({"query":"What's new in React 19","topK":3})
← tool_result: retrieve → [{"id":"react-19","text":"React 19 introduced..."},...]

=== Final answer ===
React 19 added the `use()` hook for unwrapping promises in render and stabilized Server Actions...
```

## Wire your own knowledge base

The seed loop in `index.js` shows the pattern for adding documents:

```ts
await store.add(id, text, optionalMetadata);
```

In a real app, replace it with:
- A loader that ingests Markdown / PDF / web pages
- A scheduled job that re-indexes on content changes
- A persistent backend (`KvBackendVectorStore`, `PineconeStore`, `QdrantStore`)
