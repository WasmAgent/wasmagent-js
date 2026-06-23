# WasmAgent Runtime with Mastra

The `@wasmagent/mastra-sandbox` adapter implements Mastra's sandbox-provider
contract — `execute(code, opts) -> { output }` — backed by any WasmAgent kernel.
Drop it into a Mastra `Agent` under the `workspace.sandbox` slot or call it
directly in a Mastra tool's `execute` handler.

## Install

```bash
npm install @wasmagent/mastra-sandbox @wasmagent/kernel-quickjs \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
```

For a full Mastra agent also install `@mastra/core` and a model provider
(e.g. `@ai-sdk/openai`).

## 10-line integration

```js
import { createMastraSandbox } from "@wasmagent/mastra-sandbox";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const sandbox = createMastraSandbox({
  kernel: new QuickJSKernel(),
  capabilities: { cpuMs: 3000 },
});

const r = await sandbox.execute("[1, 2, 3].reduce((a, b) => a + b, 0)");
console.log("sum →", r); // sum → 6
```

## Wire into a Mastra Agent

```js
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { openai } from "@ai-sdk/openai";
import { createMastraSandbox } from "@wasmagent/mastra-sandbox";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
import { z } from "zod";

const sandbox = createMastraSandbox({
  kernel: new QuickJSKernel(),
  capabilities: { cpuMs: 5000, memoryLimitBytes: 64 * 1024 * 1024 },
});

const runJs = createTool({
  id: "runJs",
  description: "Run a JavaScript snippet in a QuickJS sandbox.",
  inputSchema: z.object({ code: z.string() }),
  execute: async ({ context }) => sandbox.execute(context.code),
});

const agent = new Agent({
  name: "calculator",
  instructions: "Use runJs for any computation.",
  model: openai("gpt-4o-mini"),
  tools: { runJs },
});
```

Set `OPENAI_API_KEY` in your environment before running.

## What is enforced

- **Sandboxed JS execution** — code runs inside QuickJS, isolated from the host
  process.
- **CPU timeout** — `cpuMs` caps wall-clock execution. Throws
  `ExecutionTimeoutError` on breach.
- **Memory limit** — `memoryLimitBytes` caps the QuickJS heap (default 64 MB).

## Capability manifest example

```js
createMastraSandbox({
  kernel,
  capabilities: {
    allowedHosts: [],                  // no outbound fetch
    allowedReadPaths: ["/workspace"],  // FS read only inside /workspace
    allowedWritePaths: [],
    cpuMs: 5000,
    memoryLimitBytes: 64 * 1024 * 1024,
    env: { API_KEY: process.env.API_KEY ?? "" },
  },
})
```

## Tier upgrade

```js
import { RemoteSandboxKernel } from "@wasmagent/kernel-remote"; // microVM isolation
const sandbox = createMastraSandbox({ kernel: new RemoteSandboxKernel(), ... });
```

## Run

```bash
node index.mjs
```

## See also

- Full integration guide: [`docs/guides/integrate-mastra.md`](../guides/integrate-mastra.md)
- Kernel decision tree: [`docs/kernels/comparison.md`](../kernels/comparison.md)
- Runnable example: [`examples/recipes/mastra-sandbox/index.mjs`](../../examples/recipes/mastra-sandbox/index.mjs)
