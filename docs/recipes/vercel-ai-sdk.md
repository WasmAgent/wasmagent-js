# WasmAgent Runtime with Vercel AI SDK

The `@wasmagent/aisdk` adapter wires a WasmAgent kernel into the Vercel AI SDK
tool registry with one function call. The kernel runs JS in QuickJS-in-WASM —
edge-safe, no `node:vm`, ~2 MB cold start.

## Install

```bash
npm install @wasmagent/aisdk @wasmagent/kernel-quickjs \
  ai @ai-sdk/openai \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
```

## 10-line integration

```js
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { sandboxedJsTool } from "@wasmagent/aisdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const kernel = new QuickJSKernel();

const result = await generateText({
  model: openai("gpt-4o-mini"),
  tools: {
    runJs: sandboxedJsTool({ kernel, capabilities: { cpuMs: 3000 } }),
  },
  prompt: "Use runJs to compute the 12th Fibonacci number.",
});

console.log(result.text);
```

Set `OPENAI_API_KEY` in your environment before running.

## What is enforced

- **Sandboxed JS execution** — sandboxed code runs inside QuickJS, a separate
  VM. It cannot access your worker's globals, `process.env`, or the filesystem
  unless you explicitly allow it.
- **CPU timeout** — `cpuMs` sets an absolute wall-clock ceiling. The kernel
  throws `ExecutionTimeoutError` when the budget is exceeded.
- **Memory limit** — `memoryLimitBytes` caps the QuickJS heap. Default: 64 MB.

## Capability manifest example

```js
sandboxedJsTool({
  kernel,
  capabilities: {
    allowedHosts: ["api.example.com"], // outbound fetch whitelist
    allowedReadPaths: ["/workspace"],  // FS read whitelist
    allowedWritePaths: [],             // no FS writes
    cpuMs: 5000,                       // 5 s CPU ceiling
    memoryLimitBytes: 64 * 1024 * 1024,
    env: { MY_KEY: process.env.MY_KEY ?? "" }, // explicit env injection
  },
})
```

Fields not listed default to deny. Tighten the manifest first, then loosen one
field at a time as your use case requires.

## Run

```bash
node index.mjs
```

## Tier upgrade

Swap the kernel constructor; the tool wrapper does not change:

```js
import { RemoteSandboxKernel } from "@wasmagent/kernel-remote"; // E2B / CF Sandbox
const kernel = new RemoteSandboxKernel();
```

## Export trace / rollout

Every kernel run emits events to the `EventLog`. To capture a rollout for
RLAIF or audit:

```js
import { EventLog } from "@wasmagent/core";

const log = new EventLog();
const kernel = new QuickJSKernel({ eventLog: log });
// … run the agent …
const entries = log.export(); // JSONL-ready array of timestamped events
```

## See also

- Full integration guide: [`docs/guides/integrate-vercel-ai-sdk.md`](../guides/integrate-vercel-ai-sdk.md)
- Kernel decision tree: [`docs/kernels/comparison.md`](../kernels/comparison.md)
- Runnable example: [`examples/recipes/vercel-ai-sdk/index.mjs`](../../examples/recipes/vercel-ai-sdk/index.mjs)
