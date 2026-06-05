# agentkit-js

> TypeScript + WASM agent runtime — a high-efficiency reimagination of [smolagents](https://github.com/huggingface/smolagents) by Hugging Face.

## Acknowledgements

This project draws significant inspiration from Hugging Face's [smolagents](https://github.com/huggingface/smolagents) (Python). The core agent loop structure, tool abstraction design (`Tool.forward()` / `ToolCollection`), step-type semantics (`ActionStep` / `PlanningStep` / `FinalAnswerStep`), and overall "few lines to a working agent" developer experience are all informed by smolagents' excellent design.

`agentkit-js` is a ground-up TypeScript reimplementation targeting different runtime characteristics — not a port. Key differences:

| | smolagents (Python) | agentkit-js |
|---|---|---|
| Execution | Sync serial `while` loop, 0 `async def` | `async/await` + `AsyncGenerator` |
| Sandbox | Blacklist AST interpreter (`local_python_executor.py`) | WASM capability model (deny-all, A1/A2) |
| Context | Full history rebuilt every step (O(n²) tokens) | Cache-friendly prefix assembly (B1/B2) |
| Caching | Zero `cache_control` | Anthropic prompt-caching breakpoints |
| Language | Python | TypeScript (JS/MicroPython/Pyodide kernels) |

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

## Architecture

```
agentkit-js/
├── packages/
│   ├── core/                 # Agent runtime, executor, memory, models, tools
│   ├── cli/                  # agentkit CLI (D6)
│   └── cloudflare-worker/    # Cloudflare Workers HTTP API entry point
└── examples/
    └── basic-agent/          # Minimal working example
```

### Four design pillars (from the spec)

- **A — Persistent WASM execution kernel** — replaces the 1768-line blacklist AST interpreter and cold-start remote sandboxes. `JsKernel` (M0 default) → `WasmtimeKernel` (M1, native WASM) → `V8WasmKernel` (pure-JS fallback, Cloudflare Workers / Lambda).
- **B — Context engineering** — `MessageAssembler` builds cache-stable message prefixes so Anthropic prompt caching kicks in from step 2 onwards (target: ≥80% cache-read token ratio, ≥60% cost reduction).
- **C — DAG scheduling + async core** — `AsyncGenerator`-based streaming with structured `AgentEvent` objects carrying `traceId` / `parentTraceId` for multi-agent fan-out tracing.
- **D — Developer ergonomics** — `CodeAgent` and `ToolCallingAgent` constructors are intentionally close to smolagents', so existing users can migrate incrementally.

### Roadmap

| Milestone | Scope |
|-----------|-------|
| **M0** (current) | `JsKernel`, `CodeAgent`, `MessageAssembler`, Cloudflare Worker skeleton |
| **M1** | `WasmtimeKernel` + dual-engine fallback (A1/A2/A3), async streaming (C1), typed tools (D2) |
| **M2** | DAG scheduling (C2), speculative execution + barriers (C3), segment caching (B2), model adapters (E1) |
| **M3** | Pyodide backend (A4), lazy observation handles (B3), MCP/Hub integration (D4), CLI scaffold (D6) |

## Development

```bash
# Install
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Cloudflare Worker local dev
cd packages/cloudflare-worker && wrangler dev
```

### Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `ANTHROPIC_API_KEY` | `.env` / Wrangler secret | Anthropic model API access |
| `CLOUDFLARE_API_TOKEN` | GitHub secret | CI/CD Worker deployment |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub secret | CI/CD Worker deployment |

## License

MIT
