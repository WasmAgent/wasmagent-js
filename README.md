# agentkit-js

> TypeScript + WASM agent runtime — a high-efficiency reimagination of [smolagents](https://github.com/huggingface/smolagents) by Hugging Face.

## Acknowledgements

This project draws significant inspiration from Hugging Face's [smolagents](https://github.com/huggingface/smolagents) (Python). The core agent loop structure, tool abstraction design (`Tool.forward()` / `ToolCollection`), step-type semantics (`ActionStep` / `PlanningStep` / `FinalAnswerStep`), and overall "few lines to a working agent" developer experience are all informed by smolagents' excellent design.

`agentkit-js` is a ground-up TypeScript reimplementation targeting different runtime characteristics — not a port. Key differences:

| | smolagents (Python) | agentkit-js |
|---|---|---|
| Execution | Sync serial `while` loop, 0 `async def` | `async/await` + `AsyncGenerator` |
| Sandbox | Blacklist AST interpreter (`local_python_executor.py`) | WASM capability model (deny-all, A2) |
| Context | Full history rebuilt every step (O(n²) tokens) | Cache-friendly prefix assembly (B1/B2) |
| Caching | Zero `cache_control` | Anthropic prompt-caching breakpoints (B1) |
| Language | Python | TypeScript (JS + Pyodide/CPython kernels; MicroPython planned) |
| Agents | `CodeAgent`, `ToolCallingAgent` | `CodeAgent`, `ToolCallingAgent` |
| Scheduling | Serial | DAG + speculative execution (C2/C3) |

## Quick Start

```bash
pnpm add @agentkit-js/core @anthropic-ai/sdk
```

```ts
import { CodeAgent, AnthropicModel } from "@agentkit-js/core";

const agent = new CodeAgent({
  tools: [],
  model: new AnthropicModel("claude-sonnet-4-6"),
  maxSteps: 10,
});

for await (const event of agent.run("What is 42 * 1337?")) {
  if (event.event === "final_answer") console.log(event.data.answer);
}
```

### ToolCallingAgent

```ts
import { ToolCallingAgent, AnthropicModel } from "@agentkit-js/core";
import { z } from "zod";

const searchTool = {
  name: "search",
  description: "Search the web",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.string(),
  readOnly: true,
  idempotent: true,
  forward: async ({ query }) => `Results for: ${query}`,
};

const agent = new ToolCallingAgent({
  tools: [searchTool],
  model: new AnthropicModel("claude-sonnet-4-6"),
  maxSteps: 5,
});

for await (const event of agent.run("Search for recent AI news")) {
  if (event.event === "final_answer") console.log(event.data.answer);
}
```

## Architecture

```
agentkit-js/
├── packages/
│   ├── core/                 # Agent runtime, executor, memory, models, tools
│   ├── cli/                  # agentkit CLI
│   └── cloudflare-worker/    # Cloudflare Workers HTTP API entry point
└── examples/
    └── basic-agent/          # Minimal working example
```

### Four design pillars

- **A — Persistent WASM execution kernel** — `JsKernel` (default) runs JS in a Node.js vm sandbox with capability enforcement (deny-all, per-call `allowedHosts`/`allowedReadPaths`/`allowedWritePaths`). `V8WasmKernel` is the serverless-safe fallback. `WasmtimeKernel` (M1+) requires the optional native addon.
- **B — Context engineering** — `MessageAssembler` builds cache-stable message prefixes (B1) with configurable history segment caching (B2 `chunkSizeSteps`), so Anthropic prompt caching kicks in from step 2 onwards.
- **C — DAG scheduling + async core** — `AsyncGenerator`-based streaming with structured `AgentEvent` objects carrying `traceId`/`parentTraceId`. `Scheduler` executes tool DAGs in parallel (C2) with speculative pre-execution of read-only nodes ahead of barriers (C3).
- **D — Developer ergonomics** — `CodeAgent` and `ToolCallingAgent` constructors mirror smolagents', enabling incremental migration. Tools declare `readOnly`/`idempotent`/`requiredCapability` for scheduling and access control.

### Implementation status

| Pillar | Feature | Status |
|--------|---------|--------|
| A1 | `JsKernel` — stateful JS sandbox, snapshot/restore | ✅ Done |
| A1 | `V8WasmKernel` — serverless-safe fallback | ✅ Done |
| A1 | `WasmtimeKernel` — native WASM binding | ⏳ M1 (requires native addon) |
| A2 | Capability manifest enforcement (hosts, paths) | ✅ Done |
| A2 | `extraCapabilities` per-tool access control | ✅ Done |
| A4 | `PyodideKernel` — CPython-in-WASM via `pyodide` npm package | ✅ Done |
| B1 | `MessageAssembler` cache-stable prefix | ✅ Done |
| B1 | `AnthropicModel` `cache_control` breakpoints with token threshold | ✅ Done |
| B2 | Segment caching (`chunkSizeSteps`) | ✅ Done |
| B3 | `LazyObservationHandle` — async tool result handles | ✅ Done |
| C1 | `AsyncGenerator` streaming with `traceId`/`parentTraceId` | ✅ Done |
| C2 | DAG scheduling — parallel independent nodes | ✅ Done |
| C3 | Speculative execution — read-only nodes ahead of barriers | ✅ Done |
| C4 | Session/KV caching (Cloudflare Worker + KV namespace) | ✅ Done |
| D1 | `actionLanguage` routing (js/pyodide; micropython planned) | ✅ Done (js+pyodide) |
| D2 | Typed tools with Zod schemas, `readOnly`/`idempotent` enforcement | ✅ Done |
| D2 | `zodToJsonSchema` — full Zod→JSON Schema converter | ✅ Done |
| D4 | `McpToolCollection` — MCP server tools as agentkit ToolDefinitions | ✅ Done |
| D5 | `CodeAgent` — code-execution agent | ✅ Done |
| D5 | `ToolCallingAgent` — native tool_use agent | ✅ Done |
| D6 | `agentkit run` CLI with `--stream`/`--events` | ✅ Done |
| D6 | `agentkit init-tool` scaffold | ✅ Done |
| E1 | `AnthropicModel` — streaming + tool_use + cache | ✅ Done |
| E1 | `OpenAIModel` — streaming + tool_call | ✅ Done |

### Roadmap

| Milestone | Scope |
|-----------|-------|
| **M0** ✅ | `JsKernel`, `CodeAgent`, `MessageAssembler`, Cloudflare Worker |
| **M1** ✅ | `V8WasmKernel`, A2 capability enforcement, C1 streaming, D2 typed tools |
| **M2** ✅ | C2 DAG scheduling, C3 speculative execution, B2 segment caching, E1 model adapters |
| **M3** ✅ | `PyodideKernel` (A4), `LazyObservationHandle` (B3), `McpToolCollection` (D4), `init-tool` (D6), C4 session KV |
| **Remaining** | `WasmtimeKernel` native addon (A1 M1+), MicroPython backend (D1) |

## Development

```bash
# Install
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Typecheck
pnpm typecheck

# Cloudflare Worker local dev
cd packages/cloudflare-worker && wrangler dev
```

### CLI

```bash
# Run a task
agentkit run "What is the square root of 144?"

# Stream all events as NDJSON
agentkit run "Summarise recent AI news" --stream | jq .

# Filter to specific event types
agentkit run "Calculate something" --events final_answer,error

# Use a different model
agentkit run "Write a haiku" --model claude-opus-4-8 --max-steps 5
```

### Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `ANTHROPIC_API_KEY` | `.env` / Wrangler secret | Anthropic model API access |
| `CLOUDFLARE_API_TOKEN` | GitHub secret | CI/CD Worker deployment |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub secret | CI/CD Worker deployment |

## License

MIT
