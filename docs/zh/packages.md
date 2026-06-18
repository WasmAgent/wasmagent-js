# 包结构

wasmagent 是 30 个 npm 包的 monorepo，全部在 `@wasmagent/*` scope 下。

## 运行时

| 包 | 是什么 |
|---|---|
| [`@wasmagent/core`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/core) | Agent、kernel、model、tool、runner、evals、checkpoint、observability |
| [`@wasmagent/cli`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/cli) | `agentkit` CLI:`run`、`init-tool`、`devtools`、`evals` |
| [`@wasmagent/devtools`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/devtools) | 时间旅行调试器 + 可选 React UI + 本地 Studio 的 `RunsAggregator` |
| [`@wasmagent/evals-runner`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/evals-runner) | 多模型 × 多套件 Pareto 评测;6 个参考套件;McNemar / Wilson / bootstrap / G1 配对统计 |
| [`@wasmagent/react`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/react) | `useAgentRun()` SSE 流式 hook |
| [`@wasmagent/agent-prompts`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/agent-prompts) | 可复用提示词片段 |
| [`@wasmagent/ui-cards`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/ui-cards) · [`ui-cards-react`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/ui-cards-react) | `\`\`\`card:*` 块解析器 + 渲染组件 |

## 代码执行 kernel

| 包 | 等级 | 边缘安全 |
|---|---|---|
| [`@wasmagent/kernel-quickjs`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-quickjs) | 真 WASM | ✅ |
| [`@wasmagent/kernel-pyodide`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-pyodide) | 真 WASM (Python) | ✅（重） |
| [`@wasmagent/kernel-wasmtime`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-wasmtime) | 真 WASM via Javy | ✅ |
| [`@wasmagent/kernel-remote`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-remote) | 外置微 VM（E2B / CF Sandbox） | n/a |

详见 [kernel 决策树](/zh/kernels-comparison)。

## 模型

### Anthropic / OpenAI

| 包 | 备注 |
|---|---|
| [`@wasmagent/model-anthropic`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-anthropic) | 自动缓存断点、1 小时 TTL |
| [`@wasmagent/model-openai`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-openai) | OpenAI / Azure OpenAI |

### 国产模型适配

> ⚠️ **合规提示** — 阅读各适配器 README 里的服务条款链接和数据出境说明。

| 包 | 服务方 | 亮点 |
|---|---|---|
| [`@wasmagent/model-doubao`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-doubao) | 火山引擎 Ark | 思考分级 + `ark-context` 缓存 |
| [`@wasmagent/model-deepseek`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-deepseek) | DeepSeek V4 | `thinking:{type,effort}` |
| [`@wasmagent/model-moonshot`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-moonshot) | Moonshot Kimi | 按版本处理 reasoning 字段 |
| [`@wasmagent/model-qwen`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-qwen) | 阿里云灵积 / 国际版 | `enable_thinking` + `thinking_budget` |
| [`@wasmagent/model-zhipu`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-zhipu) | 智谱 GLM-5 | `thinking:{type}` via extra_body |
| [`@wasmagent/model-minimax`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/model-minimax) | MiniMax M2/M3 | `reasoning_split` + `<think>` 标签解析 |

## 工具

| 包 | 工具 |
|---|---|
| [`@wasmagent/tools-web`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-web) | Tavily、Brave、Perplexity（LRU 缓存） |
| [`@wasmagent/tools-rag`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-rag) | `HttpEmbedder`、Pinecone、Qdrant、内存版 |
| [`@wasmagent/tools-browser`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/tools-browser) | Playwright + CDP-bridge session、5 个工具 |

## 协议适配

| 包 | 协议 |
|---|---|
| [`@wasmagent/mcp-server`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mcp-server) | 把任意 agent 暴露为 MCP server;`createCodeModeServer()` 提供 docs_search + execute_code 双工具表面 |
| [`@wasmagent/aisdk`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/aisdk) | Vercel AI SDK 4–6 集成:`sandboxedJsTool()` + `codeModeTool()` |
| [`@wasmagent/mastra-sandbox`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/mastra-sandbox) | 实现 Mastra 的 sandbox provider 协议,后端是 wasmagent kernel |
| [`@wasmagent/a2a`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/a2a) | A2A（Agent2Agent）入站 + 出站 |
| [`@wasmagent/ag-ui`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/ag-ui) | AG-UI 入站 transport |

## 可观测性

| 包 | 内容 |
|---|---|
| [`@wasmagent/otel-exporter`](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/otel-exporter) | EventLog 的 OTLP 导出器 |

## 内部（不上 npm）

- `@wasmagent/cloudflare-worker` — `private: true`。Cloudflare Workers 入口示例；只通过 `wrangler deploy` 部署。
