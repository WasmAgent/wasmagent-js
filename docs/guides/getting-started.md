# Getting started (5 minutes)

This walks you from zero to your first running agent. Pick the model adapter that matches the API key you have on hand.

## 1. Install

```bash
npm install @wasmagent/core @anthropic-ai/sdk
# or with Bun / pnpm
bun add @wasmagent/core @anthropic-ai/sdk
```

> Using a Chinese model? Swap the install for one of the dedicated adapters:
> `@wasmagent/model-doubao`, `@wasmagent/model-deepseek`, `@wasmagent/model-moonshot`, `@wasmagent/model-qwen`, `@wasmagent/model-zhipu`, `@wasmagent/model-minimax`.

## 2. Set your key

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or DOUBAO_API_KEY, DEEPSEEK_API_KEY, etc.
```

## 3. Write the agent

```ts
// hello-agent.ts
import { CodeAgent, AnthropicModel, AnthropicModels } from "@wasmagent/core";

const agent = new CodeAgent({
  model: new AnthropicModel(AnthropicModels.SONNET_4_6, {
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }),
});

const result = await agent.run({ task: "What's 12 * 13?" });
console.log(result.finalAnswer); // → 156
```

## 4. Run it

```bash
bun run hello-agent.ts
# or:  npx tsx hello-agent.ts
```

You should see the answer streamed back as the agent decides to compute (`12 * 13`) inside the default `VmKernel`.

## 5. Pick the right kernel for your environment

The default `VmKernel` uses `node:vm` and is fine for trusted local code. For everything else, swap in one of the WASM kernels:

| Where you're running | Use |
|---|---|
| Cloudflare Workers / Vercel Edge / Deno Deploy | [`@wasmagent/kernel-quickjs`](/kernels/comparison) |
| Need real Python | [`@wasmagent/kernel-pyodide`](/kernels/comparison) |
| Strongest sandboxing without a microVM | [`@wasmagent/kernel-wasmtime`](/kernels/comparison) |
| Real shell / npm install / compilation | [`@wasmagent/kernel-remote`](/kernels/comparison) (E2B / CF Sandbox) |

```ts
import { CodeAgent } from "@wasmagent/core";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const agent = new CodeAgent({
  model: /* … */,
  kernel: new QuickJSKernel(),
});
```

## What next?

- [Durable runtime](./durable-runtime) — checkpoints, SSE resume, stateless HITL
- [Skills & lifecycle hooks](./skills-and-hooks) — lazy-load tools, post-tool hooks (`–85 %` tokens)
- [DevTools](./devtools) — time-travel debugger and fork-from-any-step
- [Evals cookbook](./evals-cookbook) — 16 built-in scorers, multi-criterion judges
- [Use kernels with Vercel AI SDK](./integrate-vercel-ai-sdk) / [with Mastra](./integrate-mastra)

If anything blocks you, [open an issue](https://github.com/WasmAgent/wasmagent-js/issues) — friction in this guide is the bug we want to hear about.
