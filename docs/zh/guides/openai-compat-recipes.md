# OpenAI 兼容配方 — 用不到 10 行代码接入任意模型

> **状态**: A5（S，2026-06）。推荐用于所有新模型集成的路径。现有 `model-*` 包
> 继续工作，但现在被记录为**预设**，而不再是主要集成方式。

Mastra 排行榜竞赛（94 个 provider / 3300+ 个模型，2026 年 3 月）和 AI SDK 6 统一的
`gateway()` API 都证明了一件事：手写 provider 适配器是一场输不起的赛跑。几乎所有值得
使用的模型——OpenAI、Anthropic-via-OpenRouter、Mistral、DeepSeek、Qwen、Doubao、
Moonshot、Zhipu、MiniMax、Together、Fireworks、Groq、Anyscale、Ollama、LM Studio、
vLLM、llama-server——都支持 OpenAI 兼容的 `/chat/completions`。

wasmagent 的答案：`@wasmagent/core` 中的 **`GenericOpenAICompatModel`**。
一个具体类，三个构造参数，每个 provider 的怪癖通过运行时配置表达。
新 provider 变成 README 配方（本文），而不是新包。

```ts
import { GenericOpenAICompatModel } from "@wasmagent/core";
```

## 配方 — Ollama / LM Studio（本地，无需 API key）

```ts
const model = new GenericOpenAICompatModel("qwen2.5:14b", "http://localhost:11434/v1", {
  apiKey: "ollama", // 任意非空字符串；Ollama 会忽略它
  extraCapabilities: { localEndpoint: true, metered: false },
});
```

LM Studio 将 base URL 改为 `http://localhost:1234/v1`。
llama-server / vLLM：`http://localhost:<port>/v1`。

## 配方 — OpenRouter（一个 URL 访问所有模型）

```ts
const model = new GenericOpenAICompatModel(
  "anthropic/claude-3.5-sonnet",
  "https://openrouter.ai/api/v1",
  {
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultHeaders: {
      "HTTP-Referer": "https://your-app.example",
      "X-Title": "your-app",
    },
  }
);
```

OpenRouter 的完整目录（约 300 个模型）同样如此——只需更换 `modelId`。

## 配方 — Vercel AI Gateway

```ts
const model = new GenericOpenAICompatModel("openai/gpt-4o-mini", "https://gateway.ai.vercel.app/v1", {
  apiKey: process.env.VERCEL_AI_GATEWAY_KEY,
});
```

## 配方 — Cloudflare AI Gateway

```ts
const model = new GenericOpenAICompatModel(
  "openai/gpt-4o-mini",
  `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_NAME}/openai/v1`,
  { apiKey: process.env.OPENAI_API_KEY }
);
```

## 配方 — DeepSeek（含 reasoning_content 往返）

DeepSeek-R1 在非标准 delta 字段上输出 `reasoning_content`，并期望在工具结果轮次中
将其回传。一个选项标志涵盖两者：

```ts
const model = new GenericOpenAICompatModel("deepseek-r1", "https://api.deepseek.com/v1", {
  apiKey: process.env.DEEPSEEK_API_KEY,
  reasoningContentField: "reasoning_content",
  reasoningRoundTrip: "tool-turns-only",
});
```

这正是 `@wasmagent/model-deepseek` 内部所做的——它作为具名预设保留，但上面的配方
无需额外 `npm install` 即可获得 100% 相同的行为。

## 配方 — Groq（超快 Llama / Mixtral）

```ts
const model = new GenericOpenAICompatModel("llama-3.3-70b-versatile", "https://api.groq.com/openai/v1", {
  apiKey: process.env.GROQ_API_KEY,
});
```

## 配方 — Together / Fireworks

```ts
// Together
new GenericOpenAICompatModel("meta-llama/Llama-3.3-70B-Instruct-Turbo", "https://api.together.xyz/v1", {
  apiKey: process.env.TOGETHER_API_KEY,
});

// Fireworks
new GenericOpenAICompatModel(
  "accounts/fireworks/models/llama-v3p3-70b-instruct",
  "https://api.fireworks.ai/inference/v1",
  { apiKey: process.env.FIREWORKS_API_KEY }
);
```

## 配方 — `extraRequestParams` & `extraThinkingParams` 应对零散的怪癖

某些端点接受非标准字段，例如 `enable_thinking`（Qwen3）或以不同名称暴露的
`effort` 级别。无需子类化即可透传：

```ts
const model = new GenericOpenAICompatModel("qwen3-235b-instruct", "https://dashscope.aliyuncs.com/compatible-mode/v1", {
  apiKey: process.env.DASHSCOPE_API_KEY,
  extraRequestParams: { enable_thinking: true },
  reasoningContentField: "reasoning_content",
  reasoningRoundTrip: "tool-turns-only",
});
```

## 什么时候确实需要 `model-*` 包

如果你的 provider 的差异是 `GenericOpenAICompatModel` 无法通过选项表达的（例如非流式
推理协议、自定义请求形状、非 OpenAI 流式信封），直接子类化 `OpenAICompatModel` 并覆盖相关的
`protected` 钩子。这正是现有的 `model-deepseek`、`model-doubao`、`model-moonshot`、
`model-zhipu`、`model-qwen`、`model-minimax` 包所做的。**我们不会删除它们**——
它们作为按名导入的预设和贡献者的规范示例保留下来。
我们只是不再将此列表的增长作为主要集成方式。

## 参见

- [`packages/core/src/models/OpenAICompatModel.ts`](../../packages/core/src/models/OpenAICompatModel.ts)
  — 实现。`GenericOpenAICompatModel` 类在文件底部。
- [`docs/guides/code-mode.md`](./code-mode.md) — 在 code-mode MCP server 模式中使用这些模型。
