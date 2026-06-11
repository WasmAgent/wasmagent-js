# tool-calling-agent — ToolCallingAgent + MCP + Lazy observations

Two example scripts demonstrating the `ToolCallingAgent` surface — native
provider `tool_use` blocks instead of script generation.

## Run

```bash
pnpm install

# (1) ToolCallingAgent with MCP-style tools
ANTHROPIC_API_KEY=sk-… node mcp-agent.js

# (2) LazyObservationHandle pattern — parallel tool dispatch, lazy await
node lazy-observations.js
```

## What `mcp-agent.js` shows

- Connecting an MCP server via `McpToolCollection.fromStdio()` /
  `.fromSse()` (real-world wiring is commented at the top of the file).
- A self-contained fallback path that registers tools manually via
  `ToolRegistry`, so the example runs without an MCP server.
- The `ToolCallingAgent` event stream — `tool_call` / `tool_result` /
  `final_answer` — same shape as `CodeAgent` but driven by the model's
  native tool API.

## What `lazy-observations.js` shows

- `LazyObservationHandle.fromToolResult()` — launch N tool calls
  immediately and only resolve handles when their values are needed.
- Speed-up: total wall-clock = max(individual) instead of sum.
- Useful when the model needs to dispatch independent reads (weather +
  news + stocks) before producing a synthesis.

## Related

- [`basic-agent/`](../basic-agent/) — minimal CodeAgent variant.
- [`tool-search-rag/`](../tool-search-rag/) — RAG retrieval tool.
- [`durable-runtime/`](../durable-runtime/) — checkpoint + resume primitives.
