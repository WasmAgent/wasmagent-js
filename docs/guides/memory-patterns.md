# Memory Patterns Guide

agentkit-js ships three memory primitives that work well together:
- **Vector retrieval** (semantic + BM25 hybrid): the [`HybridRetriever`](../../packages/core/src/memory/HybridRetriever.ts)
- **Structured key-value memory** with TTL & decay: the [`StructuredMemory`](../../packages/core/src/memory/StructuredMemory.ts)
- **Cross-session persistent memory tool** for agents: [`createMemoryTool`](../../packages/core/src/memory/MemoryTool.ts)

This guide describes when to use each and how to combine them.

---

## Memory taxonomy

`StructuredMemory` distinguishes three namespaces, each with different
retention semantics:

| Namespace | Default TTL | Purpose | Examples |
|-----------|-------------|---------|----------|
| `episodic` | 7 days | Recent events, observations | "user asked about React 19 yesterday" |
| `semantic` | none (persistent) | Stable facts | "the user's API key is in env var X" |
| `procedural` | 30 days | How-to / skill memory | "to deploy Worker, run `bun run deploy`" |

Cold episodic entries (accessCount=0 and >30 days old) are also evicted
on `decay()`, regardless of TTL.

```ts
import { StructuredMemory, InMemoryStructuredKv } from "@agentkit-js/core";

const mem = new StructuredMemory(new InMemoryStructuredKv());
await mem.set("user:42", { name: "Alice" }, { namespace: "semantic" });
await mem.set("event:login-2026-06-10", { ip: "..." }, { namespace: "episodic" });
await mem.set("task:deploy", { steps: [...] }, { namespace: "procedural" });

// Periodic cleanup
const result = await mem.decay();
console.log(`Pruned ${result.purged}/${result.scanned} entries`);
```

---

## Cross-session memory pattern

Use `createMemoryTool` to expose memory as a tool the agent can call.
The tool reads/writes through any `KvBackend`, so swap the backend
between in-memory (dev) and Cloudflare KV (prod).

```ts
import { createMemoryTool, MapKvBackend } from "@agentkit-js/core";

const memoryTool = createMemoryTool({
  backend: new MapKvBackend(), // or a CF KV-backed impl
  namespace: "user:42",        // per-user isolation
});

const agent = new ToolCallingAgent({
  model,
  tools: [memoryTool, ...otherTools],
});
```

The agent gets four built-in operations: `memory_set`, `memory_get`,
`memory_list`, `memory_delete`.

---

## RAG / retrieval pattern

For semantic recall over large corpora, use `HybridRetriever` with a
dense embedder (`@agentkit-js/tools-rag`'s `HttpEmbedder`) and any
vector store:

```ts
import { HybridRetriever, InMemoryVectorStore } from "@agentkit-js/core";
import { HttpEmbedder, ragTool } from "@agentkit-js/tools-rag";

const embedder = new HttpEmbedder({
  apiKey: process.env.OPENAI_API_KEY!,
  model: "text-embedding-3-small",
});
const dense = new InMemoryVectorStore(embedder);
const hybrid = new HybridRetriever({ dense, bm25Weight: 0.4, semanticWeight: 0.6 });

await hybrid.add("doc-1", "agentkit-js is a TypeScript agent runtime");
// ... ingest more docs ...

const tool = ragTool({ store: hybrid });
// pass `tool` to ToolCallingAgent
```

BM25 is automatically maintained alongside the dense store. For a
keyword-heavy corpus (logs, code), bump `bm25Weight` toward 0.6 or 0.7.
For natural-language Q&A, the default 0.4/0.6 split usually wins.

---

## Decay strategies

Three modes:

1. **Lazy** (default): TTL is enforced on every `get()`. Expired entries
   return null and are silently deleted on read.
2. **Active**: call `mem.decay()` periodically (cron / Cloudflare scheduled
   handler) to bulk-prune expired and cold entries. Keeps storage bounded.
3. **Audit**: `mem.decay({ dryRun: true })` reports what would be purged
   without deleting. Useful for debugging quota issues.

For large episodic stores, schedule active decay daily. Semantic facts
live forever — don't run decay against them unless you have a specific
use case.

---

## Combining patterns

A common architecture:

- **HybridRetriever** for documents the agent should search
- **StructuredMemory(semantic)** for stable user preferences and project context
- **StructuredMemory(episodic)** for recent observations
- **createMemoryTool** wraps the structured memory as agent-callable

Each plays to its strength: retrieval for fuzzy "what was discussed" queries,
structured memory for exact lookups, tool wrapper to let the agent
self-manage context.
