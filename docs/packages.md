# Packages

agentkit-js is a 33-package monorepo published under the `@agentkit-js/*` scope on npm.

## Runtime

| Package | What it is |
|---|---|
| [`@agentkit-js/core`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/core) | Agents, kernels, models, tools, runners, evals, checkpoints, observability |
| [`@agentkit-js/cli`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/cli) | `agentkit` CLI: `run`, `init-tool`, `devtools`, `evals` |
| [`@agentkit-js/devtools`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/devtools) | Time-travel debugger + opt-in React UI + `RunsAggregator` for the local Studio |
| [`@agentkit-js/evals-runner`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/evals-runner) | Multi-model multi-suite Pareto evaluation harness; six reference suites; paired statistics (McNemar / Wilson / bootstrap / G1) |
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

### Local LLM (offline / privacy / cost)

| Package | Notes |
|---|---|
| [`@agentkit-js/model-local`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-local) | `node-llama-cpp` adapter; multi-mirror registry (HF / hf-mirror / ModelScope); JSON-schema grammar; `localFirst` / `offlineOnly` / `devLocalOr` routing presets |

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
| [`@agentkit-js/mcp-server`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/mcp-server) | Expose any agent as MCP server; `createCodeModeServer()` for the docs-search + execute-code two-tool surface |
| [`@agentkit-js/aisdk`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/aisdk) | Vercel AI SDK 4–6 integration: `sandboxedJsTool()` + `codeModeTool()` |
| [`@agentkit-js/mastra-sandbox`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/mastra-sandbox) | Mastra sandbox-provider contract backed by an agentkit kernel |
| [`@agentkit-js/claude-agent-sdk`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/claude-agent-sdk) | Anthropic Claude Agent SDK adapter — wrap an agentkit kernel as a Claude SDK tool |
| [`@agentkit-js/openai-agents`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/openai-agents) | OpenAI Agents JS adapter — `Tool<T>` shape backed by an agentkit kernel |
| [`@agentkit-js/a2a`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/a2a) | A2A (Agent2Agent) inbound + outbound |
| [`@agentkit-js/ag-ui`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/ag-ui) | AG-UI inbound transport |

## Observability

| Package | What |
|---|---|
| [`@agentkit-js/otel-exporter`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/otel-exporter) | OTLP exporter for `EventLog` |

## Internal (not on npm)

- `@agentkit-js/cloudflare-worker` — `private: true`. Sample Workers entry point; ships only via `wrangler deploy`.
