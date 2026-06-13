# @agentkit-js/openai-agents

> Drop agentkit-js sandbox kernels into the **OpenAI Agents JS SDK** as a
> native `tool`. Edge-safe code execution, one capability manifest, runs on
> Cloudflare Workers / Vercel Edge / Node — no E2B sandbox required.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/telleroutlook/agentkit-js/tree/main/examples/openai-agents-quickjs?file=index.mjs)

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

The agentkit kernels live below the OS line — QuickJS-in-WASM, Pyodide-in-WASM,
or Wasmtime — so they run wherever JS runs. This package binds them to the
Agents JS `Tool` shape.

## Install

```bash
npm install @openai/agents @agentkit-js/openai-agents @agentkit-js/kernel-quickjs \
  quickjs-emscripten @jitl/quickjs-wasmfile-release-sync zod
```

## One-shot snippet evaluation

```ts
import { Agent } from "@openai/agents";
import { sandboxedJsAgentTool } from "@agentkit-js/openai-agents";
import { QuickJSKernel } from "@agentkit-js/kernel-quickjs";

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
import { codeModeAgentTool } from "@agentkit-js/openai-agents";
import { ToolRegistry } from "@agentkit-js/core";

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

## Capability manifest

Same `CapabilityManifest` as the other adapters — see
[`docs/guides/code-mode.md`](https://github.com/telleroutlook/agentkit-js/blob/main/docs/guides/code-mode.md#security-policy-face).

## When to pick this over `SandboxAgent`

| Need | OpenAI `SandboxAgent` | `@agentkit-js/openai-agents` |
|---|---|---|
| Cloudflare Workers / Vercel Edge | ❌ requires host process | ✅ WASM kernel runs in-isolate |
| Native binaries / full POSIX | ✅ Docker / hosted | ❌ language-level only |
| Cold start | ~200–800 ms (container) | ~50 ms (WASM) |
| Cost per call | per-second container billing | $0 (in-process) |
| Offline / air-gapped | ❌ | ✅ |

Use both: `SandboxAgent` for "I need bash + git", `codeModeAgentTool` for
"the model wants to do math / parse JSON / chain tool calls".

## See also

- [`@agentkit-js/aisdk`](https://www.npmjs.com/package/@agentkit-js/aisdk) — same kernels for Vercel AI SDK
- [`@agentkit-js/claude-agent-sdk`](https://www.npmjs.com/package/@agentkit-js/claude-agent-sdk) — same kernels for Anthropic Claude Agent SDK
- [`@agentkit-js/mastra-sandbox`](https://www.npmjs.com/package/@agentkit-js/mastra-sandbox) — same kernels as a Mastra sandbox provider
