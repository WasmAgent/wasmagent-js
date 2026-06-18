# Use agentkit-js kernels with Vercel AI SDK

The agentkit-js code-execution kernels (`@wasmagent/kernel-quickjs`, `kernel-pyodide`, `kernel-wasmtime`, `kernel-remote`) **do not require the rest of agentkit-js**. You can drop them into any agent framework that lets you register a custom tool — including Vercel AI SDK.

This page shows how to expose `QuickJSKernel` as a Vercel AI SDK tool, giving you edge-safe sandboxed code execution that the AI SDK does not ship today.

## Why bother

Vercel AI SDK 6 has world-class React DX, streaming UI primitives, and a default place in Next.js templates. What it does not have is a way to run model-generated code inside a real sandbox on the edge. `node:vm` is forbidden on Cloudflare Workers and Vercel Edge; OS-level sandboxes need a server.

`@wasmagent/kernel-quickjs` runs JavaScript inside QuickJS-in-WASM — language-level isolation, no `node:vm`, ~2 MB cold start. Perfect fill for that gap.

## Install

```bash
npm install ai @ai-sdk/openai @wasmagent/kernel-quickjs quickjs-emscripten @jitl/quickjs-wasmfile-release-sync zod
```

## Wire the kernel as a tool

```ts
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { z } from "zod";

const kernel = new QuickJSKernel();

const runJs = tool({
  description:
    "Run a JavaScript expression inside a sandbox. Returns the value of the last expression.",
  parameters: z.object({
    code: z.string().describe("JavaScript code; the value of the final expression is returned."),
  }),
  execute: async ({ code }) => {
    const result = await kernel.run(code);
    return { output: result.output, logs: result.logs };
  },
});

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools: { runJs },
  prompt: "Compute the 12th Fibonacci number using the runJs tool.",
});

console.log(text);
```

That is the whole integration. The kernel runs anywhere Vercel AI SDK runs — Workers, Edge, Node — because QuickJS is just WASM.

## What you get for free

- **No `node:vm` requirement** — works on Cloudflare Workers, Vercel Edge, Deno Deploy.
- **Tight isolation** — QuickJS is a separate VM; sandboxed code cannot touch your worker's globals or environment.
- **Capability-controlled** — pass a [`CapabilityManifest`](https://github.com/WasmAgent/wasmagent-js/blob/main/packages/core/src/executor/types.ts) as the second argument to `kernel.run(code, capabilities)` to grant or revoke specific host imports.
- **Drop-in tier upgrade** — swap to `@wasmagent/kernel-pyodide` for Python or `@wasmagent/kernel-remote` for E2B microVMs without changing the tool wrapper.

## See also

- [Kernel decision tree](/kernels/comparison) — pick the right tier
- [`@wasmagent/kernel-quickjs` README](https://github.com/WasmAgent/wasmagent-js/tree/main/packages/kernel-quickjs) — package-level docs
- [Use kernels with Mastra](./integrate-mastra) — the same idea for the Mastra framework
