# @agentkit-js/mastra-sandbox

> A **Mastra** sandbox provider backed by agentkit-js kernels. WASM
> isolation with no external infrastructure — drop-in alternative to
> Blaxel / E2B / Daytona providers.

## Why this exists

Mastra (mastra.ai) opened its sandbox-provider contract in 2026-02 so users
can plug in a custom code-execution backend. The defaults are
service-backed (Blaxel-hosted, E2B-hosted) — fine if you're already paying
for one of those, awkward when you're not.

This package ships a Mastra sandbox provider that delegates to any agentkit
kernel. WASM kernels (`QuickJSKernel`, `PyodideKernel`, `WasmtimeKernel`) run
in-process, on every Workers edge, with sub-100ms cold start — no API key,
no account, no billing.

## Compared to Blaxel / E2B providers

|              | agentkit kernel | Blaxel / E2B sandbox |
| ------------ | --------------- | -------------------- |
| Cold start   | ~50 ms          | 200–800 ms           |
| Cost / call  | $0 (in-process) | per-second billing   |
| Isolation    | Language-level  | Process / firecracker |
| Workers safe | ✅               | ❌ (server required)  |
| Snapshots    | ✅ (Wasmtime)    | ✅ (image-level)      |

Use a WASM kernel when "model wrote a snippet to do math / parse JSON / try
something" is the workload. Use Blaxel/E2B when you need full POSIX, native
binaries, or untrusted multi-tenant isolation across mutually-distrusting
customers.

## Install

```bash
npm install @agentkit-js/mastra-sandbox @agentkit-js/kernel-quickjs \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
```

## Use it

```ts
import { Agent } from "@mastra/core";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";
import { agentkitMastraSandbox } from "@agentkit-js/mastra-sandbox";

const sandbox = agentkitMastraSandbox({
  kernel: new QuickJSKernel({ timeoutMs: 5_000 }),
  capabilities: {
    allowedHosts: ["api.example.com"],
    cpuMs: 5_000,
    memoryLimitBytes: 64 * 1024 * 1024,
    env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "" },
  },
});

const agent = new Agent({
  name: "my-agent",
  // …whichever Mastra config wires sandboxes (e.g. tools.execute_code,
  // workspace runtime, etc.). The provider implements the
  // execute(code, options) -> { output, stderr, exitCode } contract Mastra
  // calls into; consult Mastra's docs for the latest wiring path.
  tools: { sandbox },
});
```

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

The provider also accepts per-call `timeout` and `env` in
`execute(code, options)` — these tighten / merge into the provider-level
manifest at call time.

## See also

- [`docs/guides/code-mode.md`](https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/code-mode.md)
  — the same kernels behind a standalone MCP server.
- [`@agentkit-js/aisdk`](https://www.npmjs.com/package/@agentkit-js/aisdk)
  — the same kernels as Vercel AI SDK tools.
