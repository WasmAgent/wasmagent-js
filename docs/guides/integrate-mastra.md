# Use agentkit-js kernels with Mastra

The agentkit-js code-execution kernels (`@wasmagent/kernel-quickjs`, `kernel-pyodide`, `kernel-wasmtime`, `kernel-remote`) work standalone. You can register them as tools in [Mastra](https://mastra.ai) — or any other agent framework that takes a tool definition — without pulling in the rest of agentkit-js.

This page shows how to expose `QuickJSKernel` as a Mastra tool.

## Why bother

Mastra ships an excellent batteries-included DX — four-layer memory, suspend/resume, evals, MCP support. What it does not ship is sandboxed code execution as a first-class feature. The agentkit-js kernel packages plug that gap.

## Install

```bash
npm install @mastra/core @ai-sdk/openai @wasmagent/kernel-quickjs quickjs-emscripten @jitl/quickjs-wasmfile-release-sync zod
```

## Wire the kernel as a Mastra tool

```ts
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { openai } from "@ai-sdk/openai";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { z } from "zod";

const kernel = new QuickJSKernel();

const runJs = createTool({
  id: "runJs",
  description:
    "Run a JavaScript expression in a QuickJS WASM sandbox. Returns the value of the last expression.",
  inputSchema: z.object({
    code: z.string(),
  }),
  execute: async ({ context }) => {
    const result = await kernel.run(context.code);
    return { output: result.output, logs: result.logs };
  },
});

const agent = new Agent({
  name: "calculator",
  instructions: "Use the runJs tool to compute exact answers.",
  model: openai("gpt-4o"),
  tools: { runJs },
});

const mastra = new Mastra({ agents: { agent } });

const result = await mastra.getAgent("agent").generate(
  "Compute the 12th Fibonacci number.",
);
console.log(result.text);
```

## Tier swaps without touching the agent

The kernel interface is identical across tiers:

```ts
import { PyodideKernel } from "@wasmagent/kernel-pyodide";    // real CPython
import { WasmtimeKernel } from "@wasmagent/kernel-wasmtime";  // Javy + WASI
import { RemoteSandboxKernel } from "@wasmagent/kernel-remote"; // E2B / CF Sandbox
```

Replace the constructor in the tool definition; the rest of the Mastra agent does not change.

## See also

- [Kernel decision tree](/kernels/comparison) — pick the right tier
- [`@wasmagent/kernel-quickjs` README](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-quickjs)
- [Use kernels with Vercel AI SDK](./integrate-vercel-ai-sdk) — the same idea for Vercel AI SDK
