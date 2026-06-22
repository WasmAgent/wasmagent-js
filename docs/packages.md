# Packages

agentkit-js is a 33-package monorepo published under the `@wasmagent/*` scope on npm.

## Runtime

| Package | What it is |
|---|---|
| [`@wasmagent/core`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/core) | Agents, kernels, models, tools, runners, evals, checkpoints, observability, RLAIF rollout infrastructure |
| [`@wasmagent/cli`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/cli) | `agentkit` CLI: `run`, `init-tool`, `devtools`, `evals` |
| [`@wasmagent/devtools`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/devtools) | Time-travel debugger + opt-in React UI + `RunsAggregator` for the local Studio |
| [`@wasmagent/evals-runner`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/evals-runner) | Multi-model multi-suite Pareto evaluation harness; six reference suites; paired statistics (McNemar / Wilson / bootstrap / G1) |
| [`@wasmagent/react`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/react) | `useAgentRun()` SSE streaming hook |
| [`@wasmagent/agent-prompts`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/agent-prompts) | Reusable prompt fragments |
| [`@wasmagent/ui-cards`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/ui-cards) · [`ui-cards-react`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/ui-cards-react) | `\`\`\`card:*` block parser + components |
## Code execution kernels

| Package | Tier | Edge-safe |
|---|---|---|
| [`@wasmagent/kernel-quickjs`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-quickjs) | True WASM | ✅ |
| [`@wasmagent/kernel-pyodide`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-pyodide) | True WASM (Python) | ✅ (heavy) |
| [`@wasmagent/kernel-wasmtime`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-wasmtime) | True WASM via Javy | ✅ |
| [`@wasmagent/kernel-remote`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-remote) | External microVM (E2B / CF Sandbox) | n/a |

See the [kernel decision tree](/kernels/comparison) for picking the right one.

## Models

### Anthropic / OpenAI

| Package | Notes |
|---|---|
| [`@wasmagent/model-anthropic`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-anthropic) | Auto cache breakpoints, 1-hour TTL |
| [`@wasmagent/model-openai`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-openai) | OpenAI / Azure OpenAI |

### Local LLM (offline / privacy / cost)

| Package | Notes |
|---|---|
| [`@wasmagent/model-local`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-local) | `node-llama-cpp` adapter; multi-mirror registry (HF / hf-mirror / ModelScope); JSON-schema grammar; `localFirst` / `offlineOnly` / `devLocalOr` routing presets |

### Chinese model providers

> ⚠️ **Compliance** — read each adapter's README for the provider's terms of service and data-residency notes.

| Package | Provider | Highlights |
|---|---|---|
| [`@wasmagent/model-doubao`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-doubao) | Volcengine Ark | thinking tiers + `ark-context` cache |
| [`@wasmagent/model-deepseek`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-deepseek) | DeepSeek V4 | `thinking:{type,effort}` |
| [`@wasmagent/model-moonshot`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-moonshot) | Moonshot / Kimi | per-version reasoning field |
| [`@wasmagent/model-qwen`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-qwen) | Alibaba DashScope | `enable_thinking` + `thinking_budget` |
| [`@wasmagent/model-zhipu`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-zhipu) | Zhipu GLM-5 | `thinking:{type}` via extra_body |
| [`@wasmagent/model-minimax`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-minimax) | MiniMax M2/M3 | `reasoning_split` + `<think>` tag parsing |

## Tools

| Package | Tools |
|---|---|
| [`@wasmagent/tools-web`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-web) | Tavily, Brave, Perplexity (LRU-cached) |
| [`@wasmagent/tools-rag`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-rag) | `HttpEmbedder`, Pinecone, Qdrant, in-memory |
| [`@wasmagent/tools-browser`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-browser) | Playwright + CDP-bridge sessions, 5 tools |

## Protocol adapters

| Package | Protocol |
|---|---|
| [`@wasmagent/mcp-server`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-server) | Expose any agent as MCP server; `createCodeModeServer()` for the docs-search + execute-code two-tool surface |
| [`@wasmagent/aisdk`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/aisdk) | Vercel AI SDK 4–6 integration: `sandboxedJsTool()` + `codeModeTool()` |
| [`@wasmagent/mastra-sandbox`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mastra-sandbox) | Mastra sandbox-provider contract backed by an agentkit kernel |
| [`@wasmagent/claude-agent-sdk`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/claude-agent-sdk) | Anthropic Claude Agent SDK adapter — wrap an agentkit kernel as a Claude SDK tool |
| [`@wasmagent/openai-agents`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/openai-agents) | OpenAI Agents JS adapter — `Tool<T>` shape backed by an agentkit kernel |
| [`@wasmagent/a2a`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/a2a) | A2A (Agent2Agent) inbound + outbound |
| [`@wasmagent/ag-ui`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/ag-ui) | AG-UI inbound transport |

## Observability

| Package | What |
|---|---|
| [`@wasmagent/otel-exporter`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/otel-exporter) | OTLP exporter for `EventLog` |

## Internal (not on npm)

- `@wasmagent/cloudflare-worker` — `private: true`. Sample Workers entry point; ships only via `wrangler deploy`.
