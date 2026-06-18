# OpenAI-compatible recipes — connect any model in ≤10 lines

> **Status**: A5 (S, 2026-06). The recommended path for any new model
> integration. Existing `model-*` packages keep working but are now
> documented as **presets** rather than the primary integration story.

The Mastra leaderboard race (94 providers / 3300+ models, March 2026) and
the AI SDK 6 unified `gateway()` API both proved one thing: hand-rolling
provider adapters is a losing race. Almost every model worth using —
OpenAI, Anthropic-via-OpenRouter, Mistral, DeepSeek, Qwen, Doubao,
Moonshot, Zhipu, MiniMax, Together, Fireworks, Groq, Anyscale, Ollama,
LM Studio, vLLM, llama-server — speaks an OpenAI-compatible
`/chat/completions`.

agentkit's answer: **`GenericOpenAICompatModel`** in `@wasmagent/core`.
One concrete class, three constructor args, every provider's quirks
expressed as runtime config. New providers become README recipes (this
file), not new packages.

```ts
import { GenericOpenAICompatModel } from "@wasmagent/core";
```

## Recipe — Ollama / LM Studio (local, no API key)

```ts
const model = new GenericOpenAICompatModel("qwen2.5:14b", "http://localhost:11434/v1", {
  apiKey: "ollama", // any non-empty string; Ollama ignores it
  extraCapabilities: { localEndpoint: true, metered: false },
});
```

For LM Studio swap base URL to `http://localhost:1234/v1`. For
llama-server / vLLM: `http://localhost:<port>/v1`.

## Recipe — OpenRouter (every model on one URL)

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

OpenRouter's full catalogue (~300 models) is available the same way —
just change `modelId`.

## Recipe — Vercel AI Gateway

```ts
const model = new GenericOpenAICompatModel("openai/gpt-4o-mini", "https://gateway.ai.vercel.app/v1", {
  apiKey: process.env.VERCEL_AI_GATEWAY_KEY,
});
```

## Recipe — Cloudflare AI Gateway

```ts
const model = new GenericOpenAICompatModel(
  "openai/gpt-4o-mini",
  `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_NAME}/openai/v1`,
  { apiKey: process.env.OPENAI_API_KEY }
);
```

## Recipe — DeepSeek (with reasoning_content round-trip)

DeepSeek-R1 emits `reasoning_content` on a non-standard delta field and
expects it echoed back on tool-result turns. One option flag covers both:

```ts
const model = new GenericOpenAICompatModel("deepseek-r1", "https://api.deepseek.com/v1", {
  apiKey: process.env.DEEPSEEK_API_KEY,
  reasoningContentField: "reasoning_content",
  reasoningRoundTrip: "tool-turns-only",
});
```

This is exactly what `@wasmagent/model-deepseek` does internally — it's
preserved as a named preset, but the recipe above gets you 100% of the
behaviour without an extra `npm install`.

## Recipe — Groq (super-fast Llama / Mixtral)

```ts
const model = new GenericOpenAICompatModel("llama-3.3-70b-versatile", "https://api.groq.com/openai/v1", {
  apiKey: process.env.GROQ_API_KEY,
});
```

## Recipe — Together / Fireworks

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

## Recipe — `extraRequestParams` & `extraThinkingParams` for one-off quirks

Some endpoints accept non-standard fields like
`enable_thinking` (Qwen3) or `effort` levels exposed under different
names. Pass them through without subclassing:

```ts
const model = new GenericOpenAICompatModel("qwen3-235b-instruct", "https://dashscope.aliyuncs.com/compatible-mode/v1", {
  apiKey: process.env.DASHSCOPE_API_KEY,
  extraRequestParams: { enable_thinking: true },
  reasoningContentField: "reasoning_content",
  reasoningRoundTrip: "tool-turns-only",
});
```

## When you DO need a `model-*` package

If your provider differs in ways `GenericOpenAICompatModel` cannot express
in options (e.g. a non-streamed reasoning protocol, custom request shape,
non-OpenAI streaming envelope), subclass `OpenAICompatModel` directly and
override the relevant `protected` hooks. That is what the existing
`model-deepseek`, `model-doubao`, `model-moonshot`, `model-zhipu`,
`model-qwen`, `model-minimax` packages do. **We are not removing them** —
they remain as imported-by-name presets and as canonical examples for
contributors. We are just no longer growing this list as the primary
integration story.

## See also

- [`packages/core/src/models/OpenAICompatModel.ts`](../../packages/core/src/models/OpenAICompatModel.ts)
  — the implementation. The `GenericOpenAICompatModel` class is at the
  bottom of the file.
- [`docs/guides/code-mode.md`](./code-mode.md) — uses these models
  inside the code-mode MCP server pattern.
