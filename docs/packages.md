# Packages

agentkit-js is a 26-package monorepo published under the `@agentkit-js/*` scope on npm.

## Runtime

| Package | What it is |
|---|---|
| [`@agentkit-js/core`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/core) | Agents, kernels, models, tools, runners, evals, checkpoints, observability |
| [`@agentkit-js/cli`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/cli) | `agentkit run` command |
| [`@agentkit-js/devtools`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/devtools) | Time-travel debugger + opt-in React UI |
| [`@agentkit-js/react`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/react) | `useAgentRun()` SSE streaming hook |
| [`@agentkit-js/agent-prompts`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/agent-prompts) | Reusable prompt fragments |
| [`@agentkit-js/ui-cards`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/ui-cards) · [`ui-cards-react`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/ui-cards-react) | `\`\`\`card:*` block parser + components |

## Code execution kernels

| Package | Tier | Edge-safe |
|---|---|---|
| [`@agentkit-js/kernel-quickjs`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-quickjs) | True WASM | ✅ |
| [`@agentkit-js/kernel-pyodide`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-pyodide) | True WASM (Python) | ✅ (heavy) |
| [`@agentkit-js/kernel-wasmtime`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-wasmtime) | True WASM via Javy | ✅ |
| [`@agentkit-js/kernel-remote`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-remote) | External microVM (E2B / CF Sandbox) | n/a |

See the [kernel decision tree](/kernels/comparison) for picking the right one.

## Models

### Anthropic / OpenAI

| Package | Notes |
|---|---|
| [`@agentkit-js/model-anthropic`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-anthropic) | Auto cache breakpoints, 1-hour TTL |
| [`@agentkit-js/model-openai`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-openai) | OpenAI / Azure OpenAI |

### Chinese model providers

> ⚠️ **Compliance** — read each adapter's README for the provider's terms of service and data-residency notes.

| Package | Provider | Highlights |
|---|---|---|
| [`@agentkit-js/model-doubao`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-doubao) | Volcengine Ark | thinking tiers + `ark-context` cache |
| [`@agentkit-js/model-deepseek`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-deepseek) | DeepSeek V4 | `thinking:{type,effort}` |
| [`@agentkit-js/model-moonshot`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-moonshot) | Moonshot / Kimi | per-version reasoning field |
| [`@agentkit-js/model-qwen`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-qwen) | Alibaba DashScope | `enable_thinking` + `thinking_budget` |
| [`@agentkit-js/model-zhipu`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-zhipu) | Zhipu GLM-5 | `thinking:{type}` via extra_body |
| [`@agentkit-js/model-minimax`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-minimax) | MiniMax M2/M3 | `reasoning_split` + `<think>` tag parsing |

## Tools

| Package | Tools |
|---|---|
| [`@agentkit-js/tools-web`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/tools-web) | Tavily, Brave, Perplexity (LRU-cached) |
| [`@agentkit-js/tools-rag`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/tools-rag) | `HttpEmbedder`, Pinecone, Qdrant, in-memory |
| [`@agentkit-js/tools-browser`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/tools-browser) | Playwright + CDP-bridge sessions, 5 tools |

## Protocol adapters

| Package | Protocol |
|---|---|
| [`@agentkit-js/mcp-server`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/mcp-server) | Expose any agent as MCP server |
| [`@agentkit-js/a2a`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/a2a) | A2A (Agent2Agent) inbound + outbound |
| [`@agentkit-js/ag-ui`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/ag-ui) | AG-UI inbound transport |

## Observability

| Package | What |
|---|---|
| [`@agentkit-js/otel-exporter`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/otel-exporter) | OTLP exporter for `EventLog` |

## Internal (not on npm)

- `@agentkit-js/cloudflare-worker` — `private: true`. Sample Workers entry point; ships only via `wrangler deploy`.
