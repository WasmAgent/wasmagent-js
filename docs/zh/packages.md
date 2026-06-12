# 包结构

agentkit-js 是 26 个 npm 包的 monorepo，全部在 `@agentkit-js/*` scope 下。

## 运行时

| 包 | 是什么 |
|---|---|
| [`@agentkit-js/core`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/core) | Agent、kernel、model、tool、runner、evals、checkpoint、observability |
| [`@agentkit-js/cli`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/cli) | `agentkit run` 命令 |
| [`@agentkit-js/devtools`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/devtools) | 时间旅行调试器 + 可选 React UI |
| [`@agentkit-js/react`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/react) | `useAgentRun()` SSE 流式 hook |
| [`@agentkit-js/agent-prompts`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/agent-prompts) | 可复用提示词片段 |
| [`@agentkit-js/ui-cards`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/ui-cards) · [`ui-cards-react`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/ui-cards-react) | `\`\`\`card:*` 块解析器 + 渲染组件 |

## 代码执行 kernel

| 包 | 等级 | 边缘安全 |
|---|---|---|
| [`@agentkit-js/kernel-quickjs`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-quickjs) | 真 WASM | ✅ |
| [`@agentkit-js/kernel-pyodide`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-pyodide) | 真 WASM (Python) | ✅（重） |
| [`@agentkit-js/kernel-wasmtime`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-wasmtime) | 真 WASM via Javy | ✅ |
| [`@agentkit-js/kernel-remote`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/kernel-remote) | 外置微 VM（E2B / CF Sandbox） | n/a |

详见 [kernel 决策树](/zh/kernels-comparison)。

## 模型

### Anthropic / OpenAI

| 包 | 备注 |
|---|---|
| [`@agentkit-js/model-anthropic`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-anthropic) | 自动缓存断点、1 小时 TTL |
| [`@agentkit-js/model-openai`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-openai) | OpenAI / Azure OpenAI |

### 国产模型适配

> ⚠️ **合规提示** — 阅读各适配器 README 里的服务条款链接和数据出境说明。

| 包 | 服务方 | 亮点 |
|---|---|---|
| [`@agentkit-js/model-doubao`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-doubao) | 火山引擎 Ark | 思考分级 + `ark-context` 缓存 |
| [`@agentkit-js/model-deepseek`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-deepseek) | DeepSeek V4 | `thinking:{type,effort}` |
| [`@agentkit-js/model-moonshot`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-moonshot) | Moonshot Kimi | 按版本处理 reasoning 字段 |
| [`@agentkit-js/model-qwen`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-qwen) | 阿里云灵积 / 国际版 | `enable_thinking` + `thinking_budget` |
| [`@agentkit-js/model-zhipu`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-zhipu) | 智谱 GLM-5 | `thinking:{type}` via extra_body |
| [`@agentkit-js/model-minimax`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/model-minimax) | MiniMax M2/M3 | `reasoning_split` + `<think>` 标签解析 |

## 工具

| 包 | 工具 |
|---|---|
| [`@agentkit-js/tools-web`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/tools-web) | Tavily、Brave、Perplexity（LRU 缓存） |
| [`@agentkit-js/tools-rag`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/tools-rag) | `HttpEmbedder`、Pinecone、Qdrant、内存版 |
| [`@agentkit-js/tools-browser`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/tools-browser) | Playwright + CDP-bridge session、5 个工具 |

## 协议适配

| 包 | 协议 |
|---|---|
| [`@agentkit-js/mcp-server`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/mcp-server) | 把任意 agent 暴露为 MCP server |
| [`@agentkit-js/a2a`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/a2a) | A2A（Agent2Agent）入站 + 出站 |
| [`@agentkit-js/ag-ui`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/ag-ui) | AG-UI 入站 transport |

## 可观测性

| 包 | 内容 |
|---|---|
| [`@agentkit-js/otel-exporter`](https://github.com/telleroutlook/agentkit-js/tree/main/packages/otel-exporter) | EventLog 的 OTLP 导出器 |

## 内部（不上 npm）

- `@agentkit-js/cloudflare-worker` — `private: true`。Cloudflare Workers 入口示例；只通过 `wrangler deploy` 部署。
