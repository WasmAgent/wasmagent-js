# Getting started (5 minutes)

This walks you from zero to your first running agent. Pick the model adapter that matches the API key you have on hand.

## 1. Install

```bash
npm install @agentkit-js/core @anthropic-ai/sdk
# or with Bun / pnpm
bun add @agentkit-js/core @anthropic-ai/sdk
```

> Using a Chinese model? Swap the install for one of the dedicated adapters:
> `@agentkit-js/model-doubao`, `@agentkit-js/model-deepseek`, `@agentkit-js/model-moonshot`, `@agentkit-js/model-qwen`, `@agentkit-js/model-zhipu`, `@agentkit-js/model-minimax`.

## 2. Set your key

```bash
export ANTHROPIC_API_KEY=sk-ant-...   # or DOUBAO_API_KEY, DEEPSEEK_API_KEY, etc.
```

## 3. Write the agent

```ts
// hello-agent.ts
import { CodeAgent, AnthropicModel, AnthropicModels } from "@agentkit-js/core";

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
| Cloudflare Workers / Vercel Edge / Deno Deploy | [`@agentkit-js/kernel-quickjs`](/kernels/comparison) |
| Need real Python | [`@agentkit-js/kernel-pyodide`](/kernels/comparison) |
| Strongest sandboxing without a microVM | [`@agentkit-js/kernel-wasmtime`](/kernels/comparison) |
| Real shell / npm install / compilation | [`@agentkit-js/kernel-remote`](/kernels/comparison) (E2B / CF Sandbox) |

```ts
import { CodeAgent } from "@agentkit-js/core";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

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

If anything blocks you, [open an issue](https://github.com/telleroutlook/agentkit-js/issues) — friction in this guide is the bug we want to hear about.
